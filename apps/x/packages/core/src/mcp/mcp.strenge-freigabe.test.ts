// Modified for VibeMind (Flissel/rowboat vibemind): new test file (Konzept-Fläche Teil B, Task 7).
import { beforeEach, describe, expect, it, vi } from "vitest";

const getConfig = vi.fn(async () => ({ mcpServers: {} }));
vi.mock("../di/container.js", () => ({
    default: { resolve: () => ({ getConfig }) },
}));
vi.mock("../spaces/orgs.js", () => ({ spacesMcpServers: async () => ({}) }));

const { executeTool, executeToolNachFreigabe } = await import("./mcp.js");

describe("executeTool: Tor für strenge Werkzeuge", () => {
    beforeEach(() => getConfig.mockClear());

    it("strenges Werkzeug auf jedem Server: Absage, ohne den Dienst auch nur nachzuschlagen", async () => {
        for (const [server, werkzeug] of [
            ["rowboat-auftraege", "video_auftrag_aus_konzept"],
            ["anderer-name", "video_auftrag_aus_konzept"],
            ["rowboat-auftraege", "Video-Auftrag-aus-Konzept"],
        ]) {
            await expect(executeTool(server, werkzeug, { pfad: "p", stand: "s" })).rejects.toThrow(
                "Die Übergabe braucht ein Ja von Felix in der App.",
            );
        }
        expect(getConfig).not.toHaveBeenCalled();
    });

    it("andere Werkzeuge nehmen den gewohnten Weg", async () => {
        await expect(executeTool("rowboat-auftraege", "auftrag_status", {})).rejects.toThrow(
            "MCP server rowboat-auftraege not found",
        );
        expect(getConfig).toHaveBeenCalledTimes(1);
    });

    it("executeToolNachFreigabe (nur nach dem Ja) geht am Tor vorbei", async () => {
        await expect(executeToolNachFreigabe("rowboat-auftraege", "video_auftrag_aus_konzept", {})).rejects.toThrow(
            "MCP server rowboat-auftraege not found",
        );
        expect(getConfig).toHaveBeenCalledTimes(1);
    });
});
