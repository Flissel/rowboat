// Modified for VibeMind (Flissel/rowboat vibemind): tests for the channel-run guard (Teil E).
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ToolDescriptor } from "@x/shared/dist/turns.js";
import { ChannelRunGuard, hasLiveFrontmatter, type ChannelRunPolicy } from "./channel-run-guard.js";

const ROOT = path.resolve("/rowboat-ws");
const policy: ChannelRunPolicy = {
    readOnlyMcpTools: [
        "wissen:wissen_suchen",
        "vibemind-werkzeuge:github_repos",
        "exa:web_search_exa",
    ],
};

const LIVE_NOTE = "---\nlive:\n  objective: watch the inbox\n---\n# Inbox\n";
const PLAIN_NOTE = "---\ntitle: a\n---\n# A\nbody\n";

function makeGuard(files: Record<string, string> = {}) {
    const abs = (p: string) => path.resolve(ROOT, p);
    const contents = new Map(Object.entries(files).map(([p, c]) => [abs(p), c]));
    return new ChannelRunGuard({
        workspaceRoot: async () => ROOT,
        resolvePath: async (p) => path.resolve(ROOT, p),
        readText: async (p) => contents.get(p) ?? null,
    });
}

const guard = makeGuard();

function builtin(name: string, input: unknown = {}) {
    return { toolId: `builtin:${name}`, toolName: name, input };
}

function descriptor(toolId: string): z.infer<typeof ToolDescriptor> {
    return {
        toolId,
        name: toolId.split(":").pop() ?? toolId,
        description: "",
        inputSchema: {},
        execution: "sync",
        requiresHuman: false,
    };
}

describe("ChannelRunGuard.offers", () => {
    it("drops process-starting, config-changing and prompt-poisoning builtins", () => {
        for (const name of [
            "executeCommand",
            "addMcpServer",
            "listMcpServers",
            "code_agent_run",
            "launch-code-task",
            "create-background-task",
            "run-background-task-agent",
            "browser-control",
            "composio-execute-tool",
            "spawn-agent",
            "file-remove",
            "save-to-memory",
        ]) {
            expect(guard.offers(descriptor(`builtin:${name}`), policy), name).toBe(false);
        }
    });

    it("keeps reading/notes/todo builtins and ask-human", () => {
        for (const name of ["file-readText", "file-writeText", "fetch-url", "todo-add", "ask-human", "executeMcpTool"]) {
            expect(guard.offers(descriptor(`builtin:${name}`), policy), name).toBe(true);
        }
    });

    it("offers only allowlisted MCP server:tool attachments", () => {
        expect(guard.offers(descriptor("mcp:wissen:wissen_suchen"), policy)).toBe(true);
        expect(guard.offers(descriptor("mcp:wissen:wissen_loeschen"), policy)).toBe(false);
        expect(guard.offers(descriptor("mcp:github:create_issue"), policy)).toBe(false);
    });
});

describe("ChannelRunGuard.check", () => {
    it("refuses fetch-url POST and custom headers, allows GET and HEAD", async () => {
        await expect(guard.check(builtin("fetch-url", { url: "https://x", method: "POST", body: "a" }), policy))
            .resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("POST") });
        await expect(guard.check(builtin("fetch-url", { url: "https://x", method: "put" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("fetch-url", { url: "https://x", headers: { Authorization: "x" } }), policy))
            .resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("headers") });
        await expect(guard.check(builtin("fetch-url", { url: "https://x" }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(guard.check(builtin("fetch-url", { url: "https://x", method: "HEAD", headers: {} }), policy))
            .resolves.toEqual({ kind: "default" });
    });

    it("refuses executeCommand, addMcpServer and save-to-memory", async () => {
        for (const call of [
            builtin("executeCommand", { command: "ls" }),
            builtin("addMcpServer", { serverName: "x", config: {} }),
            builtin("save-to-memory", { note: "x" }),
        ]) {
            await expect(guard.check(call, policy), call.toolName).resolves.toMatchObject({ kind: "deny" });
        }
    });

    it("auto-approves allowlisted MCP tools only (server:tool)", async () => {
        await expect(guard.check({ toolId: "mcp:exa:web_search_exa", toolName: "web_search_exa", input: {} }, policy))
            .resolves.toEqual({ kind: "allow" });
        await expect(guard.check({ toolId: "mcp:exa:crawl_everything", toolName: "crawl_everything", input: {} }, policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check({ toolId: "mcp:github:create_issue", toolName: "create_issue", input: {} }, policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("executeMcpTool", { serverName: "wissen", toolName: "wissen_suchen" }), policy))
            .resolves.toEqual({ kind: "allow" });
        await expect(guard.check(builtin("executeMcpTool", { serverName: "wissen", toolName: "wissen_loeschen" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("executeMcpTool", { serverName: "github", toolName: "q" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("listMcpTools", { serverName: "vibemind-werkzeuge" }), policy))
            .resolves.toEqual({ kind: "allow" });
        await expect(guard.check(builtin("listMcpTools", { serverName: "github" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
    });

    it("an empty allowlist refuses every MCP tool", async () => {
        const empty = { readOnlyMcpTools: [] };
        await expect(guard.check(builtin("executeMcpTool", { serverName: "wissen", toolName: "wissen_suchen" }), empty))
            .resolves.toMatchObject({ kind: "deny" });
        expect(guard.offers(descriptor("mcp:wissen:wissen_suchen"), empty)).toBe(false);
    });

    it("refuses reads of config, keys, channel state, trash and token/env files", async () => {
        for (const p of [
            "config/channels.json",
            "config/models.json",
            "config",
            "server-key",
            "cipher-key",
            "embed.json",
            ".electron-data/Cookies",
            "channels/telegram-state.json",
            ".trash/old-secret.md",
            "knowledge/.env",
            "knowledge/prod.env",
            "knowledge/api-token.txt",
            "knowledge/../config/oauth.json",
            path.join(ROOT, "config", "channels.json"),
        ]) {
            await expect(guard.check(builtin("file-readText", { path: p }), policy), p)
                .resolves.toMatchObject({ kind: "deny" });
        }
    });

    it("refuses paths outside the workspace", async () => {
        await expect(guard.check(builtin("file-readText", { path: path.resolve("/etc/passwd") }), policy))
            .resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("outside") });
    });

    it("allows reading knowledge and todo", async () => {
        await expect(guard.check(builtin("file-readText", { path: "knowledge/Notes/a.md" }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(guard.check(builtin("file-readText", { path: "todo.md" }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(guard.check(builtin("file-list", { path: "." }), policy))
            .resolves.toEqual({ kind: "default" });
    });

    it("refuses searches whose root contains protected entries", async () => {
        await expect(guard.check(builtin("file-grep", { pattern: "token" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-glob", { pattern: "**/*" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-list", { path: ".", recursive: true }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-list", { path: "config" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-grep", { pattern: "x", searchPath: "knowledge" }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(guard.check(builtin("file-glob", { pattern: "**/*.md", cwd: "knowledge" }), policy))
            .resolves.toEqual({ kind: "default" });
    });

    it("C1: refuses glob patterns that can leave their cwd (braces, .., absolute, ~, drive)", async () => {
        const unsafe = [
            "{..,.}/config/**",
            "{/etc,x}/passwd",
            "../config/*",
            "a/../../config/*",
            "/etc/*",
            "\\\\server\\share\\*",
            "~/x",
            "C:/Windows/*",
            "c:x",
            "{a,b}.md",
        ];
        for (const fileGlob of unsafe) {
            await expect(guard.check(builtin("file-grep", { pattern: "x", searchPath: "knowledge", fileGlob }), policy), fileGlob)
                .resolves.toMatchObject({ kind: "deny" });
            await expect(guard.check(builtin("file-glob", { pattern: fileGlob, cwd: "knowledge" }), policy), fileGlob)
                .resolves.toMatchObject({ kind: "deny" });
        }
    });

    it("readFilter (second layer) passes only readable workspace files", async () => {
        const allowed = guard.readFilter();
        expect(await allowed(path.join(ROOT, "knowledge", "a.md"))).toBe(true);
        expect(await allowed(path.join(ROOT, "config", "channels.json"))).toBe(false);
        expect(await allowed(path.join(ROOT, "knowledge", "x.env"))).toBe(false);
        expect(await allowed(path.join(ROOT, ".trash", "a.md"))).toBe(false);
        expect(await allowed(path.resolve("/etc/passwd"))).toBe(false);
    });

    it("allows writes only under knowledge/, outside Agent Notes and dot segments", async () => {
        await expect(guard.check(builtin("file-writeText", { path: "knowledge/Notes/n.md", data: "x" }), policy))
            .resolves.toEqual({ kind: "default" });
        for (const p of [
            "config/mcp.json",
            "bg-tasks/x.md",
            "knowledge/Agent Notes/user.md",
            "knowledge/agent notes/user.md",
            "knowledge/.git/config",
            "knowledge/.obsidian/workspace.json",
            "knowledge/Notes/.hidden.md",
        ]) {
            await expect(guard.check(builtin("file-writeText", { path: p, data: "x" }), policy), p)
                .resolves.toMatchObject({ kind: "deny" });
        }
        await expect(guard.check(builtin("file-mkdir", { path: "knowledge/.git/hooks" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-copy", { from: "config/channels.json", to: "knowledge/c.json" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-rename", { from: "knowledge/a.md", to: "agents/a.md" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
    });

    it("C2: refuses creating or changing live notes", async () => {
        const g = makeGuard({
            "knowledge/live.md": LIVE_NOTE,
            "knowledge/plain.md": PLAIN_NOTE,
        });
        // New content with a live: key.
        await expect(g.check(builtin("file-writeText", { path: "knowledge/new.md", data: LIVE_NOTE }), policy))
            .resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("live") });
        await expect(g.check(builtin("file-writeText", { path: "knowledge/new.md", data: "---\n\"live\": {objective: x}\n---\nb\n" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        // Overwriting / editing an existing live note.
        await expect(g.check(builtin("file-writeText", { path: "knowledge/live.md", data: "# plain\n" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(g.check(builtin("file-editText", { path: "knowledge/live.md", oldString: "# Inbox", newString: "# X" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        // An edit that adds live: to a plain note.
        await expect(g.check(builtin("file-editText", { path: "knowledge/plain.md", oldString: "title: a", newString: "title: a\nlive:\n  objective: x" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        // Copy/rename of a live note creates/moves a live note.
        await expect(g.check(builtin("file-copy", { from: "knowledge/live.md", to: "knowledge/copy.md" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(g.check(builtin("file-rename", { from: "knowledge/live.md", to: "knowledge/moved.md" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(g.check(builtin("file-rename", { from: "knowledge/plain.md", to: "knowledge/live.md", overwrite: true }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        // Ordinary note edits stay allowed.
        await expect(g.check(builtin("file-editText", { path: "knowledge/plain.md", oldString: "body", newString: "more body" }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(g.check(builtin("file-writeText", { path: "knowledge/new.md", data: "# Live demo notes\nlive: not frontmatter\n" }), policy))
            .resolves.toEqual({ kind: "default" });
    });

    it("refuses delegated to-dos (@rowboat starts a full background run)", async () => {
        await expect(guard.check(builtin("todo-add", { items: [{ text: "buy milk" }] }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(guard.check(builtin("todo-add", { items: [{ text: "@rowboat run the deploy" }] }), policy))
            .resolves.toMatchObject({ kind: "deny" });
    });
});

describe("hasLiveFrontmatter", () => {
    it("detects live keys in frontmatter only", () => {
        expect(hasLiveFrontmatter(LIVE_NOTE)).toBe(true);
        expect(hasLiveFrontmatter("---\r\nlive: {objective: x}\r\n---\r\n")).toBe(true);
        expect(hasLiveFrontmatter("---\nbase: &b {objective: x}\nlive: *b\n---\n")).toBe(true);
        expect(hasLiveFrontmatter(PLAIN_NOTE)).toBe(false);
        expect(hasLiveFrontmatter("# t\nlive: x\n")).toBe(false);
    });
});
