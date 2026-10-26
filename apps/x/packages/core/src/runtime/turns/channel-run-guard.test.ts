// Modified for VibeMind (Flissel/rowboat vibemind): tests for the channel-run guard (Teil E).
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ToolDescriptor } from "@x/shared/dist/turns.js";
import { ChannelRunGuard, type ChannelRunPolicy } from "./channel-run-guard.js";

const ROOT = path.resolve("/rowboat-ws");
const policy: ChannelRunPolicy = { readOnlyMcpServers: ["wissen", "vibemind-werkzeuge", "exa"] };

const guard = new ChannelRunGuard({
    workspaceRoot: async () => ROOT,
    resolvePath: async (p) => path.resolve(ROOT, p),
});

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
    it("drops process-starting and config-changing builtins", () => {
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
        ]) {
            expect(guard.offers(descriptor(`builtin:${name}`), policy), name).toBe(false);
        }
    });

    it("keeps reading/notes/todo builtins and ask-human", () => {
        for (const name of ["file-readText", "file-writeText", "fetch-url", "todo-add", "ask-human", "executeMcpTool"]) {
            expect(guard.offers(descriptor(`builtin:${name}`), policy), name).toBe(true);
        }
    });

    it("offers only allowlisted MCP attachments", () => {
        expect(guard.offers(descriptor("mcp:wissen:search"), policy)).toBe(true);
        expect(guard.offers(descriptor("mcp:github:create_issue"), policy)).toBe(false);
    });
});

describe("ChannelRunGuard.check", () => {
    it("refuses fetch-url POST, allows GET and HEAD", async () => {
        await expect(guard.check(builtin("fetch-url", { url: "https://x", method: "POST", body: "a" }), policy))
            .resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("POST") });
        await expect(guard.check(builtin("fetch-url", { url: "https://x", method: "put" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("fetch-url", { url: "https://x" }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(guard.check(builtin("fetch-url", { url: "https://x", method: "HEAD" }), policy))
            .resolves.toEqual({ kind: "default" });
    });

    it("refuses executeCommand and addMcpServer", async () => {
        await expect(guard.check(builtin("executeCommand", { command: "ls" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("addMcpServer", { serverName: "x", config: {} }), policy))
            .resolves.toMatchObject({ kind: "deny" });
    });

    it("auto-approves allowlisted MCP servers and refuses others", async () => {
        await expect(guard.check({ toolId: "mcp:exa:search", toolName: "search", input: {} }, policy))
            .resolves.toEqual({ kind: "allow" });
        await expect(guard.check({ toolId: "mcp:github:create_issue", toolName: "create_issue", input: {} }, policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("executeMcpTool", { serverName: "wissen", toolName: "q" }), policy))
            .resolves.toEqual({ kind: "allow" });
        await expect(guard.check(builtin("executeMcpTool", { serverName: "github", toolName: "q" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("listMcpTools", { serverName: "github" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
    });

    it("refuses reads of config, keys, channel state and token/env files", async () => {
        for (const p of [
            "config/channels.json",
            "config/models.json",
            "config",
            "server-key",
            "cipher-key",
            "embed.json",
            ".electron-data/Cookies",
            "channels/telegram-state.json",
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
        await expect(guard.check(builtin("file-glob", { pattern: "../config/*", cwd: "knowledge" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-grep", { pattern: "x", searchPath: "knowledge", fileGlob: "../../config/*" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
    });

    it("allows writes only under knowledge/", async () => {
        await expect(guard.check(builtin("file-writeText", { path: "knowledge/Notes/n.md", data: "x" }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(guard.check(builtin("file-writeText", { path: "config/mcp.json", data: "{}" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-writeText", { path: "bg-tasks/x.md", data: "x" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-copy", { from: "config/channels.json", to: "knowledge/c.json" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
        await expect(guard.check(builtin("file-rename", { from: "knowledge/a.md", to: "agents/a.md" }), policy))
            .resolves.toMatchObject({ kind: "deny" });
    });

    it("refuses delegated to-dos (@rowboat starts a full background run)", async () => {
        await expect(guard.check(builtin("todo-add", { items: [{ text: "buy milk" }] }), policy))
            .resolves.toEqual({ kind: "default" });
        await expect(guard.check(builtin("todo-add", { items: [{ text: "@rowboat run the deploy" }] }), policy))
            .resolves.toMatchObject({ kind: "deny" });
    });
});
