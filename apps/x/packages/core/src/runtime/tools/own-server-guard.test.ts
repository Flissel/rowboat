// Modified for VibeMind (Flissel/rowboat vibemind): fetch-url never reaches Rowboat's own server (ticket #330, fix round 1, review C1).
// No network: fetch is a stub everywhere (global stub for the execTool path), DNS is a stub.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "own-server-ws-")));
process.env.ROWBOAT_WORKDIR = root;

vi.mock("../../knowledge/version_history.js", () => ({
    commitAll: async () => undefined,
    initRepo: async () => undefined,
}));

const { guardedFetch, ownServerRefusal } = await import("./own-server-guard.js");
const { execTool } = await import("./exec-tool.js");
const { InMemoryAbortRegistry } = await import("../turns/abort-registry.js");
type Ctx = NonNullable<Parameters<typeof execTool>[2]>;

type Init = { method: string; headers?: Record<string, string>; body?: string; redirect: "manual"; signal?: AbortSignal };

function stubFetch(responder: (url: string, init: Init) => Response = () => new Response("ok", { status: 200 })) {
    const calls: Array<{ url: string; init: Init }> = [];
    const fetch = async (url: string, init: Init) => {
        calls.push({ url, init });
        return responder(url, init);
    };
    return { calls, fetch };
}

const noDns = async (host: string): Promise<string[]> => {
    throw new Error(`unexpected DNS lookup for ${host}`);
};

const RPC_TARGETS = [
    "http://127.0.0.1:3220/rpc/workspace:writeFile",
    "http://localhost:3220/rpc/sessions:respondToPermission",
    "http://[::1]:3220/rpc/workspace:writeFile",
    "http://127.1.2.3:3220/rpc/workspace:writeFile",
    "http://0.0.0.0:3220/rpc/workspace:writeFile",
    "http://[::ffff:127.0.0.1]:3220/rpc/workspace:writeFile",
    "http://2130706433:3220/rpc/workspace:writeFile",
    "http://LOCALHOST.:3220/rpc/workspace:writeFile",
    "http://app.localhost:3220/rpc/workspace:writeFile",
    // The port fallback of the server (3220..3229).
    "http://127.0.0.1:3225/rpc/workspace:writeFile",
];

afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe("ownServerRefusal", () => {
    it("refuses every loopback form of the own server's port", async () => {
        for (const target of RPC_TARGETS) {
            expect(await ownServerRefusal(new URL(target), { lookup: noDns }), target).toMatch(/own (local )?server/i);
        }
    });

    it("refuses the machine's own host name and its interface addresses", async () => {
        expect(await ownServerRefusal(new URL(`http://${os.hostname()}:3220/rpc/x`), { lookup: noDns })).toMatch(/own/i);
        const ownAddress = Object.values(os.networkInterfaces())
            .flat()
            .find((info) => info && info.family === "IPv4" && !info.internal)?.address;
        if (ownAddress) {
            expect(await ownServerRefusal(new URL(`http://${ownAddress}:3220/rpc/x`), { lookup: noDns })).toMatch(/own/i);
        }
    });

    it("refuses a name that resolves to loopback", async () => {
        const lookup = async () => ["127.0.0.1"];
        expect(await ownServerRefusal(new URL("http://rebind.example:3220/rpc/x"), { lookup })).toMatch(/own/i);
    });

    it("uses the port from config/server.json and ROWBOAT_SERVER_PORT", async () => {
        await fs.mkdir(path.join(root, "config"), { recursive: true });
        await fs.writeFile(path.join(root, "config", "server.json"), JSON.stringify({ port: 4555 }));
        process.env.ROWBOAT_SERVER_PORT = "4777";
        try {
            expect(await ownServerRefusal(new URL("http://127.0.0.1:4555/rpc/x"), { lookup: noDns })).toMatch(/own/i);
            expect(await ownServerRefusal(new URL("http://127.0.0.1:4777/rpc/x"), { lookup: noDns })).toMatch(/own/i);
        } finally {
            delete process.env.ROWBOAT_SERVER_PORT;
            await fs.rm(path.join(root, "config", "server.json"), { force: true });
        }
    });

    it("leaves other loopback ports and other hosts alone (ticket #325 covers them)", async () => {
        const lookup = async () => ["93.184.215.14"];
        expect(await ownServerRefusal(new URL("http://127.0.0.1:8080/x"), { lookup: noDns })).toBeNull();
        expect(await ownServerRefusal(new URL("http://localhost:3210/x"), { lookup: noDns })).toBeNull();
        expect(await ownServerRefusal(new URL("https://example.com/x"), { lookup })).toBeNull();
        expect(await ownServerRefusal(new URL("http://example.com:3220/x"), { lookup })).toBeNull();
    });
});

describe("guardedFetch", () => {
    it("refuses the own server before any request, for every method", async () => {
        for (const method of ["GET", "POST"]) {
            for (const target of RPC_TARGETS) {
                const stub = stubFetch();
                const result = await guardedFetch(target, method, { Authorization: "Bearer x" }, "{}", { fetch: stub.fetch, lookup: noDns });
                expect(result, target).toMatchObject({ ok: false, status: 0 });
                expect(stub.calls, target).toEqual([]);
            }
        }
    });

    it("refuses a redirect to the own server", async () => {
        const stub = stubFetch((url) =>
            url.startsWith("http://127.0.0.1:8080")
                ? new Response(null, { status: 307, headers: { location: "http://127.0.0.1:3220/rpc/workspace:writeFile" } })
                : new Response("should not happen"),
        );
        const result = await guardedFetch("http://127.0.0.1:8080/x", "POST", undefined, "{}", { fetch: stub.fetch, lookup: noDns });
        expect(result).toMatchObject({ ok: false, status: 0 });
        expect(String((result as { error?: string }).error)).toMatch(/own/i);
        expect(stub.calls.map((c) => c.url)).toEqual(["http://127.0.0.1:8080/x"]);
    });

    it("follows ordinary redirects like fetch did (303 becomes GET, cross-origin drops Authorization)", async () => {
        const stub = stubFetch((url) => {
            if (url === "http://127.0.0.1:8080/a") {
                return new Response(null, { status: 303, headers: { location: "http://127.0.0.1:8081/b" } });
            }
            return new Response("done", { status: 200 });
        });
        const result = await guardedFetch("http://127.0.0.1:8080/a", "POST", { Authorization: "Bearer x", "X-Other": "1" }, "{}", {
            fetch: stub.fetch,
            lookup: noDns,
        });
        expect(result).toMatchObject({ ok: true, status: 200, body: "done" });
        expect(stub.calls[1].init.method).toBe("GET");
        expect(stub.calls[1].init.body).toBeUndefined();
        expect(Object.keys(stub.calls[1].init.headers ?? {}).map((h) => h.toLowerCase())).toEqual(["x-other"]);
    });

    it("passes an ordinary request through unchanged", async () => {
        const stub = stubFetch(() => new Response("{\"a\":1}", { status: 200 }));
        const result = await guardedFetch("http://127.0.0.1:8080/api", "POST", { "Content-Type": "application/json" }, "{}", {
            fetch: stub.fetch,
            lookup: noDns,
        });
        expect(result).toMatchObject({ ok: true, status: 200, body: "{\"a\":1}", truncated: false });
        expect(stub.calls[0].init).toMatchObject({ method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    });
});

describe("fetch-url through execTool (global fetch stubbed)", () => {
    const spy = vi.fn(async () => new Response("ok", { status: 200 }));
    beforeEach(() => {
        spy.mockClear();
        vi.stubGlobal("fetch", spy);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const ctx = (extra: Partial<Ctx> = {}): Ctx => ({
        runId: "t1",
        toolCallId: "c1",
        signal: new AbortController().signal,
        abortRegistry: new InMemoryAbortRegistry(),
        publish: async () => undefined,
        ...extra,
    });
    const fetchUrl = (input: Record<string, unknown>, extra: Partial<Ctx> = {}) =>
        execTool({ type: "builtin", name: "fetch-url" }, input, ctx(extra)) as Promise<{ ok: boolean; error?: string }>;

    it("POST to the own /rpc is refused in a desktop run, even marked human-approved", async () => {
        for (const url of [
            "http://127.0.0.1:3220/rpc/workspace:writeFile",
            "http://localhost:3220/rpc/sessions:respondToPermission",
            "http://[::1]:3220/rpc/workspace:writeFile",
        ]) {
            const result = await fetchUrl({ url, method: "POST", headers: { Authorization: "Bearer x" }, body: "{}" }, { humanApproved: true });
            expect(result, url).toMatchObject({ ok: false });
            expect(result.error, url).toMatch(/own/i);
        }
        expect(spy).not.toHaveBeenCalled();
    });

    it("is refused in a channel run as well", async () => {
        const result = await fetchUrl({ url: "http://127.0.0.1:3220/rpc/workspace:writeFile" }, { channel: { readOnlyMcpTools: [] } });
        expect(result).toMatchObject({ ok: false });
        expect(spy).not.toHaveBeenCalled();
    });

    it("another loopback port is unchanged", async () => {
        const result = await fetchUrl({ url: "http://127.0.0.1:8080/api" });
        expect(result).toMatchObject({ ok: true });
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
