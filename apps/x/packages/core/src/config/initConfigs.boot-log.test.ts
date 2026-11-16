// Modified for VibeMind (Flissel/rowboat vibemind): ticket #330, Task 17 fix
// round 1 (review m-5). Trust on boot logs what it approved: one line per
// approved stdio entry (name and command basename — no args, no env values)
// and one line with the number of allow-listed commands and whether "*" is in.
// Temp workspace; nothing is started.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "boot-log-ws-")));
process.env.ROWBOAT_WORKDIR = root;

const { trustConfigsOnBoot } = await import("./initConfigs.js");
const { resetSecurityAllowListCache } = await import("./security.js");
const { isStdioEntryApproved, resetStdioApprovalsForTests } = await import("../mcp/stdio-approvals.js");

const securityFile = path.join(root, "config", "security.json");

beforeEach(async () => {
    await fs.mkdir(path.dirname(securityFile), { recursive: true });
    resetStdioApprovalsForTests();
    resetSecurityAllowListCache();
});

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

function repoWith(config: unknown) {
    return { getConfig: async () => config } as unknown as Parameters<typeof trustConfigsOnBoot>[0];
}

describe("trust on boot log", () => {
    it("logs each approved stdio entry by name and command basename, never args or env", async () => {
        await fs.writeFile(securityFile, JSON.stringify({ allowedCommands: ["git", "ls"], allowedFileAccess: [] }));
        const lines: string[] = [];
        await trustConfigsOnBoot(
            repoWith({
                mcpServers: {
                    files: { command: "C:\\tools\\node.exe", args: ["--secret-arg", "srv.js"], env: { TOKEN: "sk-VALUE" } },
                    py: { command: "/usr/bin/python3", args: ["x.py"] },
                    web: { url: "http://127.0.0.1:9000/mcp", headers: { authorization: "Bearer H" } },
                },
            }),
            (line) => lines.push(line),
        );
        expect(isStdioEntryApproved("files", { command: "C:\\tools\\node.exe", args: ["--secret-arg", "srv.js"], env: { TOKEN: "sk-VALUE" } })).toBe(true);
        expect(lines).toEqual([
            "[config] trust on boot: stdio MCP server \"files\" approved (command node.exe)",
            "[config] trust on boot: stdio MCP server \"py\" approved (command python3)",
            "[config] trust on boot: 2 allow-listed commands, \"*\" not present",
        ]);
        const all = lines.join("\n");
        for (const secret of ["--secret-arg", "srv.js", "sk-VALUE", "TOKEN", "Bearer", "x.py"]) {
            expect(all).not.toContain(secret);
        }
    });

    it("says when \"*\" is allow-listed", async () => {
        await fs.writeFile(securityFile, JSON.stringify(["*", "ls"]));
        const lines: string[] = [];
        await trustConfigsOnBoot(repoWith({ mcpServers: {} }), (line) => lines.push(line));
        expect(lines).toEqual(["[config] trust on boot: 2 allow-listed commands, \"*\" present (unrestricted shell)"]);
    });
});
