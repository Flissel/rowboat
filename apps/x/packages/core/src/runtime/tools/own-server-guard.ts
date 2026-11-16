// Modified for VibeMind (Flissel/rowboat vibemind): new module (ticket #330,
// fix round 1, review C1). fetch-url must never reach Rowboat's own local
// server (apps/server, POST /rpc/<channel>): with its key an agent could write
// config/ through workspace:writeFile, or answer its own human-only request
// through sessions:respondToPermission (recorded as source "human"). Refused
// in every run, whatever the method, with no approval path. Other loopback
// targets are unchanged here (ticket #325).
// Residual: the host is resolved again by fetch itself (DNS rebinding between
// this check and the connect is not prevented).

import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WorkDir } from "../../config/config.js";
import { expandV6, parseV4 } from "./channel-fetch.js";

// apps/server/src/config.ts: DEFAULT_PORT 3220, overridable by
// config/server.json "port" and ROWBOAT_SERVER_PORT; server.ts tries up to
// 10 consecutive ports when one is taken. Core does not import apps/server,
// so the same sources are read here and every fallback port counts.
const DEFAULT_SERVER_PORT = 3220;
const PORT_FALLBACK_ATTEMPTS = 10;

export interface OwnServerDeps {
    // All addresses a host name resolves to.
    lookup: (host: string) => Promise<string[]>;
}

export const defaultOwnServerDeps: OwnServerDeps = {
    lookup: async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address),
};

async function configuredPort(): Promise<number | undefined> {
    try {
        const raw = await fs.readFile(path.join(WorkDir, "config", "server.json"), "utf8");
        const port = Number((JSON.parse(raw) as { port?: unknown }).port);
        return Number.isInteger(port) && port > 0 ? port : undefined;
    } catch {
        return undefined;
    }
}

async function ownServerPorts(): Promise<Set<number>> {
    const env = Number(process.env.ROWBOAT_SERVER_PORT);
    const bases = [DEFAULT_SERVER_PORT, Number.isInteger(env) && env > 0 ? env : undefined, await configuredPort()];
    const ports = new Set<number>();
    for (const base of bases) {
        if (base === undefined) continue;
        for (let i = 0; i < PORT_FALLBACK_ATTEMPTS; i++) ports.add(base + i);
    }
    return ports;
}

function effectivePort(url: URL): number {
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
}

function loopbackOrUnspecifiedV4([a]: number[]): boolean {
    return a === 127 || a === 0;
}

// 127.0.0.0/8, 0.0.0.0/8, ::1, :: and their IPv4-mapped / -compatible forms.
function isLoopbackOrUnspecified(ip: string): boolean {
    const bare = ip.replace(/^\[|\]$/g, "");
    if (net.isIPv4(bare)) {
        const o = parseV4(bare);
        return !o || loopbackOrUnspecifiedV4(o);
    }
    if (net.isIPv6(bare)) {
        const h = expandV6(bare);
        if (!h) return true;
        if (h.slice(0, 7).every((g) => g === 0) && (h[7] === 0 || h[7] === 1)) return true;
        const v4 = [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff];
        if (h.slice(0, 5).every((g) => g === 0) && (h[5] === 0xffff || h[5] === 0)) return loopbackOrUnspecifiedV4(v4);
        return false;
    }
    return false;
}

function normalizeAddress(ip: string): string {
    const bare = ip.replace(/^\[|\]$/g, "").toLowerCase();
    const zone = bare.indexOf("%");
    const noZone = zone >= 0 ? bare.slice(0, zone) : bare;
    if (net.isIPv6(noZone)) {
        const h = expandV6(noZone);
        return h ? h.map((g) => g.toString(16)).join(":") : noZone;
    }
    return noZone;
}

function ownInterfaceAddresses(): Set<string> {
    const own = new Set<string>();
    for (const infos of Object.values(os.networkInterfaces())) {
        for (const info of infos ?? []) own.add(normalizeAddress(info.address));
    }
    return own;
}

function isOwnAddress(ip: string, interfaces: Set<string>): boolean {
    return isLoopbackOrUnspecified(ip) || interfaces.has(normalizeAddress(ip));
}

function isOwnName(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    const own = os.hostname().toLowerCase();
    return h === "localhost" || h.endsWith(".localhost") || h === own || h === `${own}.local`;
}

// A message when the URL points at Rowboat's own server, else null.
export async function ownServerRefusal(url: URL, deps: OwnServerDeps = defaultOwnServerDeps): Promise<string | null> {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const ports = await ownServerPorts();
    if (!ports.has(effectivePort(url))) return null;
    const refusal = `fetch-url may not call Rowboat's own local server (${url.host}). This is refused in every run, without an approval path.`;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isOwnName(host)) return refusal;
    const interfaces = ownInterfaceAddresses();
    if (net.isIP(host)) return isOwnAddress(host, interfaces) ? refusal : null;
    let addresses: string[];
    try {
        addresses = await deps.lookup(host);
    } catch {
        // Cannot tell where it goes: refused on the server's port (fails closed).
        return refusal;
    }
    return addresses.length === 0 || addresses.some((a) => isOwnAddress(a, interfaces)) ? refusal : null;
}

export interface GuardedFetchDeps extends OwnServerDeps {
    fetch: (
        url: string,
        init: { method: string; headers?: Record<string, string>; body?: string; redirect: "manual" },
    ) => Promise<Response>;
}

export const defaultGuardedFetchDeps: GuardedFetchDeps = {
    ...defaultOwnServerDeps,
    fetch: (url, init) => fetch(url, init),
};

const MAX_REDIRECTS = 20; // fetch's own limit
const MAX_BODY = 200_000;
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

type FetchUrlResult =
    | { ok: boolean; status: number; statusText: string; body: string; truncated: boolean }
    | { ok: false; status: 0; error: string };

// fetch-url outside channel runs: the request and every redirect hop are
// checked against the own server; redirects are followed by hand the way
// fetch follows them (303, and 301/302 after POST, become GET without a
// body; credentials are dropped when the origin changes).
export async function guardedFetch(
    rawUrl: string,
    rawMethod: string | undefined,
    headers: Record<string, string> | undefined,
    body: string | undefined,
    deps: GuardedFetchDeps = defaultGuardedFetchDeps,
): Promise<FetchUrlResult> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch (e) {
        return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, status: 0, error: "Only http(s) URLs are allowed." };
    }
    let method = (rawMethod || "GET").toUpperCase();
    let sendHeaders = headers;
    let sendBody = method === "GET" || method === "HEAD" ? undefined : body;
    try {
        for (let hop = 0; ; hop++) {
            const refusal = await ownServerRefusal(url, deps);
            if (refusal) return { ok: false, status: 0, error: refusal };
            const res = await deps.fetch(url.toString(), {
                method,
                ...(sendHeaders ? { headers: sendHeaders } : {}),
                ...(sendBody !== undefined ? { body: sendBody } : {}),
                redirect: "manual",
            });
            const location = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && location) {
                await res.body?.cancel().catch(() => undefined);
                if (hop >= MAX_REDIRECTS) return { ok: false, status: 0, error: "Too many redirects." };
                const next = new URL(location, url);
                if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
                    if (method !== "HEAD") method = "GET";
                    sendBody = undefined;
                }
                if (next.origin !== url.origin && sendHeaders) {
                    sendHeaders = Object.fromEntries(
                        Object.entries(sendHeaders).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())),
                    );
                }
                url = next;
                continue;
            }
            let text = await res.text();
            const truncated = text.length > MAX_BODY;
            if (truncated) text = text.slice(0, MAX_BODY);
            return { ok: res.ok, status: res.status, statusText: res.statusText, body: text, truncated };
        }
    } catch (e) {
        return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
}
