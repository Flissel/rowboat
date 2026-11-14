// Modified for VibeMind (Flissel/rowboat vibemind): new test file (Konzept-Fläche Teil B, Task 7).
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UEBERGABE_HINWEIS } from "@x/shared/dist/strenge-freigabe.js";
import { RealStrengeFreigabe, strengerAufruf } from "./strenge-freigabe.js";

const BESCHREIBUNG = "Übergibt ein Videokonzept als Auftrag an die Video-Werkbank des Ladens Ivan.";

export function videoKonzeptHtml(opts: { szenen?: number; auftrag?: string | null; art?: string } = {}): string {
    const szenen = Array.from({ length: opts.szenen ?? 9 }, (_, i) => ({ kurz: `Szene ${i + 1}`, bildart: "slide" }));
    const daten = {
        art: opts.art ?? "videokonzept",
        bezuege: [],
        video: {
            thema: "KI im Alltag",
            zielgruppe: "Inhaber",
            minuten: 4,
            hook: "Der Einstieg",
            kernaussage: "Die Aussage",
            stufen: [
                { name: "Einstieg", szenen: szenen.slice(0, 4) },
                { name: "Hauptteil", szenen: szenen.slice(4) },
            ],
            abschluss: "Der naechste Schritt",
            auftrag: opts.auftrag ?? null,
        },
    };
    return `<!doctype html><title>t</title><script type="application/json" id="rowboat-konzept">${JSON.stringify(daten)}</script><p>Seite</p>`;
}

describe("strengerAufruf (Identität, über die die Laufzeit routet)", () => {
    it("executeMcpTool: Server und Werkzeug aus der Eingabe, Argumente aus arguments", () => {
        expect(
            strengerAufruf("builtin:executeMcpTool", {
                serverName: "rowboat-auftraege",
                toolName: "video_auftrag_aus_konzept",
                arguments: { pfad: "knowledge/Konzepte/a.html", stand: "x" },
            }),
        ).toEqual({
            serverName: "rowboat-auftraege",
            toolName: "video_auftrag_aus_konzept",
            args: { pfad: "knowledge/Konzepte/a.html", stand: "x" },
        });
        expect(strengerAufruf("builtin:executeMcpTool", { serverName: "github", toolName: "create_issue" })).toBeNull();
    });

    it("mcp:<server>:<werkzeug>: getrennt am ersten Doppelpunkt wie RealToolRegistry", () => {
        expect(strengerAufruf("mcp:rowboat-auftraege:video_auftrag_aus_konzept", { pfad: "p" })).toEqual({
            serverName: "rowboat-auftraege",
            toolName: "video_auftrag_aus_konzept",
            args: { pfad: "p" },
        });
        expect(strengerAufruf("mcp:wissen:wissen_suchen", {})).toBeNull();
        expect(strengerAufruf("mcp:kaputt", {})).toBeNull();
    });

    it("derselbe Dienst unter anderem Namen bleibt streng (beide Wege)", () => {
        expect(strengerAufruf("mcp:auftraege-2:video_auftrag_aus_konzept", {})?.serverName).toBe("auftraege-2");
        expect(
            strengerAufruf("builtin:executeMcpTool", { serverName: "x", toolName: "VIDEO-AUFTRAG-AUS-KONZEPT" })?.toolName,
        ).toBe("VIDEO-AUFTRAG-AUS-KONZEPT");
    });

    it("andere Builtins und Fremdformen sind nie streng", () => {
        expect(strengerAufruf("builtin:fetch-url", { url: "http://127.0.0.1:8156/mcp" })).toBeNull();
        expect(strengerAufruf("builtin:listMcpTools", { serverName: "rowboat-auftraege" })).toBeNull();
        expect(strengerAufruf("tool.echo", { toolName: "video_auftrag_aus_konzept" })).toBeNull();
        expect(strengerAufruf("builtin:executeMcpTool", null)).toBeNull();
    });
});

describe("RealStrengeFreigabe.anfrage (liest die Datei selbst)", () => {
    let root: string;
    let gelesen: string[];
    const aufruf = (pfad: unknown) => ({
        serverName: "rowboat-auftraege",
        toolName: "video_auftrag_aus_konzept",
        args: pfad === undefined ? {} : { pfad },
    });
    const freigabe = (beschreibung: () => Promise<string | undefined> = async () => BESCHREIBUNG) =>
        new RealStrengeFreigabe({
            workDir: () => root,
            beschreibung: async () => {
                gelesen.push("beschreibung");
                return beschreibung();
            },
            aufrufen: async () => {
                throw new Error("must not be called");
            },
        });

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "strenge-freigabe-"));
        await fs.mkdir(path.join(root, "knowledge", "Konzepte"), { recursive: true });
        await fs.mkdir(path.join(root, "knowledge", "Kanal"), { recursive: true });
        gelesen = [];
    });
    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    it("gültiges Konzept: Übergabe mit Anzeige, sha256 der Bytes, Ziel und Hinweis", async () => {
        const html = videoKonzeptHtml();
        await fs.writeFile(path.join(root, "knowledge", "Konzepte", "Herbst.html"), html, "utf8");
        const res = await freigabe().anfrage(aufruf("knowledge/Konzepte/Herbst.html"));
        expect(res).toEqual({
            ok: true,
            request: {
                kind: "mcp",
                serverName: "rowboat-auftraege",
                toolName: "video_auftrag_aus_konzept",
                uebergabe: {
                    pfad: "knowledge/Konzepte/Herbst.html",
                    thema: "KI im Alltag",
                    minuten: 4,
                    stufen: 2,
                    szenen: 9,
                    auftrag: null,
                    stand: createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex"),
                    ziel: BESCHREIBUNG,
                    hinweis: UEBERGABE_HINWEIS,
                },
            },
        });
    });

    it("vorhandener Auftrag steht in der Übergabe", async () => {
        await fs.writeFile(path.join(root, "knowledge", "Konzepte", "a.html"), videoKonzeptHtml({ auftrag: "0a1b2c3d" }));
        const res = await freigabe().anfrage(aufruf("knowledge/Konzepte/a.html"));
        expect(res.ok && (res.request as { uebergabe: { auftrag: string } }).uebergabe.auftrag).toBe("0a1b2c3d");
    });

    it("fehlende, ungültige oder zu große Dateien: Absage mit dem Fehlersatz", async () => {
        const k = (name: string) => path.join(root, "knowledge", "Konzepte", name);
        await fs.writeFile(k("kurz.html"), videoKonzeptHtml({ szenen: 6 }));
        await fs.writeFile(k("leer.html"), "<p>kein Block</p>");
        await fs.writeFile(k("allgemein.html"), videoKonzeptHtml({ art: "konzept" }));
        await fs.writeFile(k("gross.html"), videoKonzeptHtml() + " ".repeat(1_048_577));
        const f = freigabe();
        expect(await f.anfrage(aufruf("knowledge/Konzepte/fehlt.html"))).toEqual({
            ok: false,
            fehler: "Die Konzeptdatei gibt es nicht.",
        });
        expect(await f.anfrage(aufruf("knowledge/Konzepte/kurz.html"))).toEqual({
            ok: false,
            fehler: "Es sind insgesamt 8 bis 15 Szenen nötig, gefunden wurden 6.",
        });
        expect(await f.anfrage(aufruf("knowledge/Konzepte/leer.html"))).toEqual({
            ok: false,
            fehler: "Die Datei enthält kein Videokonzept.",
        });
        expect(await f.anfrage(aufruf("knowledge/Konzepte/allgemein.html"))).toEqual({
            ok: false,
            fehler: "Die Datei enthält kein Videokonzept.",
        });
        expect(await f.anfrage(aufruf("knowledge/Konzepte/gross.html"))).toEqual({
            ok: false,
            fehler: "Die Konzeptdatei ist größer als 1 MB.",
        });
        expect(await f.anfrage(aufruf("knowledge/Konzepte"))).toEqual({
            ok: false,
            fehler: "Übergeben lassen sich nur Konzepte unter knowledge/Konzepte/ als HTML-Datei.",
        });
        expect(gelesen).toEqual([]);
    });

    it("Pfad aus dem Kanal oder außerhalb: Absage ohne Dateizugriff", async () => {
        await fs.writeFile(path.join(root, "knowledge", "Kanal", "x.html"), videoKonzeptHtml());
        const f = freigabe();
        expect(await f.anfrage(aufruf("knowledge/Kanal/x.html"))).toEqual({
            ok: false,
            fehler: "Aus knowledge/Kanal/ wird nichts übergeben.",
        });
        expect(await f.anfrage(aufruf("knowledge/Konzepte/../Kanal/x.html"))).toEqual({
            ok: false,
            fehler: "Übergeben lassen sich nur Konzepte unter knowledge/Konzepte/ als HTML-Datei.",
        });
        expect(await f.anfrage(aufruf(undefined))).toEqual({
            ok: false,
            fehler: "Für die Übergabe fehlt der Pfad des Konzepts.",
        });
    });

    it("Symlink aus knowledge/Konzepte/ nach außen: Absage", async (ctx) => {
        await fs.writeFile(path.join(root, "knowledge", "Kanal", "x.html"), videoKonzeptHtml());
        try {
            await fs.symlink(
                path.join(root, "knowledge", "Kanal", "x.html"),
                path.join(root, "knowledge", "Konzepte", "link.html"),
                "file",
            );
        } catch {
            ctx.skip(); // Windows ohne Symlink-Recht
        }
        expect(await freigabe().anfrage(aufruf("knowledge/Konzepte/link.html"))).toEqual({
            ok: false,
            fehler: "Übergeben lassen sich nur Konzepte unter knowledge/Konzepte/ als HTML-Datei.",
        });
    });

    it("Beschreibung nicht lesbar oder Werkzeug unbekannt: Absage", async () => {
        await fs.writeFile(path.join(root, "knowledge", "Konzepte", "a.html"), videoKonzeptHtml());
        expect(
            await freigabe(async () => {
                throw new Error("ECONNREFUSED");
            }).anfrage(aufruf("knowledge/Konzepte/a.html")),
        ).toEqual({ ok: false, fehler: "Die Annahme ist gerade nicht erreichbar. Es wurde nichts übergeben." });
        expect(await freigabe(async () => undefined).anfrage(aufruf("knowledge/Konzepte/a.html"))).toEqual({
            ok: false,
            fehler: "Das Werkzeug für die Übergabe ist nicht eingerichtet.",
        });
    });

    it("Ziel ist schlichter Text mit Grenze", async () => {
        await fs.writeFile(path.join(root, "knowledge", "Konzepte", "a.html"), videoKonzeptHtml());
        const res = await freigabe(async () => `<b>Laden</b>\n${"x".repeat(900)}`).anfrage(
            aufruf("knowledge/Konzepte/a.html"),
        );
        const ziel = res.ok ? (res.request as { uebergabe: { ziel: string } }).uebergabe.ziel : "";
        expect(ziel.startsWith("<b>Laden</b> x")).toBe(true);
        expect(ziel.length).toBe(500);
    });
});

describe("RealStrengeFreigabe.ausfuehren", () => {
    const uebergabe = {
        pfad: "knowledge/Konzepte/a.html",
        thema: "t",
        minuten: 4,
        stufen: 2,
        szenen: 9,
        auftrag: null,
        stand: "b".repeat(64),
        ziel: "z",
        hinweis: UEBERGABE_HINWEIS,
    };

    it("ruft genau mit pfad und stand aus der Rückfrage auf", async () => {
        const aufrufe: unknown[] = [];
        const f = new RealStrengeFreigabe({
            workDir: () => "unused",
            beschreibung: async () => BESCHREIBUNG,
            aufrufen: async (server, werkzeug, args) => {
                aufrufe.push({ server, werkzeug, args });
                return { content: [{ type: "text", text: '{"auftrag":"0a1b2c3d"}' }] };
            },
        });
        const res = await f.ausfuehren(
            { serverName: "rowboat-auftraege", toolName: "video_auftrag_aus_konzept" },
            uebergabe,
            new AbortController().signal,
        );
        expect(aufrufe).toEqual([
            {
                server: "rowboat-auftraege",
                werkzeug: "video_auftrag_aus_konzept",
                args: { pfad: "knowledge/Konzepte/a.html", stand: "b".repeat(64) },
            },
        ]);
        expect(res).toEqual({
            output: {
                success: true,
                serverName: "rowboat-auftraege",
                toolName: "video_auftrag_aus_konzept",
                result: { content: [{ type: "text", text: '{"auftrag":"0a1b2c3d"}' }] },
            },
            isError: false,
        });
    });

    it("Fehler des Aufrufs werden zu einem Fehlerergebnis", async () => {
        const f = new RealStrengeFreigabe({
            workDir: () => "unused",
            beschreibung: async () => BESCHREIBUNG,
            aufrufen: async () => {
                throw new Error("boom");
            },
        });
        const res = await f.ausfuehren(
            { serverName: "rowboat-auftraege", toolName: "video_auftrag_aus_konzept" },
            uebergabe,
            new AbortController().signal,
        );
        expect(res).toEqual({ output: { success: false, error: "boom" }, isError: true });
    });
});
