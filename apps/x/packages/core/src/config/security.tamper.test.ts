// Modified for VibeMind (Flissel/rowboat vibemind): config/security.json takes
// effect only at load, through the human write paths and through
// addToSecurityConfig / addFileAccessGrant (ticket #330, Task 17). A raw write
// to the file after load (a shell command, another program) changes nothing.
// Temp workspace; nothing is executed (isBlocked only decides).
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "security-tamper-ws-")));
process.env.ROWBOAT_WORKDIR = root;

vi.mock("../knowledge/version_history.js", () => ({
    commitAll: async () => undefined,
    initRepo: async () => undefined,
}));

const security = await import("./security.js");
const { isBlocked } = await import("../application/lib/command-executor.js");
const { afterHumanWorkspaceWrite } = await import("./human-config-writes.js");
const workspace = await import("../workspace/workspace.js");

const file = path.join(root, "config", "security.json");
const outside = path.join(root, "..", "elsewhere");

async function writeRaw(payload: unknown): Promise<void> {
    await fs.writeFile(file, typeof payload === "string" ? payload : JSON.stringify(payload));
    // A later mtime than the load, so an mtime-based re-read would see it.
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(file, later, later);
}

beforeEach(async () => {
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ allowedCommands: ["ls"], allowedFileAccess: [] }));
    security.resetSecurityAllowListCache();
});

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe("security.json tampering after load", () => {
    it("a raw [\"*\"] after load leaves a blocked command blocked", async () => {
        security.reloadSecurityConfig();
        expect(isBlocked("powershell -c x")).toBe(true);
        await writeRaw(["*"]);
        expect(security.getSecurityAllowList()).toEqual(["ls"]);
        expect(isBlocked("powershell -c x")).toBe(true);
        expect(isBlocked("ls")).toBe(false);
    });

    it("file grants written raw after load are ignored", async () => {
        security.reloadSecurityConfig();
        await writeRaw({ allowedCommands: ["ls"], allowedFileAccess: [{ operation: "write", pathPrefix: outside }] });
        expect(security.getFileAccessAllowList()).toEqual([]);
    });

    it("the first use loads the file once; later raw writes are not re-read", async () => {
        expect(security.getSecurityAllowList()).toEqual(["ls"]);
        await writeRaw(["*"]);
        expect(security.getSecurityAllowList()).toEqual(["ls"]);
    });
});

describe("security.json legitimate flows", () => {
    it("\"*\" present at load is honoured", async () => {
        await writeRaw(["*"]);
        security.reloadSecurityConfig();
        expect(isBlocked("powershell -c x")).toBe(false);
    });

    it("a broken file at load falls back to the defaults", async () => {
        await writeRaw("{not json");
        security.reloadSecurityConfig();
        const list = security.getSecurityAllowList();
        expect(list).toContain("ls");
        expect(list).toContain("cat");
        expect(list).not.toContain("*");
    });

    it("Always allow (addToSecurityConfig) persists to the file and is effective immediately", async () => {
        security.reloadSecurityConfig();
        expect(isBlocked("git status")).toBe(true);
        await security.addToSecurityConfig(["git"]);
        expect(isBlocked("git status")).toBe(false);
        const saved = JSON.parse(await fs.readFile(file, "utf8")) as { allowedCommands: string[] };
        expect(saved.allowedCommands).toEqual(["git", "ls"]);
    });

    it("Always allow does not turn a raw write since load into live state", async () => {
        security.reloadSecurityConfig();
        await writeRaw({ allowedCommands: ["*"], allowedFileAccess: [{ operation: "write", pathPrefix: outside }] });
        await security.addToSecurityConfig(["git"]);
        expect(security.getSecurityAllowList().sort()).toEqual(["git", "ls"]);
        expect(isBlocked("powershell -c x")).toBe(true);
        expect(security.getFileAccessAllowList()).toEqual([]);
    });

    it("addFileAccessGrant persists and is effective immediately", async () => {
        security.reloadSecurityConfig();
        await security.addFileAccessGrant({ operation: "read", pathPrefix: outside });
        expect(security.getFileAccessAllowList()).toEqual([{ operation: "read", pathPrefix: path.resolve(outside) }]);
        const saved = JSON.parse(await fs.readFile(file, "utf8")) as { allowedFileAccess: unknown[] };
        expect(saved.allowedFileAccess).toEqual([{ operation: "read", pathPrefix: path.resolve(outside) }]);
    });

    it("a Settings save of config/security.json (the handler path) takes effect immediately", async () => {
        security.reloadSecurityConfig();
        const data = JSON.stringify({ allowedCommands: ["*"], allowedFileAccess: [] });
        await workspace.writeFile("config/security.json", data);
        await afterHumanWorkspaceWrite("config/security.json", { data });
        expect(isBlocked("powershell -c x")).toBe(false);
    });

    it("the handler path applies what the human wrote, not a later raw write", async () => {
        security.reloadSecurityConfig();
        const data = JSON.stringify({ allowedCommands: ["ls", "git"], allowedFileAccess: [] });
        await workspace.writeFile("config/security.json", data);
        await writeRaw(["*"]);
        await afterHumanWorkspaceWrite("config/security.json", { data });
        expect(security.getSecurityAllowList().sort()).toEqual(["git", "ls"]);
    });

    it("a human write to another config file does not reload security.json", async () => {
        security.reloadSecurityConfig();
        await writeRaw(["*"]);
        await workspace.writeFile("config/tags.json", "{}");
        await afterHumanWorkspaceWrite("config/tags.json", { data: "{}" });
        expect(isBlocked("powershell -c x")).toBe(true);
    });
});
