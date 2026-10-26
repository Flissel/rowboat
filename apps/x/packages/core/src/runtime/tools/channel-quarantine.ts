// Modified for VibeMind (Flissel/rowboat vibemind): new module (Teil E, fix
// round 4). Execution-time enforcement of the channel quarantine
// knowledge/Kanal/ (see knowledge/quarantine.ts):
//
//   channel  — a run started from a mobile channel: its file writes must stay
//              inside knowledge/Kanal/ (both sides of a rename, the target of
//              a copy). Reads are untouched (the channel guard rules apply).
//   blocked  — every other run that is not a desktop user chat (headless
//              agents, todo / code sessions, scheduled agents, legacy engine):
//              no builtin may touch knowledge/Kanal/ or the turn transcripts
//              in storage/turns/ (channel turns live there too); grep / glob /
//              list results drop such entries.
//   null     — a desktop user chat (or a child it spawned): unrestricted.
//
// The mode is derived from ToolContext: `channel` marks channel runs, and the
// runtime sets `autorunContentForbidden` exactly for runs that are not a
// desktop user chat.

import fs from "node:fs/promises";
import path from "node:path";
import { WorkDir } from "../../config/config.js";
import { isPathInside, resolveFilePathForPermission } from "../../filesystem/files.js";
import { isQuarantinedUnder, QUARANTINE_FOLDER, QUARANTINE_REL } from "../../knowledge/quarantine.js";

export type QuarantineMode = "channel" | "blocked";

export function quarantineMode(ctx?: {
    channel?: unknown;
    autorunContentForbidden?: boolean;
}): QuarantineMode | null {
    if (ctx?.channel) return "channel";
    if (ctx?.autorunContentForbidden) return "blocked";
    return null;
}

// Blocked runs fail closed: EVERY string anywhere in a builtin's input
// (top-level, nested objects, arrays — path, from, to, cwd, searchPath,
// outputPath, filePath, files[], paths[], attachments, ...) is resolved as a
// path; one that lands in the quarantine or the transcripts refuses the call.
// Multi-line or very long strings (note bodies, prompts) cannot be a path and
// are skipped. A guard test enumerates every builtin schema to keep it so.
const MAX_PATH_LENGTH = 4096;
const MAX_DEPTH = 8;

function collectStrings(value: unknown, at: string, out: Array<{ at: string; value: string }>, depth = 0): void {
    if (depth > MAX_DEPTH) return;
    if (typeof value === "string") {
        if (value.length > 0 && value.length <= MAX_PATH_LENGTH && !/[\r\n\0]/.test(value)) {
            out.push({ at, value });
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectStrings(item, `${at}[${index}]`, out, depth + 1));
        return;
    }
    if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            collectStrings(item, at ? `${at}.${key}` : key, out, depth + 1);
        }
    }
}

// Channel runs: the arguments a write builtin modifies.
const CHANNEL_WRITE_ARGS: Record<string, string[]> = {
    "file-writeText": ["path"],
    "file-editText": ["path"],
    "file-mkdir": ["path"],
    "file-remove": ["path"],
    "file-rename": ["from", "to"],
    "file-copy": ["to"],
};

// Shell commands naming the quarantine or the transcripts. A heuristic only:
// globs / find / grep -r over knowledge/ can still reach the folder (see the
// round-4 residuals); the file builtins above are the real boundary.
const SHELL_QUARANTINE_RE = new RegExp(`${QUARANTINE_FOLDER}|storage[\\\\/]+turns`, "i");

export interface QuarantineDeps {
    workspaceRoot?: () => Promise<string>;
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

export interface QuarantineChecker {
    // Error text when the call breaks the quarantine rule for `mode`, else null.
    toolError(toolName: string, args: Record<string, unknown>, mode: QuarantineMode): Promise<string | null>;
    // For "blocked" runs: true when a grep / glob / list entry may be shown.
    readFilter(): (absPath: string) => Promise<boolean>;
}

export function createQuarantineChecker(deps: QuarantineDeps = {}): QuarantineChecker {
    const workspaceRoot = deps.workspaceRoot ?? defaultWorkspaceRoot;
    const resolvePath = deps.resolvePath ?? defaultResolvePath;

    const quarantined = (root: string, abs: string) =>
        isQuarantinedUnder(path.join(root, "knowledge"), abs);
    const transcript = (root: string, abs: string) =>
        isPathInside(path.join(root, "storage", "turns"), abs);

    async function blockedError(toolName: string, args: Record<string, unknown>): Promise<string | null> {
        if (toolName === "executeCommand" && typeof args.command === "string" && SHELL_QUARANTINE_RE.test(args.command)) {
            return `Commands touching ${QUARANTINE_REL} or storage/turns/ are not allowed in background runs (channel quarantine).`;
        }
        const root = await workspaceRoot();
        const strings: Array<{ at: string; value: string }> = [];
        collectStrings(args, "", strings);
        const seen = new Set<string>();
        for (const { at, value } of strings) {
            if (seen.has(value)) continue;
            seen.add(value);
            let resolved: string;
            try {
                resolved = await resolvePath(value);
            } catch {
                continue; // not resolvable as a path
            }
            if (quarantined(root, resolved)) {
                return `"${value}" (${at}) is in the channel quarantine ${QUARANTINE_REL}; only the desktop chat may open it.`;
            }
            if (transcript(root, resolved)) {
                return `"${value}" (${at}) is in storage/turns/ (chat transcripts, including channel runs); background runs may not read transcripts.`;
            }
        }
        return null;
    }

    async function channelError(toolName: string, args: Record<string, unknown>): Promise<string | null> {
        const keys = CHANNEL_WRITE_ARGS[toolName];
        if (!keys) return null;
        const root = await workspaceRoot();
        for (const key of keys) {
            const value = args[key];
            if (typeof value !== "string" || value.length === 0) {
                return "A path is required.";
            }
            if (!quarantined(root, await resolvePath(value))) {
                return `Channel runs may only write under ${QUARANTINE_REL}; "${value}" is outside.`;
            }
        }
        return null;
    }

    return {
        toolError(toolName, args, mode) {
            return mode === "channel" ? channelError(toolName, args) : blockedError(toolName, args);
        },
        readFilter() {
            return async (absPath) => {
                try {
                    const root = await workspaceRoot();
                    const resolved = await resolvePath(absPath);
                    return !quarantined(root, resolved) && !transcript(root, resolved);
                } catch {
                    return false;
                }
            };
        },
    };
}

let defaultChecker: QuarantineChecker | null = null;

export function quarantineChecker(): QuarantineChecker {
    defaultChecker ??= createQuarantineChecker();
    return defaultChecker;
}
