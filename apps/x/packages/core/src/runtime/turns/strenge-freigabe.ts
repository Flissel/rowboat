// Modified for VibeMind (Flissel/rowboat vibemind): new file (Konzept-Fläche Teil B, Task 7).
//
// Strenges Ja: Die Turn-Laufzeit erkennt Aufrufe strenger MCP-Werkzeuge (siehe
// @x/shared strenge-freigabe), baut die Rückfrage selbst aus der Datei auf der
// Platte und ruft das Werkzeug nach einem Ja nur mit {pfad, stand} aus der
// Rückfrage auf – nie mit den Argumenten des Modells.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { checkVideoKonzept, KONZEPT_MAX_BYTES, konzeptUebergabeAnzeige, readKonzept } from "@x/shared/dist/konzept.js";
import {
    strengeFreigabe,
    UEBERGABE_HINWEIS,
    UEBERGABE_PFAD_AUSSERHALB,
    uebergabePfadFehler,
    uebergabeZiel,
    type KonzeptUebergabe,
} from "@x/shared/dist/strenge-freigabe.js";
import type { JsonValue, ToolResultData } from "@x/shared/dist/turns.js";

export interface StrengerAufruf {
    serverName: string;
    toolName: string;
    args: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Ist dieser Werkzeugaufruf ein strenger MCP-Aufruf? Erkennt beide Wege, über die die Laufzeit ein MCP-Werkzeug
 * erreicht: das Builtin `executeMcpTool` (Server/Werkzeug in der Eingabe) und angehängte Werkzeuge
 * `mcp:<server>:<werkzeug>` (getrennt am ersten Doppelpunkt wie RealToolRegistry).
 */
export function strengerAufruf(toolId: string, input: unknown): StrengerAufruf | null {
    if (toolId === "builtin:executeMcpTool") {
        if (!isRecord(input)) return null;
        const { serverName, toolName } = input;
        if (typeof toolName !== "string") return null;
        const server = typeof serverName === "string" ? serverName : "";
        if (!strengeFreigabe(server, toolName)) return null;
        return { serverName: server, toolName, args: isRecord(input.arguments) ? input.arguments : {} };
    }
    if (toolId.startsWith("mcp:")) {
        const rest = toolId.slice("mcp:".length);
        const sep = rest.indexOf(":");
        if (sep <= 0 || sep === rest.length - 1) return null;
        const serverName = rest.slice(0, sep);
        const toolName = rest.slice(sep + 1);
        if (!strengeFreigabe(serverName, toolName)) return null;
        return { serverName, toolName, args: isRecord(input) ? input : {} };
    }
    return null;
}

export type StrengeAnfrage = { ok: true; request: JsonValue } | { ok: false; fehler: string };

export interface IStrengeFreigabe {
    /** Baut die Rückfrage aus der Datei auf der Platte; bei einem Fehler nur der Satz für das Modell (keine Karte). */
    anfrage(aufruf: StrengerAufruf): Promise<StrengeAnfrage>;
    /** Ruft das Werkzeug nach dem Ja eines Menschen mit genau `{pfad, stand}` aus der Rückfrage auf. */
    ausfuehren(
        aufruf: { serverName: string; toolName: string },
        uebergabe: KonzeptUebergabe,
        signal: AbortSignal,
    ): Promise<z.infer<typeof ToolResultData>>;
}

export interface StrengeFreigabeDeps {
    workDir: () => string | Promise<string>;
    /** Beschreibung des Werkzeugs, wie der Dienst sie liefert; `undefined`, wenn er es nicht anbietet. */
    beschreibung: (serverName: string, toolName: string) => Promise<string | undefined>;
    /** Aufruf am Freigabe-Tor in mcp.ts vorbei – nur für diesen Weg. */
    aufrufen: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

const FEHLT = "Die Konzeptdatei gibt es nicht.";
const ZU_GROSS = "Die Konzeptdatei ist größer als 1 MB.";
const KEIN_VIDEOKONZEPT = "Die Datei enthält kein Videokonzept.";
const NICHT_ERREICHBAR = "Die Annahme ist gerade nicht erreichbar. Es wurde nichts übergeben.";
const NICHT_EINGERICHTET = "Das Werkzeug für die Übergabe ist nicht eingerichtet.";

function innerhalb(basis: string, ziel: string): boolean {
    const rel = path.relative(basis, ziel);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function beschreibungAusDienst(serverName: string, toolName: string): Promise<string | undefined> {
    // Spät laden: mcp.ts zieht den DI-Container nach (Zyklus beim Aufbau).
    const { listTools } = await import("../../mcp/mcp.js");
    let cursor: string | undefined;
    for (let seite = 0; seite < 20; seite++) {
        const { tools, nextCursor } = await listTools(serverName, cursor);
        const treffer = tools.find((t) => t.name === toolName);
        if (treffer) return typeof treffer.description === "string" ? treffer.description : "";
        if (!nextCursor) return undefined;
        cursor = nextCursor;
    }
    return undefined;
}

export class RealStrengeFreigabe implements IStrengeFreigabe {
    private readonly deps: StrengeFreigabeDeps;

    constructor(deps?: Partial<StrengeFreigabeDeps>) {
        this.deps = {
            // Spät geladen: config.ts legt beim Import Ordner an.
            workDir: deps?.workDir ?? (async () => (await import("../../config/config.js")).WorkDir),
            beschreibung: deps?.beschreibung ?? beschreibungAusDienst,
            aufrufen:
                deps?.aufrufen ??
                (async (server, werkzeug, args) => {
                    const { executeToolNachFreigabe } = await import("../../mcp/mcp.js");
                    return executeToolNachFreigabe(server, werkzeug, args);
                }),
        };
    }

    async anfrage(aufruf: StrengerAufruf): Promise<StrengeAnfrage> {
        const pfad = aufruf.args.pfad;
        const formFehler = uebergabePfadFehler(pfad);
        if (formFehler !== null || typeof pfad !== "string") {
            return { ok: false, fehler: formFehler ?? UEBERGABE_PFAD_AUSSERHALB };
        }

        const root = await this.deps.workDir();
        let basis: string;
        let datei: string;
        try {
            basis = await fs.realpath(path.join(root, "knowledge", "Konzepte"));
            datei = await fs.realpath(path.join(root, ...pfad.replace(/\\/g, "/").split("/").filter((s) => s !== "")));
        } catch {
            return { ok: false, fehler: FEHLT };
        }
        if (!innerhalb(basis, datei)) return { ok: false, fehler: UEBERGABE_PFAD_AUSSERHALB };

        // Genau einmal lesen: Prüfung, Anzeige und Stand beziehen sich auf dieselben Bytes.
        let bytes: Buffer;
        try {
            const handle = await fs.open(datei, "r");
            try {
                const stat = await handle.stat();
                if (!stat.isFile()) return { ok: false, fehler: FEHLT };
                const puffer = Buffer.alloc(KONZEPT_MAX_BYTES + 1);
                let gelesen = 0;
                while (gelesen < puffer.length) {
                    const { bytesRead } = await handle.read(puffer, gelesen, puffer.length - gelesen, gelesen);
                    if (bytesRead === 0) break;
                    gelesen += bytesRead;
                }
                if (gelesen > KONZEPT_MAX_BYTES) return { ok: false, fehler: ZU_GROSS };
                bytes = puffer.subarray(0, gelesen);
            } finally {
                await handle.close();
            }
        } catch {
            return { ok: false, fehler: FEHLT };
        }

        const stand = createHash("sha256").update(bytes).digest("hex");
        const { daten, fehler } = readKonzept(bytes.toString("utf8"));
        if (daten === null) return { ok: false, fehler: fehler[0] ?? KEIN_VIDEOKONZEPT };
        if (daten.art !== "videokonzept" || daten.video === undefined) return { ok: false, fehler: KEIN_VIDEOKONZEPT };
        const pruefung = checkVideoKonzept(daten.video);
        if (pruefung.length > 0) return { ok: false, fehler: pruefung.join(" ") };
        const anzeige = konzeptUebergabeAnzeige(daten, pfad);

        let beschreibung: string | undefined;
        try {
            beschreibung = await this.deps.beschreibung(aufruf.serverName, aufruf.toolName);
        } catch {
            return { ok: false, fehler: NICHT_ERREICHBAR };
        }
        if (beschreibung === undefined) return { ok: false, fehler: NICHT_EINGERICHTET };

        const uebergabe: KonzeptUebergabe = {
            pfad,
            thema: anzeige.thema,
            minuten: anzeige.minuten,
            stufen: anzeige.stufen,
            szenen: anzeige.szenen,
            auftrag: anzeige.auftrag,
            stand,
            ziel: uebergabeZiel(beschreibung),
            hinweis: UEBERGABE_HINWEIS,
        };
        return {
            ok: true,
            request: { kind: "mcp", serverName: aufruf.serverName, toolName: aufruf.toolName, uebergabe },
        };
    }

    async ausfuehren(
        aufruf: { serverName: string; toolName: string },
        uebergabe: KonzeptUebergabe,
        signal: AbortSignal,
    ): Promise<z.infer<typeof ToolResultData>> {
        if (signal.aborted) return { output: { success: false, error: "Abgebrochen." }, isError: true };
        try {
            const result = await this.deps.aufrufen(aufruf.serverName, aufruf.toolName, {
                pfad: uebergabe.pfad,
                stand: uebergabe.stand,
            });
            const json = JSON.parse(JSON.stringify(result ?? null)) as JsonValue;
            return {
                output: { success: true, serverName: aufruf.serverName, toolName: aufruf.toolName, result: json },
                isError: isRecord(result) && result.isError === true,
            };
        } catch (error) {
            return {
                output: { success: false, error: error instanceof Error ? error.message : String(error) },
                isError: true,
            };
        }
    }
}
