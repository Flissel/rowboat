// Modified for VibeMind (Flissel/rowboat vibemind): new module — the central
// guard for channel-origin turns (Telegram / WhatsApp bridge, "Teil E").
//
// Operator rule: a turn started from a mobile channel gets NO tool with
// external effect. It may read the workspace (knowledge, todo, notes) and
// write notes / to-dos, nothing else. The bridge marks such turns with
// turn_created.config.channel; the runtime consults this guard
//   1. at createTurn, to drop every tool the run may not use from the
//      persisted snapshot (and from loadSkill tool additions), so the model
//      is never offered them, and
//   2. before the permission checker for every tool call, so a call that
//      slips through anyway (a stale/inherited snapshot, a hallucinated
//      name) is refused with a clear message instead of executing.
// The guard is an ALLOWLIST: a builtin not named below is unavailable in
// channel runs — new catalog entries stay locked out until reviewed here.
// Desktop (non-channel) turns never reach this module.

import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { ToolDescriptor } from "@x/shared/dist/turns.js";
import { WorkDir } from "../../config/config.js";
import { isPathInside, resolveFilePathForPermission } from "../../filesystem/files.js";

export interface ChannelRunPolicy {
    // MCP servers whose tools are treated as read-only: auto-approved in
    // channel runs without the LLM permission classifier. Every other MCP
    // server is refused.
    readOnlyMcpServers: string[];
}

export interface ChannelToolCall {
    toolId: string;
    toolName: string;
    input: unknown;
}

export type ChannelGuardDecision =
    // Refused outright: the runtime records an error result, nothing runs.
    | { kind: "deny"; reason: string }
    // Approved by the guard itself: no checker, no classifier.
    | { kind: "allow" }
    // Allowed by the guard; the regular permission checker still applies.
    | { kind: "default" };

export interface IChannelRunGuard {
    offers(descriptor: z.infer<typeof ToolDescriptor>, policy: ChannelRunPolicy): boolean;
    check(call: ChannelToolCall, policy: ChannelRunPolicy): Promise<ChannelGuardDecision>;
}

// Kept in sync with real-agent-resolver's ASK_HUMAN_TOOL (not imported: that
// module pulls the whole agent assembly into the runtime's import graph).
const ASK_HUMAN = "ask-human";

// Builtins a channel run may use. Everything else — executeCommand,
// addMcpServer, listMcpServers (prints server env/headers), code agents,
// background tasks, browser, composio, spawn-agent (its child turn would
// not carry the channel flag), image/voice/deck/spreadsheet writers, ... —
// is not offered and refused if called.
const CHANNEL_BUILTINS = new Set<string>([
    "loadSkill",
    ASK_HUMAN,
    "file-getRoot",
    "file-exists",
    "file-stat",
    "file-list",
    "file-readText",
    "file-writeText",
    "file-editText",
    "file-mkdir",
    "file-rename",
    "file-copy",
    "file-glob",
    "file-grep",
    "parseFile",
    "LLMParse",
    "web-search",
    "fetch-url",
    "listMcpTools",
    "executeMcpTool",
    "save-to-memory",
    "list-models",
    "todo-add",
    "todo-propose",
    "home-status",
    "whiteboard-read",
    "list_scheduled",
]);

// Workspace entries a channel run may never touch (read, list, search or
// write): credentials and app-internal state.
const SENSITIVE_ENTRIES = [
    "config",
    "server-key",
    "cipher-key",
    "embed.json",
    ".electron-data",
    // telegram-state.json and the WhatsApp linked-device credentials.
    "channels",
];

// The only workspace subtree a channel run may modify (notes). To-dos are
// written through todo-add / todo-propose, never with file tools.
const WRITE_ROOTS = ["knowledge"];

// Same pattern the todo runner uses to decide that an item is delegated
// (todo/fileops.ts ROWBOAT_MENTION_RE): such an item starts a background
// run with the full desktop tool set.
const ROWBOAT_MENTION_RE = /(^|\s)@rowboat\b/i;

function isSensitiveSegment(segment: string): boolean {
    const s = segment.toLowerCase();
    return s.endsWith(".env") || s.startsWith(".env") || s.includes("token");
}

type FileOp = "read" | "list" | "search" | "write";

interface FileTarget {
    op: FileOp;
    path: string;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fileTargets(toolName: string, args: Record<string, unknown>): FileTarget[] | null {
    switch (toolName) {
        case "file-exists":
        case "file-stat":
        case "file-readText":
        case "parseFile":
        case "LLMParse":
            return [{ op: "read", path: str(args.path) ?? "" }];
        case "file-list":
            return [{
                op: args.recursive === true ? "search" : "list",
                path: str(args.path) ?? ".",
            }];
        case "file-glob":
            return [{ op: "search", path: str(args.cwd) ?? "." }];
        case "file-grep":
            return [{ op: "search", path: str(args.searchPath) ?? "." }];
        case "file-writeText":
        case "file-editText":
        case "file-mkdir":
            return [{ op: "write", path: str(args.path) ?? "" }];
        case "file-rename":
            return [
                { op: "write", path: str(args.from) ?? "" },
                { op: "write", path: str(args.to) ?? "" },
            ];
        case "file-copy":
            return [
                { op: "read", path: str(args.from) ?? "" },
                { op: "write", path: str(args.to) ?? "" },
            ];
        default:
            return null;
    }
}

// A glob pattern that is absolute or climbs with ".." escapes its cwd.
function escapesCwd(pattern: string | undefined): boolean {
    if (!pattern) return false;
    if (path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.startsWith("~")) {
        return true;
    }
    return pattern.split(/[\\/]+/).some((segment) => segment === "..");
}

function asRecord(input: unknown): Record<string, unknown> {
    return input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
}

export interface ChannelRunGuardDeps {
    // Canonical (realpath'd) workspace root.
    workspaceRoot?: () => Promise<string>;
    // Canonical absolute path for a tool-supplied path (relative paths
    // resolve against the workspace, symlinks are followed).
    resolvePath?: (inputPath: string) => Promise<string>;
}

async function defaultWorkspaceRoot(): Promise<string> {
    try {
        return await fs.realpath(WorkDir);
    } catch {
        return path.resolve(WorkDir);
    }
}

async function defaultResolvePath(inputPath: string): Promise<string> {
    return (await resolveFilePathForPermission(inputPath)).canonicalPath;
}

export class ChannelRunGuard implements IChannelRunGuard {
    private readonly workspaceRoot: () => Promise<string>;
    private readonly resolvePath: (inputPath: string) => Promise<string>;

    constructor(deps: ChannelRunGuardDeps = {}) {
        this.workspaceRoot = deps.workspaceRoot ?? defaultWorkspaceRoot;
        this.resolvePath = deps.resolvePath ?? defaultResolvePath;
    }

    offers(descriptor: z.infer<typeof ToolDescriptor>, policy: ChannelRunPolicy): boolean {
        const { toolId } = descriptor;
        if (toolId.startsWith("builtin:")) {
            return CHANNEL_BUILTINS.has(toolId.slice("builtin:".length));
        }
        if (toolId.startsWith("mcp:")) {
            return isReadOnlyServer(mcpServerOf(toolId), policy);
        }
        return false;
    }

    async check(call: ChannelToolCall, policy: ChannelRunPolicy): Promise<ChannelGuardDecision> {
        const { toolId } = call;
        if (toolId.startsWith("mcp:")) {
            const server = mcpServerOf(toolId);
            return isReadOnlyServer(server, policy)
                ? { kind: "allow" }
                : deny(`MCP server "${server ?? "?"}" is not on the read-only list for channel runs.`);
        }
        if (!toolId.startsWith("builtin:")) {
            return deny(`Tool "${call.toolName}" is not available in channel runs.`);
        }
        const name = toolId.slice("builtin:".length);
        if (!CHANNEL_BUILTINS.has(name)) {
            return deny(
                `Tool "${name}" is not available in runs started from a mobile channel (no external effects). Use the desktop app for this.`,
            );
        }
        const args = asRecord(call.input);
        switch (name) {
            case "fetch-url": {
                const method = (str(args.method) ?? "GET").toUpperCase();
                return method === "GET" || method === "HEAD"
                    ? { kind: "default" }
                    : deny(`fetch-url with method ${method} is not allowed in channel runs — only GET and HEAD.`);
            }
            case "executeMcpTool":
            case "listMcpTools": {
                const server = str(args.serverName);
                if (!isReadOnlyServer(server, policy)) {
                    return deny(`MCP server "${server ?? "?"}" is not on the read-only list for channel runs.`);
                }
                // executeMcpTool would otherwise go to the classifier; the
                // allowlisted servers are approved without it.
                return { kind: "allow" };
            }
            case "todo-add": {
                const items = Array.isArray(args.items) ? args.items : [];
                const delegated = items.some((item) => {
                    const text = asRecord(item).text;
                    return typeof text === "string" && ROWBOAT_MENTION_RE.test(text);
                });
                return delegated
                    ? deny("To-dos with @rowboat start a background run and cannot be added from a mobile channel. Add the item without @rowboat.")
                    : { kind: "default" };
            }
            default:
                break;
        }
        const targets = fileTargets(name, args);
        if (!targets) {
            return { kind: "default" };
        }
        if (name === "file-glob" && escapesCwd(str(args.pattern))) {
            return deny("Glob patterns that are absolute or contain \"..\" are not allowed in channel runs.");
        }
        if (name === "file-grep" && escapesCwd(str(args.fileGlob))) {
            return deny("File globs that are absolute or contain \"..\" are not allowed in channel runs.");
        }
        return this.checkFileTargets(targets);
    }

    private async checkFileTargets(targets: FileTarget[]): Promise<ChannelGuardDecision> {
        const root = await this.workspaceRoot();
        for (const target of targets) {
            if (!target.path) {
                return deny("A path is required.");
            }
            const resolved = await this.resolvePath(target.path);
            if (!isPathInside(root, resolved)) {
                return deny(`Path "${target.path}" is outside the workspace; channel runs may only use workspace files.`);
            }
            const rel = path.relative(root, resolved);
            const segments = rel === "" ? [] : rel.split(path.sep);
            const sensitive = SENSITIVE_ENTRIES.map((entry) => path.join(root, entry));
            if (
                sensitive.some((entry) => isPathInside(entry, resolved)) ||
                segments.some(isSensitiveSegment)
            ) {
                return deny(`Path "${target.path}" is protected (credentials / app config) and cannot be used from a mobile channel.`);
            }
            if (
                target.op === "search" &&
                sensitive.some((entry) => isPathInside(resolved, entry))
            ) {
                return deny(`Searching "${target.path}" would include protected files; search a subfolder such as knowledge/ instead.`);
            }
            if (
                target.op === "write" &&
                !WRITE_ROOTS.some((dir) => isPathInside(path.join(root, dir), resolved))
            ) {
                return deny(`Channel runs may only write notes under knowledge/ (to-dos via todo-add); "${target.path}" is outside.`);
            }
        }
        return { kind: "default" };
    }
}

function deny(reason: string): ChannelGuardDecision {
    return { kind: "deny", reason };
}

function mcpServerOf(toolId: string): string | undefined {
    const rest = toolId.slice("mcp:".length);
    const separator = rest.indexOf(":");
    return separator > 0 ? rest.slice(0, separator) : undefined;
}

function isReadOnlyServer(server: string | undefined, policy: ChannelRunPolicy): boolean {
    return !!server && policy.readOnlyMcpServers.includes(server);
}
