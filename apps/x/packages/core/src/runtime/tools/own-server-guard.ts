// Modified for VibeMind (Flissel/rowboat vibemind): new module (ticket #330,
// fix round 1, review C1). fetch-url must never reach Rowboat's own local
// server (apps/server, POST /rpc/<channel>): with its key an agent could write
// config/ through workspace:writeFile, or answer its own human-only request
// through sessions:respondToPermission (recorded as source "human"). Refused
// in every run, whatever the method, with no approval path. Other loopback
// targets are unchanged here (ticket #325).
// Fix round 2 (DNS rebinding): the URL is checked before each hop, and the
// transport checks the address it really connects to (its own lookup runs
// the same predicate on every resolved address for the requested port).

import http from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import {
    defaultOwnServerDeps,
    isOwnServerAddress,
    isOwnServerTarget,
    type OwnServerDeps,
} from "../../security/own-server-target.js";

// The host+port predicate lives in security/own-server-target.ts (fix round 2,
// review N2): the embedded browser's session uses the same one.
export { defaultOwnServerDeps, type OwnServerDeps };

function refusalFor(host: string): string {
    return `fetch-url may not call Rowboat's own local server (${host}). This is refused in every run, without an approval path.`;
}

// A message when the URL points at Rowboat's own server, else null.
export async function ownServerRefusal(url: URL, deps: OwnServerDeps = defaultOwnServerDeps): Promise<string | null> {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!(await isOwnServerTarget(url, deps))) return null;
    return refusalFor(url.host);
}

export type TransportInit = {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    redirect: "manual";
    signal?: AbortSignal;
};
export type Transport = (url: string, init: TransportInit) => Promise<Response>;

export interface GuardedFetchDeps extends OwnServerDeps {
    // The HTTP transport (tests inject a stub). Default: connectGuardedFetch
    // over the same deps.
    fetch?: Transport;
}

export const defaultGuardedFetchDeps: GuardedFetchDeps = { ...defaultOwnServerDeps };

const IDLE_TIMEOUT_MS = 300_000; // undici's headers/body timeout
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function hasHeader(headers: Record<string, string>, name: string): boolean {
    return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function decodedBody(res: http.IncomingMessage): Readable {
    const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
    const decoder =
        encoding === "gzip" || encoding === "x-gzip"
            ? zlib.createGunzip()
            : encoding === "deflate"
              ? zlib.createInflate()
              : encoding === "br"
                ? zlib.createBrotliDecompress()
                : null;
    if (!decoder) return res;
    res.on("error", (e) => decoder.destroy(e));
    return res.pipe(decoder);
}

// An HTTP(S) transport with fetch's Response, built on node:http(s) so the
// connect address can be checked: the request's own lookup resolves the host
// and refuses the connection when any resolved address is the own server on
// the requested port. Host names only — an IP literal is not looked up, the
// URL pre-check (ownServerRefusal) covers it. Not followed: redirects
// (redirect "manual" — the caller re-checks each hop), proxies.
export function connectGuardedFetch(deps: OwnServerDeps = defaultOwnServerDeps): Transport {
    return (rawUrl, init) =>
        new Promise<Response>((resolve, reject) => {
            const url = new URL(rawUrl);
            const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
            const lookup: LookupFunction = (hostname, options, callback) => {
                (async () => {
                    const addresses = await deps.lookup(hostname);
                    if (addresses.length === 0) throw new Error(`Host ${hostname} could not be resolved.`);
                    for (const address of addresses) {
                        if (await isOwnServerAddress(address, port, deps)) throw new Error(refusalFor(url.host));
                    }
                    const family = typeof options.family === "number" ? options.family : 0;
                    const entries = addresses
                        .map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }))
                        .filter((e) => family === 0 || e.family === family);
                    if (entries.length === 0) throw new Error(`Host ${hostname} has no IPv${family} address.`);
                    if (options.all) callback(null, entries);
                    else callback(null, entries[0].address, entries[0].family);
                })().catch((error: unknown) => {
                    callback(error instanceof Error ? error : new Error(String(error)), "", 0);
                });
            };
            const headers: Record<string, string> = { ...(init.headers ?? {}) };
            if (!hasHeader(headers, "accept")) headers.accept = "*/*";
            if (!hasHeader(headers, "user-agent")) headers["user-agent"] = "node";
            if (!hasHeader(headers, "accept-encoding")) headers["accept-encoding"] = "gzip, deflate, br";
            if (init.body !== undefined) {
                // fetch labels a string body text/plain unless told otherwise.
                if (!hasHeader(headers, "content-type")) headers["content-type"] = "text/plain;charset=UTF-8";
                headers["content-length"] = String(Buffer.byteLength(init.body));
            }
            const lib = url.protocol === "https:" ? https : http;
            const req = lib.request(
                url,
                { method: init.method, headers, lookup, agent: false, ...(init.signal ? { signal: init.signal } : {}) },
                (res) => {
                    const status = res.statusCode ?? 0;
                    const responseHeaders = new Headers();
                    for (const [name, value] of Object.entries(res.headers)) {
                        if (value === undefined) continue;
                        for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(name, String(v));
                    }
                    let body: ReadableStream<Uint8Array> | null = null;
                    if (init.method === "HEAD" || NULL_BODY_STATUS.has(status)) {
                        res.resume();
                    } else {
                        body = Readable.toWeb(decodedBody(res)) as unknown as ReadableStream<Uint8Array>;
                    }
                    try {
                        resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
                    } catch (error) {
                        res.destroy();
                        reject(error);
                    }
                },
            );
            req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error("fetch-url timed out.")));
            req.on("error", reject);
            req.end(init.body);
        });
}

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
    const transport = deps.fetch ?? connectGuardedFetch(deps);
    let method = (rawMethod || "GET").toUpperCase();
    let sendHeaders = headers;
    let sendBody = method === "GET" || method === "HEAD" ? undefined : body;
    try {
        for (let hop = 0; ; hop++) {
            const refusal = await ownServerRefusal(url, deps);
            if (refusal) return { ok: false, status: 0, error: refusal };
            const res = await transport(url.toString(), {
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
