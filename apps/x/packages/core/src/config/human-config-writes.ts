// Modified for VibeMind (Flissel/rowboat vibemind): new module (ticket #330,
// part 2, Task 17). The human write paths into the workspace (the Settings
// dialog and every other workspace:* call of apps/main ipc.ts and apps/server
// core-deps.ts) call this after a successful write, rename, copy or remove.
// When the written path is config/mcp.json or config/security.json (or a
// folder that contains it), the consumers take the new content now:
//   - mcp.json: its stdio entries are approved (stdio-approvals.ts),
//   - security.json: the live allow-lists are replaced (security.ts).
// With `written` (workspace:writeFile) the content the human wrote is used,
// not a re-read of the file, so a raw write racing the save is not approved.
// Every other path changes nothing.

import fs from "node:fs/promises";
import path from "node:path";
import { McpServerConfig } from "@x/shared/dist/mcp.js";
import { approveAllFromConfig } from "../mcp/stdio-approvals.js";
import { WorkDir } from "./config.js";
import { reloadSecurityConfig, SECURITY_CONFIG_PATH } from "./security.js";

const MCP_CONFIG_PATH = path.join(WorkDir, "config", "mcp.json");

export interface HumanWrittenContent {
    data: string;
    // workspace:writeFile's encoding: "utf8" (default), "base64" or "binary" (base64 data).
    encoding?: string;
}

// Windows compares case-insensitively and ignores trailing dots and spaces
// in a name; elsewhere the path is compared as is.
function canonical(p: string): string {
    const resolved = path.resolve(p);
    if (process.platform !== "win32") return resolved;
    return resolved
        .split(path.sep)
        .map((segment, i) => (i === 0 ? segment : segment.replace(/[. ]+$/, "")))
        .join(path.sep)
        .toLowerCase();
}

// "exact": the target is the file; "container": a folder that holds it.
function touches(target: string, file: string): "exact" | "container" | null {
    if (target === file) return "exact";
    const prefix = target.endsWith(path.sep) ? target : target + path.sep;
    return file.startsWith(prefix) ? "container" : null;
}

function decode(written: HumanWrittenContent): string {
    const encoding = written.encoding ?? "utf8";
    return encoding === "utf8" ? written.data : Buffer.from(written.data, "base64").toString("utf8");
}

async function readOrNull(file: string): Promise<string | null> {
    try {
        return await fs.readFile(file, "utf8");
    } catch {
        return null;
    }
}

// Invalid content approves nothing (getClient cannot parse it either).
function approveMcpContent(content: string | null): void {
    if (content === null) return;
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return;
    }
    const config = McpServerConfig.safeParse(parsed);
    if (config.success) approveAllFromConfig(config.data);
}

export async function afterHumanWorkspaceWrite(relPath: string, written?: HumanWrittenContent): Promise<void> {
    const target = canonical(path.resolve(WorkDir, relPath));

    const mcp = touches(target, canonical(MCP_CONFIG_PATH));
    if (mcp) {
        approveMcpContent(mcp === "exact" && written ? decode(written) : await readOrNull(MCP_CONFIG_PATH));
    }

    const security = touches(target, canonical(SECURITY_CONFIG_PATH));
    if (security) {
        reloadSecurityConfig(security === "exact" && written ? decode(written) : undefined);
    }
}
