// Modified for VibeMind (Flissel/rowboat vibemind): humanOnly requests for protected paths (ticket #330).
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "perm-meta-ws-")));
process.env.ROWBOAT_WORKDIR = root;

const { RealPermissionChecker } = await import("../turns/bridges/real-permission-checker.js");
const { resetSecurityAllowListCache } = await import("../../config/security.js");

async function writeSecurity(payload: unknown): Promise<void> {
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "security.json"), JSON.stringify(payload));
    resetSecurityAllowListCache();
}

beforeEach(async () => {
    await writeSecurity({ allowedCommands: ["dir", "type", "echo", "awk", "cat"], allowedFileAccess: [] });
});

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

const checker = new RealPermissionChecker();
const check = (toolName: string, input: Record<string, unknown>) =>
    checker.check({ turnId: "t", toolCallId: "c", toolId: `builtin:${toolName}`, toolName, input });

describe("file tools on protected paths", () => {
    it("file-writeText config/mcp.json needs a human-only file request", async () => {
        const result = await check("file-writeText", { path: "config/mcp.json", data: "{}" });
        expect(result).toMatchObject({
            required: true,
            request: { kind: "file", operation: "write", humanOnly: true },
        });
        const request = (result as { request: { paths: string[] } }).request;
        expect(request.paths).toEqual([path.join(root, "config", "mcp.json")]);
    });

    it("stays human-only although a stored grant covers the whole workspace", async () => {
        await writeSecurity({
            allowedCommands: [],
            allowedFileAccess: [{ operation: "write", pathPrefix: path.dirname(root) }],
        });
        expect(await check("file-writeText", { path: "config/slack.json", data: "{}" })).toMatchObject({
            required: true,
            request: { humanOnly: true },
        });
    });

    it("file-remove config/security.json is a human-only delete request", async () => {
        expect(await check("file-remove", { path: "config/security.json" })).toMatchObject({
            required: true,
            request: { kind: "file", operation: "delete", humanOnly: true },
        });
    });

    it("knowledge/x.md stays prompt-free", async () => {
        expect(await check("file-writeText", { path: "knowledge/x.md", data: "# x" })).toEqual({ required: false });
    });
});

describe("executeCommand fast path", () => {
    it("a redirect into config/ is not on the fast path and is human-only", async () => {
        for (const command of ["echo x > config\\security.json", "awk '{print}' x > config/mcp.json"]) {
            expect(await check("executeCommand", { command }), command).toMatchObject({
                required: true,
                request: { kind: "command", humanOnly: true },
            });
        }
    });

    it("an allow-listed command naming a protected entry is human-only", async () => {
        expect(await check("executeCommand", { command: "type server-key" })).toMatchObject({
            required: true,
            request: { kind: "command", commandNames: ["type"], humanOnly: true },
        });
    });

    it("a redirect with a name the shell may build (expansion, wildcard, ^, split quotes) is human-only", async () => {
        for (const command of [
            "echo x > c%X%onfig\\security.json",
            "echo x > conf*\\mcp.json",
            "echo x > con^fig\\mcp.json",
            "echo x > \"con\"fig\\mcp.json",
            "echo x > co$Xnfig/mcp.json",
            "echo x > c?nfig/mcp.json",
            "echo x > `printf co`nfig/mcp.json",
        ]) {
            expect(await check("executeCommand", { command }), command).toMatchObject({
                required: true,
                request: { kind: "command", humanOnly: true },
            });
        }
    });

    it("whole quoted words and expansion without a redirect do not make a request human-only", async () => {
        for (const command of ["echo hi > \"notes.txt\"", "echo \"a b\" > 'my notes.txt'"]) {
            const result = await check("executeCommand", { command });
            expect(result, command).toMatchObject({ required: true, request: { kind: "command" } });
            expect((result as { request: object }).request, command).not.toHaveProperty("humanOnly");
        }
        expect(await check("executeCommand", { command: "echo %PATH%" })).toEqual({ required: false });
    });

    it("an ordinary redirect needs a normal (not human-only) request", async () => {
        for (const command of ["echo hi > notes.txt", "echo hi >> notes.txt", "echo hi 1>notes.txt"]) {
            const result = await check("executeCommand", { command });
            expect(result, command).toMatchObject({ required: true, request: { kind: "command" } });
            expect((result as { request: object }).request, command).not.toHaveProperty("humanOnly");
        }
    });

    it("null-device redirects and 2>&1 stay on the fast path", async () => {
        for (const command of [
            "dir 2>&1",
            "type x 2>nul",
            "echo hi >nul",
            "echo hi >NUL",
            "echo hi >/dev/null",
            "cat x 2>/dev/null",
            "echo hi",
        ]) {
            expect(await check("executeCommand", { command }), command).toEqual({ required: false });
        }
    });
});
