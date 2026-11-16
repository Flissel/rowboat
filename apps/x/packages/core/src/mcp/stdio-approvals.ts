// Modified for VibeMind (Flissel/rowboat vibemind): new module (ticket #330,
// part 2, Task 17). The stdio MCP entries a human approved in this process
// lifetime. getClient (mcp.ts) starts the `command` of a stdio entry only when
// its exact (name, command, args, env) is in this set, so an entry that got
// into config/mcp.json any other way (a shell command, another program)
// starts no process.
// Filled by:
//   - initConfigs at startup, from the file as it is then (trust on boot;
//     a hand edit takes effect after a restart),
//   - the human write paths (Settings / workspace:* handlers of apps/main and
//     apps/server, human-config-writes.ts),
//   - addMcpServer, only when the call was approved by a human.
// URL entries are not gated here.

import crypto from "node:crypto";
import type z from "zod";
import type { McpServerConfig, StdioMcpServerConfig } from "@x/shared/dist/mcp.js";

export type StdioEntry = Pick<z.infer<typeof StdioMcpServerConfig>, "command" | "args" | "env">;

const approved = new Set<string>();

// Stable serialisation: env as key-sorted pairs (key order does not matter),
// an absent args/env distinct from an empty one (fails closed).
function entryKey(name: string, entry: StdioEntry): string {
    const env = entry.env === undefined
        ? null
        : Object.keys(entry.env).sort().map((key) => [key, entry.env![key]]);
    const payload = JSON.stringify([name, entry.command, entry.args ?? null, env]);
    return crypto.createHash("sha256").update(payload).digest("hex");
}

export function approveStdioEntry(name: string, entry: StdioEntry): void {
    approved.add(entryKey(name, entry));
}

export function isStdioEntryApproved(name: string, entry: StdioEntry): boolean {
    return approved.has(entryKey(name, entry));
}

// Approves every stdio entry of a parsed mcp.json (URL entries are skipped).
export function approveAllFromConfig(config: z.infer<typeof McpServerConfig>): void {
    for (const [name, entry] of Object.entries(config.mcpServers)) {
        if ("command" in entry) approveStdioEntry(name, entry);
    }
}

// Tests only.
export function resetStdioApprovalsForTests(): void {
    approved.clear();
}
