// Modified for VibeMind (Flissel/rowboat vibemind): new module (ticket #330,
// Task 17 fix round 1, review I-1). A restricted caller is a scoped server key
// (apps/server, auth kind "scoped" or no auth context) or the embed bridge
// (apps/main, origin "embed"). It may neither read nor change a protected
// workspace entry (Task 16 list: config/, keys, channels/, app data) through
// any channel that takes a path. The owner key and the app's own renderer are
// not restricted.
//
// Gated channels (every channel of the shared IPC table that takes a local
// path and returns content from it or writes to it):
//   writes (refused when a path is, lies inside or contains a protected entry):
//     workspace:writeFile / mkdir / rename / copy / remove,
//     knowledge:restore, live-note:set / setActive / delete / stop / run / get
//     (knowledge/<filePath>, the file is rewritten), google-docs:refreshSnapshot
//   reads (refused when a path IS a protected entry or lies inside one):
//     workspace:exists / stat / readdir / readFile / exportCopy,
//     knowledge:history / fileAtCommit (knowledge/<path>),
//     google-docs:sync / getLink (path), google-docs:import / pickViaManaged
//     (targetFolder), shell:previewFile / readFileBase64, spreadsheet:load /
//     find (path, unless it is only a display name for a space or message
//     file), spaces:uploadBlob (filePath), codeSession:readFile / readdir /
//     fileDiff (resolved against the session's cwd).
// Listing the workspace root stays allowed; a recursive listing drops what
// lies inside a protected entry (filterRestrictedReaddir).
// Checked and not gated (no local path, or not a content read): message
// attachments (rendered as path text only; the agent's file tools are gated
// by Task 16), search:query (knowledge/ only), runs:listByWorkDir, apps:*,
// spaces:* other than uploadBlob, and the dialog channels (a human picks).

import path from "node:path";
import container from "../di/container.js";
import type { ICodeSessionsRepo } from "../code-mode/sessions/repo.js";
import { isProtectedEntryName, isProtectedEntryPath, isProtectedPath } from "../runtime/tools/protected-paths.js";
import { workspaceOpTouchesProtected, type HumanWorkspaceOp } from "../config/human-config-writes.js";

export const RESTRICTED_REFUSAL =
    "This caller may not read or change protected workspace entries (config/, keys, channels/, app data).";

type Check = { kind: "entry" | "any"; path: string };
type Plan = { op: HumanWorkspaceOp } | { checks: Check[] } | "malformed";

export interface RestrictedDeps {
    // The cwd of a code session, or null when there is none.
    codeSessionCwd(sessionId: string): Promise<string | null>;
}

const defaultDeps: RestrictedDeps = {
    async codeSessionCwd(sessionId) {
        const session = await container.resolve<ICodeSessionsRepo>("codeSessionsRepo").get(sessionId);
        return session?.cwd ?? null;
    },
};

function record(args: unknown): Record<string, unknown> {
    return args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

const KNOWLEDGE = "knowledge";

type Planner = (a: Record<string, unknown>, deps: RestrictedDeps) => Promise<Plan> | Plan;

function one(kind: Check["kind"], key: string, base?: string): Planner {
    return (a) => {
        const p = str(a[key]);
        if (p === null) return "malformed";
        // "" is the workspace root (workspace:readdir lists it with "").
        return { checks: [{ kind, path: base ? path.join(base, p) : p || "." }] };
    };
}

function workspaceOp(build: (a: Record<string, unknown>) => HumanWorkspaceOp | null): Planner {
    return (a) => {
        const op = build(a);
        return op ? { op } : "malformed";
    };
}

function codeSession(key: string): Planner {
    return async (a, deps) => {
        const sessionId = str(a.sessionId);
        const rel = str(a[key]);
        if (sessionId === null || rel === null) return "malformed";
        const cwd = await deps.codeSessionCwd(sessionId);
        if (cwd === null) return "malformed";
        return { checks: [{ kind: "entry", path: path.resolve(cwd, rel || ".") }] };
    };
}

// spreadsheet:*: with `space` or `attachment` the path is only a display name.
const spreadsheet: Planner = (a) => {
    if (a.space !== undefined || a.attachment !== undefined) return { checks: [] };
    return one("entry", "path")(a, defaultDeps);
};

// spaces:uploadBlob: bytes inline need no path.
const uploadBlob: Planner = (a) => {
    if (a.filePath === undefined) return { checks: [] };
    return one("entry", "filePath")(a, defaultDeps);
};

const PLANNERS: Record<string, Planner> = {
    "workspace:writeFile": workspaceOp((a) => {
        const p = str(a.path);
        return p === null ? null : { kind: "writeFile", path: p, data: str(a.data) ?? "" };
    }),
    "workspace:mkdir": workspaceOp((a) => {
        const p = str(a.path);
        return p === null ? null : { kind: "mkdir", path: p };
    }),
    "workspace:remove": workspaceOp((a) => {
        const p = str(a.path);
        return p === null ? null : { kind: "remove", path: p };
    }),
    "workspace:rename": workspaceOp((a) => {
        const from = str(a.from);
        const to = str(a.to);
        return from === null || to === null ? null : { kind: "rename", from, to };
    }),
    "workspace:copy": workspaceOp((a) => {
        const from = str(a.from);
        const to = str(a.to);
        return from === null || to === null ? null : { kind: "copy", from, to };
    }),
    "workspace:exists": one("entry", "path"),
    "workspace:stat": one("entry", "path"),
    "workspace:readdir": one("entry", "path"),
    "workspace:readFile": one("entry", "path"),
    "workspace:exportCopy": one("entry", "path"),
    "knowledge:history": one("entry", "path", KNOWLEDGE),
    "knowledge:fileAtCommit": one("entry", "path", KNOWLEDGE),
    "knowledge:restore": one("any", "path", KNOWLEDGE),
    "live-note:get": one("any", "filePath", KNOWLEDGE),
    "live-note:set": one("any", "filePath", KNOWLEDGE),
    "live-note:setActive": one("any", "filePath", KNOWLEDGE),
    "live-note:delete": one("any", "filePath", KNOWLEDGE),
    "live-note:stop": one("any", "filePath", KNOWLEDGE),
    "live-note:run": one("any", "filePath", KNOWLEDGE),
    "google-docs:sync": one("entry", "path"),
    "google-docs:getLink": one("entry", "path"),
    "google-docs:refreshSnapshot": one("any", "path"),
    "google-docs:import": one("entry", "targetFolder"),
    "google-docs:pickViaManaged": one("entry", "targetFolder"),
    "shell:previewFile": one("entry", "path"),
    "shell:readFileBase64": one("entry", "path"),
    "spreadsheet:load": spreadsheet,
    "spreadsheet:find": spreadsheet,
    "spaces:uploadBlob": uploadBlob,
    "codeSession:readFile": codeSession("relPath"),
    "codeSession:readdir": codeSession("relPath"),
    "codeSession:fileDiff": codeSession("path"),
};

export const RESTRICTED_PATH_CHANNELS: ReadonlySet<string> = new Set(Object.keys(PLANNERS));

/**
 * True when a restricted caller must be refused this call. Channels without a
 * local path are never refused here. Fails closed: a missing or malformed
 * path, an unknown code session or a failing check counts as protected.
 */
export async function restrictedCallRefused(
    channel: string,
    args: unknown,
    deps: RestrictedDeps = defaultDeps,
): Promise<boolean> {
    const planner = PLANNERS[channel];
    if (!planner) return false;
    try {
        const plan = await planner(record(args), deps);
        if (plan === "malformed") return true;
        if ("op" in plan) return await workspaceOpTouchesProtected(plan.op);
        for (const check of plan.checks) {
            const hit = check.kind === "any" ? await isProtectedPath(check.path) : await isProtectedEntryPath(check.path);
            if (hit) return true;
        }
        return false;
    } catch {
        return true;
    }
}

/**
 * A recursive workspace:readdir for a restricted caller: drops every entry
 * that lies inside a protected entry (the entry itself stays, as in a root
 * listing). Non-recursive listings are returned unchanged.
 */
export async function filterRestrictedReaddir<T extends { path: string }>(args: unknown, entries: T[]): Promise<T[]> {
    const opts = record(record(args).opts);
    if (opts.recursive !== true) return entries;
    return entries.filter((entry) => {
        const segments = entry.path.split(/[\\/]+/).filter(Boolean);
        return !(segments.length > 1 && isProtectedEntryName(segments[0] ?? ""));
    });
}
