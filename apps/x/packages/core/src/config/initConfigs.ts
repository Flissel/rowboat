// Modified for VibeMind (Flissel/rowboat vibemind): trust on boot for mcp.json stdio entries and security.json (ticket #330, Task 17).
import container from "../di/container.js";
import type { IModelConfigRepo } from "../models/repo.js";
import type { IMcpConfigRepo } from "../mcp/repo.js";
import type { IAgentScheduleRepo } from "../agent-schedule/repo.js";
import type { IAgentScheduleStateRepo } from "../agent-schedule/state-repo.js";
import { approveAllFromConfig } from "../mcp/stdio-approvals.js";
import { ensureSecurityConfig, getSecurityAllowList, reloadSecurityConfig } from "./security.js";

/**
 * Initialize all config files at app startup.
 * Ensures config files exist before the UI might access them.
 */
export async function initConfigs(): Promise<void> {
    // Resolve repos and explicitly call their ensureConfig methods
    const modelConfigRepo = container.resolve<IModelConfigRepo>("modelConfigRepo");
    const mcpConfigRepo = container.resolve<IMcpConfigRepo>("mcpConfigRepo");
    const agentScheduleRepo = container.resolve<IAgentScheduleRepo>("agentScheduleRepo");
    const agentScheduleStateRepo = container.resolve<IAgentScheduleStateRepo>("agentScheduleStateRepo");

    await Promise.all([
        modelConfigRepo.ensureConfig(),
        mcpConfigRepo.ensureConfig(),
        agentScheduleRepo.ensureConfig(),
        agentScheduleStateRepo.ensureState(),
        ensureSecurityConfig(),
    ]);

    await trustConfigsOnBoot(mcpConfigRepo);
}

// Trust on boot (ticket #330, Task 17): what config/mcp.json and
// config/security.json hold at startup is approved — the stdio entries may
// start their process, the allow-lists are loaded once. A later change to the
// files takes effect only through a human write path or after a restart
// (also on the headless server, where mcp.json is edited by hand and the
// container restarted). An unreadable mcp.json approves nothing.
// Fix round 1 (review m-5): logs what it approved — one line per stdio entry
// (server name and command basename only: args and env values can hold
// secrets) and one line with the number of allow-listed commands and whether
// "*" is among them. `log` is injectable for tests.
export async function trustConfigsOnBoot(
    mcpConfigRepo: IMcpConfigRepo,
    log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
    try {
        const config = await mcpConfigRepo.getConfig();
        approveAllFromConfig(config);
        for (const [name, entry] of Object.entries(config.mcpServers)) {
            if (!("command" in entry)) continue;
            const basename = entry.command.split(/[\\/]/).pop() || entry.command;
            log(`[config] trust on boot: stdio MCP server ${JSON.stringify(name)} approved (command ${basename})`);
        }
    } catch (error) {
        console.warn(`[config] mcp.json could not be read at startup; no stdio MCP server is approved: ${error instanceof Error ? error.message : String(error)}`);
    }
    reloadSecurityConfig();
    const commands = getSecurityAllowList();
    const star = commands.includes("*") ? "\"*\" present (unrestricted shell)" : "\"*\" not present";
    log(`[config] trust on boot: ${commands.length} allow-listed commands, ${star}`);
}
