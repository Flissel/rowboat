// Modified for VibeMind (Flissel/rowboat vibemind): new module (ticket #330,
// fix round 1, review C1). fetch-url must never reach Rowboat's own local
// server (apps/server, POST /rpc/<channel>): with its key an agent could write
// config/ through workspace:writeFile, or answer its own human-only request
// through sessions:respondToPermission (recorded as source "human"). Refused
// in every run, whatever the method, with no approval path. Other loopback
// targets are unchanged here (ticket #325).
// Residual: the host is resolved again by fetch itself (DNS rebinding between
// this check and the connect is not prevented).

import { defaultOwnServerDeps, isOwnServerTarget, type OwnServerDeps } from "../../security/own-server-target.js";

// The host+port predicate lives in security/own-server-target.ts (fix round 2,
// review N2): the embedded browser's session uses the same one.
export { defaultOwnServerDeps, type OwnServerDeps };

// A message when the URL points at Rowboat's own server, else null.
export async function ownServerRefusal(url: URL, deps: OwnServerDeps = defaultOwnServerDeps): Promise<string | null> {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!(await isOwnServerTarget(url, deps))) return null;
    return `fetch-url may not call Rowboat's own local server (${url.host}). This is refused in every run, without an approval path.`;
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
