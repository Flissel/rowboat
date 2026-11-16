// Modified for VibeMind (Flissel/rowboat vibemind): protected workspace paths (ticket #330).
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// WorkDir is read once at import: point it at a scratch workspace first.
const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "protected-ws-")));
process.env.ROWBOAT_WORKDIR = root;

const {
    PROTECTED_WORKSPACE_ENTRIES,
    commandNamesProtectedEntry,
    isProtectedWrite,
} = await import("./protected-paths.js");

beforeAll(async () => {
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "mcp.json"), "{}");
    await fs.mkdir(path.join(root, "knowledge"), { recursive: true });
    await fs.writeFile(path.join(root, "knowledge", "x.md"), "# x\n");
    // A link inside knowledge/ that points into config/.
    await fs.symlink(
        path.join(root, "config"),
        path.join(root, "knowledge", "link"),
        process.platform === "win32" ? "junction" : "dir",
    );
});

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe("protected workspace entries", () => {
    it("lists exactly the six entries of the ticket", () => {
        expect([...PROTECTED_WORKSPACE_ENTRIES]).toEqual([
            "config",
            "server-key",
            "cipher-key",
            "embed.json",
            ".electron-data",
            "channels",
        ]);
    });
});

describe("isProtectedWrite — file tools", () => {
    const write = (p: string) => isProtectedWrite("file-writeText", { path: p, data: "x" });

    it("covers every protected entry and paths inside them", async () => {
        for (const p of [
            "config/mcp.json",
            "config/slack.json",
            "server-key",
            "cipher-key",
            "embed.json",
            ".electron-data/Local State",
            "channels/telegram-state.json",
        ]) {
            expect(await write(p), p).toBe(true);
        }
    });

    it("path variants: case, .., trailing dot, stream syntax, absolute, symlink", async () => {
        for (const p of [
            "CONFIG/mcp.json",
            "Config\\MCP.json",
            "knowledge/../config/mcp.json",
            "config./mcp.json",
            "server-key::$DATA",
            "knowledge/x.md:hidden",
            path.join(root, "config", "mcp.json"),
            "knowledge/link/mcp.json",
            "CONFIG~1/mcp.json",
        ]) {
            expect(await write(p), p).toBe(true);
        }
    });

    it("leaves ordinary workspace and outside writes alone", async () => {
        for (const p of [
            "knowledge/x.md",
            "knowledge/config/notes.md",
            "configuration.md",
            "config.bak",
            path.join(os.tmpdir(), "elsewhere.txt"),
            "~/elsewhere.txt",
        ]) {
            expect(await write(p), p).toBe(false);
        }
    });

    it("covers rename (source and destination), copy (destination only), remove, mkdir", async () => {
        expect(await isProtectedWrite("file-rename", { from: "config/mcp.json", to: "knowledge/m.json" })).toBe(true);
        expect(await isProtectedWrite("file-rename", { from: "knowledge/x.md", to: "config/mcp.json" })).toBe(true);
        expect(await isProtectedWrite("file-copy", { from: "knowledge/x.md", to: "config/mcp.json" })).toBe(true);
        expect(await isProtectedWrite("file-copy", { from: "config/mcp.json", to: "knowledge/m.json" })).toBe(false);
        expect(await isProtectedWrite("file-remove", { path: "config/security.json" })).toBe(true);
        expect(await isProtectedWrite("file-mkdir", { path: "config" })).toBe(true);
        expect(await isProtectedWrite("file-editText", { path: "config/mcp.json", oldString: "a", newString: "b" })).toBe(true);
    });

    it("removing or moving the workspace itself counts", async () => {
        expect(await isProtectedWrite("file-remove", { path: "." })).toBe(true);
        expect(await isProtectedWrite("file-rename", { from: root, to: path.join(os.tmpdir(), "moved") })).toBe(true);
    });

    it("covers text-to-speech outputPath, deck-* and spreadsheet-*", async () => {
        expect(await isProtectedWrite("text-to-speech", { text: "hi", outputPath: "config/a.mp3" })).toBe(true);
        expect(await isProtectedWrite("text-to-speech", { text: "hi" })).toBe(false);
        expect(await isProtectedWrite("deck-create", { path: "config/d.pptx" })).toBe(true);
        expect(await isProtectedWrite("deck-restyle", { path: "config/d.pptx" })).toBe(true);
        expect(await isProtectedWrite("spreadsheet-create", { path: "config/s.csv" })).toBe(true);
        expect(await isProtectedWrite("spreadsheet-edit", { path: "config/s.csv" })).toBe(true);
    });

    it("reads are not writes", async () => {
        expect(await isProtectedWrite("file-readText", { path: "config/mcp.json" })).toBe(false);
        expect(await isProtectedWrite("file-list", { path: "config" })).toBe(false);
    });
});

describe("isProtectedWrite — executeCommand", () => {
    it("flags a command that names a protected entry as a path segment", async () => {
        for (const command of [
            "echo [\"*\"] > config\\security.json",
            "awk 'BEGIN{print 1}' > config/mcp.json",
            "type server-key",
            "copy x C:\\Users\\u\\.rowboat\\Config\\mcp.json",
            "echo x > con^fig\\security.json",
            "echo x > \"con\"\"fig\"/security.json",
            "echo x > config.\\security.json",
        ]) {
            expect(commandNamesProtectedEntry(command), command).toBe(true);
            expect(await isProtectedWrite("executeCommand", { command }), command).toBe(true);
        }
    });

    it("flags every output redirect other than the harmless ones (controller's final ruling)", async () => {
        for (const command of [
            "echo x > c%X%onfig\\security.json",
            "echo x > conf*\\mcp.json",
            "echo x > \"con\"fig\\mcp.json",
            "echo x > (\"con\"+\"fig\\mcp.json\")",
            "echo hi > notes.txt",
            "echo hi >> notes.txt",
            "echo hi >",
            "echo x > mcp.json",
            "echo hi\necho x > a.txt",
        ]) {
            expect(await isProtectedWrite("executeCommand", { command }), command).toBe(true);
        }
        expect(await isProtectedWrite("executeCommand", { command: "echo x > mcp.json", cwd: "knowledge" })).toBe(true);
        // Without a redirect, expansion alone does not count.
        expect(await isProtectedWrite("executeCommand", { command: "echo %PATH%" })).toBe(false);
        // "~" anywhere (8.3 short names such as CONFIG~1) counts as naming a protected entry.
        expect(commandNamesProtectedEntry("type CONFIG~1\\mcp.json")).toBe(true);
        expect(await isProtectedWrite("executeCommand", { command: "dir CONFIG~1" })).toBe(true);
    });

    it("flags a command whose cwd is a protected entry", async () => {
        expect(await isProtectedWrite("executeCommand", { command: "echo x > security.json", cwd: "config" })).toBe(true);
    });

    it("leaves other commands alone", async () => {
        for (const command of ["dir 2>&1", "type x 2>nul", "echo hi 1>nul", "ls knowledge", "cat configuration.md"]) {
            expect(await isProtectedWrite("executeCommand", { command }), command).toBe(false);
        }
    });
});
