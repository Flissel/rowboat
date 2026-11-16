// Modified for VibeMind (Flissel/rowboat vibemind): a stdio MCP entry starts a
// process only when a human approved it in this process lifetime (ticket #330,
// Task 17). Real getClient path up to the transport: the transports and the
// MCP client are recording fakes, so no process and no connection is ever
// started. Temp workspace with the real FSMcpConfigRepo.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-gate-ws-")));
process.env.ROWBOAT_WORKDIR = root;

const state = vi.hoisted(() => ({
    transports: [] as Array<{ kind: string; target: string; args?: string[]; env?: Record<string, string> }>,
    calls: [] as Array<{ name: string }>,
}));

vi.mock("../knowledge/version_history.js", () => ({
    commitAll: async () => undefined,
    initRepo: async () => undefined,
}));
vi.mock("../di/container.js", async () => {
    const { FSMcpConfigRepo } = await import("./repo.js");
    const mcpRepo = new FSMcpConfigRepo();
    const stub = { ensureConfig: async () => undefined, ensureState: async () => undefined };
    return {
        default: {
            resolve: (name: string) => {
                if (name === "mcpConfigRepo") return mcpRepo;
                if (name === "modelConfigRepo" || name === "agentScheduleRepo" || name === "agentScheduleStateRepo") return stub;
                throw new Error(`unexpected resolve ${name}`);
            },
        },
    };
});
vi.mock("../spaces/orgs.js", () => ({ spacesMcpServers: async () => ({}) }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
    StreamableHTTPClientTransport: class {
        constructor(url: URL) {
            state.transports.push({ kind: "http", target: url.href });
        }
        close() {}
    },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
    SSEClientTransport: class {
        constructor(url: URL) {
            state.transports.push({ kind: "sse", target: url.href });
        }
        close() {}
    },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
    StdioClientTransport: class {
        constructor(opts: { command: string; args?: string[]; env?: Record<string, string> }) {
            state.transports.push({ kind: "stdio", target: opts.command, args: opts.args, env: opts.env });
        }
        close() {}
    },
}));
vi.mock("@modelcontextprotocol/sdk/client", () => ({
    Client: class {
        async connect() {}
        async close() {}
        async listTools() {
            return { tools: [] };
        }
        async callTool(req: { name: string }) {
            state.calls.push(req);
            return { content: [] };
        }
    },
}));

const { cleanup, executeTool } = await import("./mcp.js");
const approvals = await import("./stdio-approvals.js");
const { initConfigs } = await import("../config/initConfigs.js");
const { afterHumanWorkspaceWrite } = await import("../config/human-config-writes.js");
const workspace = await import("../workspace/workspace.js");
const { mcpTools } = await import("../runtime/tools/domains/mcp.js");

type Ctx = Parameters<(typeof mcpTools)["addMcpServer"]["execute"]>[1];

const mcpFile = path.join(root, "config", "mcp.json");
const OUTSIDE = "was added or changed outside the app";

async function writeRaw(servers: Record<string, unknown>): Promise<void> {
    await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: servers }, null, 2));
}

async function listMcpTools(serverName: string): Promise<{ error?: string; count?: number }> {
    return (await mcpTools.listMcpTools.execute({ serverName })) as { error?: string; count?: number };
}

async function addMcpServer(serverName: string, config: Record<string, unknown>, ctx?: Partial<NonNullable<Ctx>>) {
    return (await mcpTools.addMcpServer.execute({ serverName, config }, ctx)) as { success?: boolean; error?: string; message?: string };
}

const STDIO = { command: "node", args: ["server.js"], env: { A: "1", B: "2" } };

beforeEach(async () => {
    await cleanup();
    approvals.resetStdioApprovalsForTests();
    state.transports = [];
    state.calls = [];
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await writeRaw({});
});

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe("stdio approvals: the key", () => {
    it("env key order does not change the key; command, args, env and name do", () => {
        approvals.approveStdioEntry("s", { command: "node", args: ["a"], env: { A: "1", B: "2" } });
        expect(approvals.isStdioEntryApproved("s", { command: "node", args: ["a"], env: { B: "2", A: "1" } })).toBe(true);
        expect(approvals.isStdioEntryApproved("s", { command: "nodex", args: ["a"], env: { A: "1", B: "2" } })).toBe(false);
        expect(approvals.isStdioEntryApproved("s", { command: "node", args: ["b"], env: { A: "1", B: "2" } })).toBe(false);
        expect(approvals.isStdioEntryApproved("s", { command: "node", args: ["a"], env: { A: "1", B: "3" } })).toBe(false);
        expect(approvals.isStdioEntryApproved("s", { command: "node", args: ["a"] })).toBe(false);
        expect(approvals.isStdioEntryApproved("t", { command: "node", args: ["a"], env: { A: "1", B: "2" } })).toBe(false);
    });
});

describe("attacks: mcp.json changed outside the app", () => {
    it("a stdio entry written raw after startup: listMcpTools creates no transport and names the reason", async () => {
        await initConfigs();
        await writeRaw({ pwn: { command: "calc.exe" } });
        const result = await listMcpTools("pwn");
        expect(result.error).toContain(OUTSIDE);
        expect(result.error).toMatch(/restart|Settings/);
        expect(state.transports).toEqual([]);
    });

    it("executeTool on such an entry starts nothing either", async () => {
        await initConfigs();
        await writeRaw({ pwn: { command: "calc.exe" } });
        await expect(executeTool("pwn", "x", {})).rejects.toThrow(OUTSIDE);
        expect(state.transports).toEqual([]);
        expect(state.calls).toEqual([]);
    });

    it.each([
        ["command", { ...STDIO, command: "powershell" }],
        ["args", { ...STDIO, args: ["-c", "evil"] }],
        ["env", { ...STDIO, env: { A: "1", B: "2", NODE_OPTIONS: "--require evil.js" } }],
    ])("changing %s of an approved entry raw: no transport", async (_label, changed) => {
        await writeRaw({ ok: STDIO });
        await initConfigs();
        await writeRaw({ ok: changed });
        const result = await listMcpTools("ok");
        expect(result.error).toContain(OUTSIDE);
        expect(state.transports).toEqual([]);
    });

    it("addMcpServer with a command and no humanApproved (legacy engine, classifier-allowed auto mode): refused, file unchanged", async () => {
        await initConfigs();
        const before = await fs.readFile(mcpFile, "utf8");
        for (const ctx of [undefined, {}, { humanApproved: false }, { humanApproved: "yes" as unknown as boolean }]) {
            const result = await addMcpServer("pwn", { command: "calc.exe" }, ctx);
            expect(result.success, JSON.stringify(ctx)).not.toBe(true);
            expect(JSON.stringify(result)).toMatch(/human/i);
        }
        expect(await fs.readFile(mcpFile, "utf8")).toBe(before);
        expect(await listMcpTools("pwn")).toMatchObject({ error: expect.stringContaining("not found") });
        expect(state.transports).toEqual([]);
    });
});

describe("legitimate flows", () => {
    it("entries present at startup spawn (trust on boot)", async () => {
        await writeRaw({ ok: STDIO });
        await initConfigs();
        expect(await listMcpTools("ok")).toMatchObject({ count: 0 });
        expect(state.transports).toEqual([{ kind: "stdio", target: "node", args: ["server.js"], env: { A: "1", B: "2" } }]);
    });

    it("the same entry with its env keys reordered on disk still spawns", async () => {
        await writeRaw({ ok: STDIO });
        await initConfigs();
        await writeRaw({ ok: { ...STDIO, env: { B: "2", A: "1" } } });
        expect(await listMcpTools("ok")).toMatchObject({ count: 0 });
        expect(state.transports.map((t) => t.kind)).toEqual(["stdio"]);
    });

    it("a human-approved addMcpServer stdio entry spawns right away", async () => {
        await initConfigs();
        expect(await addMcpServer("neu", STDIO, { humanApproved: true })).toMatchObject({ success: true });
        expect(await listMcpTools("neu")).toMatchObject({ count: 0 });
        expect(state.transports).toEqual([{ kind: "stdio", target: "node", args: ["server.js"], env: { A: "1", B: "2" } }]);
    });

    it("addMcpServer with a URL keeps today's behaviour without humanApproved", async () => {
        await initConfigs();
        expect(await addMcpServer("web", { url: "http://127.0.0.1:9000/mcp" })).toMatchObject({ success: true });
        expect(await listMcpTools("web")).toMatchObject({ count: 0 });
        expect(state.transports).toEqual([{ kind: "http", target: "http://127.0.0.1:9000/mcp" }]);
    });

    it("a Settings save of config/mcp.json (the handler path) takes effect immediately", async () => {
        await initConfigs();
        const data = JSON.stringify({ mcpServers: { neu: STDIO } }, null, 2);
        await workspace.writeFile("config/mcp.json", data);
        await afterHumanWorkspaceWrite("config/mcp.json", { data });
        expect(await listMcpTools("neu")).toMatchObject({ count: 0 });
        expect(state.transports.map((t) => t.kind)).toEqual(["stdio"]);
    });

    it("the handler path approves what the human wrote, not a raw write racing it", async () => {
        await initConfigs();
        const data = JSON.stringify({ mcpServers: { neu: STDIO } }, null, 2);
        await workspace.writeFile("config/mcp.json", data);
        await writeRaw({ neu: { ...STDIO, command: "powershell" } });
        await afterHumanWorkspaceWrite("config/mcp.json", { data });
        expect((await listMcpTools("neu")).error).toContain(OUTSIDE);
        expect(state.transports).toEqual([]);
    });

    it("a human rename onto config/mcp.json approves the file's entries", async () => {
        await initConfigs();
        await fs.writeFile(path.join(root, "staged.json"), JSON.stringify({ mcpServers: { neu: STDIO } }));
        await workspace.rename("staged.json", "config/mcp.json", true);
        await afterHumanWorkspaceWrite("config/mcp.json");
        expect(await listMcpTools("neu")).toMatchObject({ count: 0 });
    });

    it("a human write to another file approves nothing", async () => {
        await initConfigs();
        await writeRaw({ pwn: { command: "calc.exe" } });
        await workspace.writeFile("config/tags.json", "{}");
        await afterHumanWorkspaceWrite("config/tags.json", { data: "{}" });
        expect((await listMcpTools("pwn")).error).toContain(OUTSIDE);
        expect(state.transports).toEqual([]);
    });

    it("URL entries are not gated: rowboat-auftraege written raw after startup connects (trusted call too)", async () => {
        await initConfigs();
        await writeRaw({ "rowboat-auftraege": { url: "http://127.0.0.1:8156/mcp" } });
        await executeTool("rowboat-auftraege", "video_auftrag_aus_konzept", { pfad: "x" }, {
            vertraut: { serverName: "rowboat-auftraege", toolName: "video_auftrag_aus_konzept", url: "http://127.0.0.1:8156/mcp" },
        });
        expect(state.transports).toEqual([{ kind: "http", target: "http://127.0.0.1:8156/mcp" }]);
        expect(state.calls).toEqual([{ name: "video_auftrag_aus_konzept", arguments: { pfad: "x" } }]);
    });
});
