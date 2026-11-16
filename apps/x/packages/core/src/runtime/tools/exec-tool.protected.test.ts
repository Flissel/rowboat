// Modified for VibeMind (Flissel/rowboat vibemind): execTool refuses protected writes without a human (ticket #330).
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "exec-protected-ws-")));
process.env.ROWBOAT_WORKDIR = root;

// No git commits of knowledge/ from a test workspace.
vi.mock("../../knowledge/version_history.js", () => ({
    commitAll: async () => undefined,
    initRepo: async () => undefined,
}));

const { execTool } = await import("./exec-tool.js");
const { EMPTY_SANDBOX } = await import("./headless-sandbox.js");
const { InMemoryAbortRegistry } = await import("../turns/abort-registry.js");
type Ctx = NonNullable<Parameters<typeof execTool>[2]>;

const ws = (rel: string) => path.join(root, rel);

function ctx(extra: Partial<Ctx> = {}): Ctx {
    return {
        runId: "t1",
        toolCallId: "c1",
        signal: new AbortController().signal,
        abortRegistry: new InMemoryAbortRegistry(),
        publish: async () => undefined,
        ...extra,
    };
}

const builtin = (name: string) => ({ type: "builtin" as const, name });

beforeEach(async () => {
    await fs.rm(ws("config"), { recursive: true, force: true });
    await fs.mkdir(ws("config"), { recursive: true });
    await fs.writeFile(ws("config/mcp.json"), "{\"orig\":true}");
    await fs.writeFile(ws("config/security.json"), "[\"ls\"]");
    await fs.mkdir(ws("knowledge"), { recursive: true });
    await fs.writeFile(ws("knowledge/x.md"), "# x\n");
});

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

async function refused(name: string, input: Record<string, unknown>, extra: Partial<Ctx> = {}): Promise<string | undefined> {
    const result = (await execTool(builtin(name), input, ctx(extra))) as { error?: string } | null;
    return result?.error;
}

describe("execTool protected writes", () => {
    it("refuses file-writeText config/mcp.json without humanApproved and leaves the file", async () => {
        expect(await refused("file-writeText", { path: "config/mcp.json", data: "{\"pwn\":1}" })).toMatch(
            /protected .*human/i,
        );
        expect(await fs.readFile(ws("config/mcp.json"), "utf8")).toBe("{\"orig\":true}");
    });

    it("refuses when humanApproved is anything but true", async () => {
        const sneaky = { humanApproved: "yes" } as unknown as Partial<Ctx>;
        expect(await refused("file-writeText", { path: "config/mcp.json", data: "x" }, sneaky)).toMatch(/protected/i);
    });

    it("writes config/slack.json when a human approved the call", async () => {
        expect(await refused("file-writeText", { path: "config/slack.json", data: "{}" }, { humanApproved: true })).toBeUndefined();
        expect(await fs.readFile(ws("config/slack.json"), "utf8")).toBe("{}");
    });

    it("refuses every path variant and every write tool", async () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ["file-writeText", { path: "CONFIG/mcp.json", data: "x" }],
            ["file-writeText", { path: "knowledge/../config/mcp.json", data: "x" }],
            ["file-writeText", { path: "server-key::$DATA", data: "x" }],
            ["file-editText", { path: "config/mcp.json", oldString: "orig", newString: "pwn" }],
            ["file-rename", { from: "config/mcp.json", to: "knowledge/m.json" }],
            ["file-rename", { from: "knowledge/x.md", to: "config/mcp.json" }],
            ["file-copy", { from: "knowledge/x.md", to: "config/mcp.json" }],
            ["file-remove", { path: "config/security.json" }],
            ["file-mkdir", { path: "config/sub" }],
            ["text-to-speech", { text: "hi", outputPath: "config/a.mp3" }],
            ["deck-create", { path: "config/d.pptx", title: "t", slides: [] }],
            ["spreadsheet-create", { path: "config/s.csv" }],
        ];
        for (const [name, input] of cases) {
            expect(await refused(name, input), `${name} ${JSON.stringify(input)}`).toMatch(/protected/i);
        }
        expect(await fs.readFile(ws("config/mcp.json"), "utf8")).toBe("{\"orig\":true}");
        expect(await fs.readFile(ws("config/security.json"), "utf8")).toBe("[\"ls\"]");
        expect(fsSync.existsSync(ws("knowledge/m.json"))).toBe(false);
        expect(fsSync.existsSync(ws("config/sub"))).toBe(false);
        expect(fsSync.existsSync(ws("config/a.mp3"))).toBe(false);
    });

    it("refuses an executeCommand that names a protected entry (legacy engine ctx: never humanApproved)", async () => {
        const legacy = { autorunContentForbidden: true, headlessSandbox: EMPTY_SANDBOX };
        expect(await refused("executeCommand", { command: "echo [\"*\"] > config\\security.json" }, legacy)).toMatch(/protected/i);
        expect(await refused("executeCommand", { command: "echo x > security.json", cwd: "config" }, legacy)).toMatch(/protected/i);
        expect(await fs.readFile(ws("config/security.json"), "utf8")).toBe("[\"ls\"]");
    });

    it("leaves ordinary writes alone", async () => {
        expect(await refused("file-writeText", { path: "knowledge/y.md", data: "# y\n" })).toBeUndefined();
        expect(await fs.readFile(ws("knowledge/y.md"), "utf8")).toBe("# y\n");
        expect(await refused("file-copy", { from: "config/mcp.json", to: "knowledge/m.json" })).toBeUndefined();
    });
});
