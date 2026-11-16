// Modified for VibeMind (Flissel/rowboat vibemind): trust on boot for mcp.json stdio entries and security.json (ticket #330, Task 17).
import container from "../di/container.js";
import type { IModelConfigRepo } from "../models/repo.js";
import type { IMcpConfigRepo } from "../mcp/repo.js";
import type { IAgentScheduleRepo } from "../agent-schedule/repo.js";
import type { IAgentScheduleStateRepo } from "../agent-schedule/state-repo.js";
import { approveAllFromConfig } from "../mcp/stdio-approvals.js";
import { ensureSecurityConfig, reloadSecurityConfig } from "./security.js";

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
async function trustConfigsOnBoot(mcpConfigRepo: IMcpConfigRepo): Promise<void> {
    try {
        approveAllFromConfig(await mcpConfigRepo.getConfig());
    } catch (error) {
        console.warn(`[config] mcp.json could not be read at startup; no stdio MCP server is approved: ${error instanceof Error ? error.message : String(error)}`);
    }
    reloadSecurityConfig();
}
