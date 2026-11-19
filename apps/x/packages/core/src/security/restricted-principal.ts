// Modified for VibeMind (Flissel/rowboat vibemind): new module (ticket #330,
// Task 17 fix round 1, review I-1; fix round 2, review F-2). A restricted
// caller is a scoped server key (apps/server, auth kind "scoped" or no auth
// context) or the embed bridge (apps/main, origin "embed"). It may neither read
// nor change a protected workspace entry (Task 16 list: config/, keys,
// channels/, app data), may not change configuration or authority, and gets no
// credentials back. The owner key and the app's own renderer are not
// restricted. Both hosts consume this module: the server guard
// (apps/server core-deps.ts guardRestrictedCallers) and main's IPC dispatch
// for the embed (apps/main ipc.ts invokeIpcChannel).
//
// 1. Path channels (every channel of the shared IPC table that takes a local
//    path and returns content from it or writes to it):
//   writes (refused when a path is, lies inside or contains a protected entry):
//     workspace:writeFile / mkdir / rename / copy / remove,
//     knowledge:restore, live-note:set / setActive / delete / stop / run / get
//     (knowledge/<filePath>, the file is rewritten), google-docs:refreshSnapshot
//   reads (refused when a path IS a protected entry or lies inside one):
//     workspace:exists / stat / readdir / readFile / exportCopy,
//     knowledge:history / fileAtCommit (knowledge/<path>),
//     google-docs:sync / getLink (path), google-docs:import / pickViaManaged
//     (targetFolder), shell:previewFile / readFileBase64 (resolved exactly as
//     main resolves them, workspace/shell-path.ts), spreadsheet:load / find
//     (path, unless it is only a display name for a space or message file),
//     spaces:uploadBlob (filePath), codeSession:readFile / readdir / fileDiff
//     (resolved against the session's cwd).
//   Listing the workspace root stays allowed; a listing drops every entry
//   that lies inside a protected entry, judged by its resolved path.
//   Checked and not gated (no local path, or not a content read): message
//   attachments (rendered as path text only; the agent's file tools are gated
//   by Task 16), search:query (knowledge/ only), runs:listByWorkDir, apps:*,
//   spaces:* other than uploadBlob, the dialog channels (a human picks), and
//   shell:showItemInFolder (reveals a file in the OS file manager, returns no
//   content).
// 2. Config and authority channels (fix round 2, review F-2): the explicit
//    deny set RESTRICTED_DENIED_CHANNELS (each entry says what it writes), and
//    three channels refused only when they set an approval policy
//    (RESTRICTED_CONDITIONAL_CHANNELS). The full table with the channels
//    checked and not gated is in the Task 17 report (fix round 2).
// 3. Getters that return credentials: restrictedResult() blanks them
//    (RESTRICTED_MASKED_CHANNELS).
// 4. Permission answers are not refused here: the consumers record who
//    answered (turn runtime, legacy runs, CodePermissionRegistry) and refuse
//    what a restricted caller may not answer.

import path from "node:path";
import container from "../di/container.js";
import type { ICodeSessionsRepo } from "../code-mode/sessions/repo.js";
import { isProtectedEntryPath, isProtectedPath } from "../runtime/tools/protected-paths.js";
import { workspaceOpTouchesProtected, type HumanWorkspaceOp } from "../config/human-config-writes.js";
import { isPlainHomePrefix, resolveShellPath } from "../workspace/shell-path.js";

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

// shell:*: the path main acts on (resolveShellPath, shared with main). A "~"
// prefix other than "~", "~/" and "~\" fails closed; so does a relative path
// main would refuse ("..").
function shellPath(key: string): Planner {
    return (a) => {
        const p = str(a[key]);
        if (p === null || !isPlainHomePrefix(p)) return "malformed";
        return { checks: [{ kind: "entry", path: resolveShellPath(p) }] };
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
    "shell:previewFile": shellPath("path"),
    "shell:readFileBase64": shellPath("path"),
    "spreadsheet:load": spreadsheet,
    "spreadsheet:find": spreadsheet,
    "spaces:uploadBlob": uploadBlob,
    "codeSession:readFile": codeSession("relPath"),
    "codeSession:readdir": codeSession("relPath"),
    "codeSession:fileDiff": codeSession("path"),
};

export const RESTRICTED_PATH_CHANNELS: ReadonlySet<string> = new Set(Object.keys(PLANNERS));

// Fix round 2 (review F-2): channels that write configuration, credentials or
// account connections, or change who or what may act. Refused for a
// restricted caller whatever the arguments. Value: what the channel writes.
const SPACES_ORGS = "config/spaces_orgs.json (Spaces org connections and their credentials)";
const SPACES_AGENT_CREDENTIALS = "credentials of a Spaces agent (createAgentKey and setAgentHook return a secret)";
export const RESTRICTED_DENIED_CHANNELS: ReadonlyMap<string, string> = new Map([
    ["agent-schedule:updateAgent", "config/agent-schedule.json (scheduled headless agent runs)"],
    ["agent-schedule:deleteAgent", "config/agent-schedule.json, config/agent-schedule-state.json"],
    ["app:setLoginItemSettings", "OS login item, config/app_settings.json"],
    ["app:setTelemetrySettings", "config/app_settings.json (telemetry opt-out)"],
    ["channels:setConfig", "config/channels.json (allowFrom, Telegram bot token, readOnlyMcpTools auto-approved in channel runs)"],
    ["channels:whatsappLogout", "channels/whatsapp-auth (the linked WhatsApp device)"],
    ["chatgpt:signIn", "config/chatgpt-auth.json (ChatGPT account tokens)"],
    ["chatgpt:signOut", "config/chatgpt-auth.json"],
    ["codeMode:setConfig", "config/code-mode.json (fallback approval policy of every code_agent_run, default project)"],
    ["codeMode:provisionEngine", "downloads and installs a coding-agent engine executable"],
    ["codeProject:add", "config/code-projects.json (folders the coding agent works in, the default project)"],
    ["codeProject:remove", "config/code-projects.json"],
    ["composio:set-api-key", "config/composio.json (API key)"],
    ["composio:initiate-connection", "a Composio account connection the agent's tools act through"],
    ["composio:sync-connection", "a Composio account connection the agent's tools act through"],
    ["composio:disconnect", "a Composio account connection"],
    ["githubAuth:start", "config/github-auth.json (GitHub token for app publishing)"],
    ["githubAuth:poll", "config/github-auth.json (stores the token when the device flow completes)"],
    ["githubAuth:signOut", "config/github-auth.json"],
    ["gmail:setEmailInstructions", "config/email_instructions.md (instructions for the email agent)"],
    ["granola:setConfig", "config/granola.json"],
    ["knowledgeSources:upsert", "config/knowledge_sources.json (sync sources and their artifact folders)"],
    ["models:setProvider", "config/models.json (provider API key and base URL)"],
    ["models:removeProvider", "config/models.json"],
    ["models:updateConfig", "config/models.json (assistant, task and permission-classifier models)"],
    ["models:resolveRecommendationUpdate", "config/models.json (applies recommended models)"],
    ["notifications:setSettings", "config/notification_settings.json"],
    ["oauth:connect", "config/oauth.json (provider tokens, client id and secret)"],
    ["oauth:disconnect", "config/oauth.json"],
    ["phone:push:register", "config/phone_push.json (where notifications are pushed)"],
    ["retention:setSettings", "config/retention.json (automatic deletion of old chats)"],
    ["server:connectRemote", "the server this app talks to, and its token"],
    ["server:disconnectRemote", "the server this app talks to"],
    ["server:rotateKey", "server-key (the owner key)"],
    ["server:setLanEnabled", "whether the local server listens on the LAN"],
    ["slack:setConfig", "config/slack.json"],
    ["slack:importDesktopAuth", "Slack credentials in agent-slack's credential store"],
    ["slack:quitAndImportDesktop", "Slack credentials in agent-slack's credential store (force-quits Slack)"],
    ["slack:parseCurlAuth", "Slack credentials of the caller's choosing in agent-slack's credential store"],
    ["spaces:signInRowboat", SPACES_ORGS],
    ["spaces:addOrg", SPACES_ORGS],
    ["spaces:addOrgByAddress", SPACES_ORGS],
    ["spaces:signInOrg", SPACES_ORGS],
    ["spaces:createOrg", SPACES_ORGS],
    ["spaces:removeOrg", SPACES_ORGS],
    ["spaces:joinInvite", SPACES_ORGS],
    ["spaces:createAgentKey", SPACES_AGENT_CREDENTIALS],
    ["spaces:revokeAgentKey", SPACES_AGENT_CREDENTIALS],
    ["spaces:setAgentCredential", SPACES_AGENT_CREDENTIALS],
    ["spaces:setAgentHook", SPACES_AGENT_CREDENTIALS],
    ["spaces:clearAgentHook", SPACES_AGENT_CREDENTIALS],
    ["turnLimits:setSettings", "config/turn_limits.json"],
    ["typesafe:setApiKey", "config/typesafe.json (API key)"],
    ["typesafe:clearApiKey", "config/typesafe.json"],
]);

// Refused only when they set an approval policy: the policy of a code session
// (code-mode/sessions-meta/<id>.json) or of one message's coding run. Any
// policy field counts, "ask" included (the human sets policies).
const CONDITIONAL: Record<string, (a: Record<string, unknown>) => boolean> = {
    "codeSession:update": (a) => {
        if (a.patch === null || typeof a.patch !== "object") return true;
        const patch = a.patch as Record<string, unknown>;
        return patch.policy !== undefined || patch.clearPolicy !== undefined;
    },
    "codeSession:create": (a) => a.policy !== undefined,
    "runs:createMessage": (a) => a.codePolicy !== undefined,
};
export const RESTRICTED_CONDITIONAL_CHANNELS: ReadonlySet<string> = new Set(Object.keys(CONDITIONAL));

// Getters whose result carries a credential: blanked for a restricted caller.
type Mask = (result: Record<string, unknown>) => Record<string, unknown>;
const MASKS: Record<string, Mask> = {
    "channels:getConfig": (r) => ({ ...r, telegram: { ...record(r.telegram), botToken: "" } }),
    // The pairing QR links whoever scans it as the bridge's WhatsApp account.
    "channels:getStatus": (r) => {
        const { qrDataUrl: _qr, ...whatsapp } = record(r.whatsapp);
        return { ...r, whatsapp };
    },
    "voice:getConfig": (r) => ({ ...r, deepgram: null, elevenlabs: null }),
    "account:getRowboat": (r) => ({ ...r, accessToken: null }),
    // The token IS the owner key (server-key content).
    "server:getPairingInfo": (r) => ({ ...r, token: null }),
};
export const RESTRICTED_MASKED_CHANNELS: ReadonlySet<string> = new Set(Object.keys(MASKS));

// Every channel a host must route through this module for a restricted caller.
export const RESTRICTED_GUARDED_CHANNELS: ReadonlySet<string> = new Set([
    ...RESTRICTED_PATH_CHANNELS,
    ...RESTRICTED_DENIED_CHANNELS.keys(),
    ...RESTRICTED_CONDITIONAL_CHANNELS,
    ...RESTRICTED_MASKED_CHANNELS,
]);

/**
 * True when a restricted caller must be refused this call. Fails closed: a
 * missing or malformed path, an unknown code session or a failing check counts
 * as protected.
 */
export async function restrictedCallRefused(
    channel: string,
    args: unknown,
    deps: RestrictedDeps = defaultDeps,
): Promise<boolean> {
    if (RESTRICTED_DENIED_CHANNELS.has(channel)) return true;
    const conditional = CONDITIONAL[channel];
    if (conditional) return conditional(record(args));
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
 * A workspace:readdir result for a restricted caller: drops every entry that
 * lies inside a protected entry (the entry itself stays, as in a root
 * listing). Each entry is judged by its resolved path — entry.path is
 * workspace-relative and already carries the requested folder — so a
 * listing asked for as "knowledge/.." or with backslashes is filtered the
 * same way. The check runs once per parent folder.
 */
export async function filterRestrictedReaddir<T extends { path: string }>(_args: unknown, entries: T[]): Promise<T[]> {
    const insideProtected = new Map<string, Promise<boolean>>();
    const parentProtected = (entryPath: string): Promise<boolean> => {
        const parent = path.dirname(path.normalize(entryPath.replace(/\\/g, "/")));
        let hit = insideProtected.get(parent);
        if (!hit) {
            hit = isProtectedEntryPath(parent).catch(() => true);
            insideProtected.set(parent, hit);
        }
        return hit;
    };
    const keep = await Promise.all(entries.map(async (entry) => !(await parentProtected(entry.path))));
    return entries.filter((_entry, i) => keep[i]);
}

/**
 * The result a restricted caller gets: credentials blanked, listings
 * filtered. Other results are returned unchanged.
 */
export async function restrictedResult(channel: string, args: unknown, result: unknown): Promise<unknown> {
    if (channel === "workspace:readdir" && Array.isArray(result)) {
        return filterRestrictedReaddir(args, result as Array<{ path: string }>);
    }
    const mask = MASKS[channel];
    if (!mask || result === null || typeof result !== "object") return result;
    return mask(result as Record<string, unknown>);
}
