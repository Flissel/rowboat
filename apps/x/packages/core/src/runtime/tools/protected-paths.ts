// Modified for VibeMind (Flissel/rowboat vibemind): new module (ticket #330,
// part 1). Workspace entries whose content turns into process start or an
// unrestricted shell (config/mcp.json, config/security.json, ...) or that
// hold keys and channel credentials. An agent write to them needs a human:
//   - permission-metadata.ts turns such a call into a `humanOnly` request
//     (never classified, denied without a human, never persisted as a grant),
//   - execTool refuses it unless the turn runtime marks the call as approved
//     by a human (ToolContext.humanApproved).
// headless-sandbox.ts and channel-run-guard.ts build their own (longer)
// lists on top of this one.

import fs from "node:fs/promises";
import path from "node:path";
import { hasOutputRedirect, stripHarmlessRedirects } from "../../application/lib/command-executor.js";
import { WorkDir } from "../../config/config.js";
import { isPathInside, resolveFilePathForPermission } from "../../filesystem/files.js";
import { filePermissionTargets } from "../assembly/permission-metadata.js";

export const PROTECTED_WORKSPACE_ENTRIES: readonly string[] = [
    "config",
    "server-key",
    "cipher-key",
    "embed.json",
    ".electron-data",
    "channels",
];

// Windows ignores trailing dots and spaces in a name ("config." is
// "config") and compares case-insensitively; the check does both everywhere.
function normalizeName(name: string): string {
    return name.replace(/[. ]+$/, "").toLowerCase();
}

export function isProtectedEntryName(name: string): boolean {
    const normalized = normalizeName(name);
    return normalized.length > 0 && PROTECTED_WORKSPACE_ENTRIES.includes(normalized);
}

// A ":" after the drive letter is an NTFS stream ("server-key::$DATA",
// "config:x") or another device syntax: treated as protected.
function hasStreamSyntax(inputPath: string): boolean {
    const rest = /^[a-zA-Z]:/.test(inputPath) ? inputPath.slice(2) : inputPath;
    return rest.includes(":");
}

function protectedUnder(root: string, target: string): boolean {
    // The workspace itself or one of its ancestors: removing or moving it
    // takes the protected entries along.
    if (isPathInside(target, root)) return true;
    if (!isPathInside(root, target)) return false;
    const first = path.relative(root, target).split(path.sep)[0] ?? "";
    return isProtectedEntryName(first);
}

async function canonicalWorkspaceRoot(): Promise<string> {
    try {
        return await fs.realpath(WorkDir);
    } catch {
        return path.resolve(WorkDir);
    }
}

// True when the path (relative to the workspace root, or absolute) is a
// protected entry, lies inside one, or contains the workspace. Both the
// lexical path and the real path (symlinks / junctions resolved where the
// target exists) are checked.
export async function isProtectedPath(inputPath: string): Promise<boolean> {
    if (hasStreamSyntax(inputPath)) return true;
    const resolved = await resolveFilePathForPermission(inputPath);
    if (protectedUnder(path.resolve(WorkDir), resolved.resolvedPath)) return true;
    return protectedUnder(await canonicalWorkspaceRoot(), resolved.canonicalPath);
}

// cmd.exe drops "^", the shells drop quotes, bash drops "\" escapes: check
// the command both with and without backslashes, split at every shell and
// path separator.
const COMMAND_PIECE_SPLIT = /[\s/\\;&|<>()=,:*?$%!@{}[\]+]+/;

export function commandNamesProtectedEntry(command: string): boolean {
    const variants = [
        command.replace(/[\^"'`]/g, ""),
        command.replace(/[\^"'`\\]/g, ""),
    ];
    return variants.some((variant) =>
        variant.split(COMMAND_PIECE_SPLIT).some(isProtectedEntryName),
    );
}

// The only redirect target shape the text check accepts: one bare literal
// token. Quotes, variables (%X%, $X, !X!), wildcards, carets, backticks,
// parentheses, "+", "&" ... all fall outside it.
const LITERAL_REDIRECT_TARGET = /^[A-Za-z0-9._/\\-]+$/;
const REDIRECT_OPERATOR = />>?/g;

// Fail closed (controller ruling for #330): a command with an output
// redirect is for a human unless EVERY redirect target is a bare literal
// token that does not resolve into a protected entry (relative targets
// resolve against the command's cwd). The harmless targets (2>&1, nul,
// /dev/null) are removed first. A missing target or one starting with "-"
// counts as not literal. This text check is a second layer only; the
// consumers of config/ are hardened separately (Task 17).
export async function redirectNeedsHuman(command: string, cwd?: string): Promise<boolean> {
    if (!hasOutputRedirect(command)) return false;
    const rest = stripHarmlessRedirects(command);
    for (const match of rest.matchAll(REDIRECT_OPERATOR)) {
        const after = rest.slice((match.index ?? 0) + match[0].length);
        if (after.startsWith(">")) continue; // first half of ">>"
        const target = after.trimStart().split(/\s/)[0] ?? "";
        if (!LITERAL_REDIRECT_TARGET.test(target) || target.startsWith("-")) return true;
        const resolved = path.isAbsolute(target) || !cwd ? target : path.join(cwd, target);
        if (await isProtectedPath(resolved)) return true;
    }
    return false;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

// True when the tool call writes, moves, copies onto or removes a protected
// path, or (executeCommand) names a protected entry, runs inside one, or
// redirects output to anything but a literal, unprotected path.
export async function isProtectedWrite(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    if (toolName === "executeCommand") {
        const command = typeof args.command === "string" ? args.command : String(args.command ?? "");
        if (commandNamesProtectedEntry(command)) return true;
        const cwd = asString(args.cwd);
        if (cwd !== undefined && (await isProtectedPath(cwd))) return true;
        return redirectNeedsHuman(command, cwd);
    }
    if (toolName === "code_agent_run") {
        // The coding agent writes files itself: a cwd that is the workspace
        // (or contains it), a protected entry or a path inside one counts.
        // The cwd the run really uses (session pin, chip, default project)
        // is checked again in code.ts.
        const cwd = asString(args.cwd);
        return cwd !== undefined && (await isProtectedPath(cwd));
    }
    const targets = filePermissionTargets(toolName, args);
    if (!targets || (targets.operation !== "write" && targets.operation !== "delete")) {
        return false;
    }
    // file-copy only reads its source.
    const writePaths = toolName === "file-copy" ? targets.paths.slice(1) : targets.paths;
    for (const target of writePaths) {
        if (await isProtectedPath(target)) return true;
    }
    return false;
}
