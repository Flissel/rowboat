import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkVideoKonzept, readKonzept } from './konzept.js'

/**
 * Gemeinsame Prüffälle für `readKonzept` + `checkVideoKonzept` (Fork) und den Python-Nachbau im MCP-Dienst
 * `rowboat-auftraege` (`konzept_lesen.lesen` / `video_pruefen`). Die Datei ist hier AUTORITATIV: die erwarteten Werte
 * sind die eingefrorenen Ergebnisse der echten Funktionen; dieser Test hält sie fest, die Python-Seite wird daran
 * gemessen.
 *
 * Fall: `{ name, html, gueltig, fehler_enthaelt?, video? }`.
 * - `gueltig`: readKonzept liefert `daten` (Hinweise in `fehler` zählen nicht) UND checkVideoKonzept(daten.video) meldet
 *   nichts. Bei `art: "konzept"` ohne `video` ist `daten.video` undefined; checkVideoKonzept meldet dann
 *   „Das Videokonzept fehlt …".
 * - `video`: das Objekt aus readKonzept, unverändert (Leerraum nicht getrimmt, unbekannte Felder bleiben).
 * - `fehler_enthaelt`: Teilsatz des ERSTEN Fehlersatzes (bei `daten === null` der Satz von readKonzept, sonst der erste
 *   von checkVideoKonzept). Fehlt er bei `gueltig: false`, gibt es keinen Satz (Datei ohne Datenblock).
 * - Längen zählen in UTF-16-Einheiten (JavaScript `String.length`), nicht in Codepoints; `thema` und die Textfelder
 *   werden für das Minimum getrimmt (JavaScript `trim`), das Maximum zählt roh.
 */
type Fall = { name: string; html: string; gueltig: boolean; fehler_enthaelt?: string; video?: unknown }

const DATEI = fileURLToPath(new URL('./__fixtures__/konzept_vektoren.json', import.meta.url))
const faelle = JSON.parse(readFileSync(DATEI, 'utf8')) as Fall[]

describe('konzept_vektoren.json', () => {
  it('hat Fälle, eindeutige Namen und ein Namensschema, das zur Erwartung passt', () => {
    expect(faelle.length).toBeGreaterThanOrEqual(100)
    expect(new Set(faelle.map((f) => f.name)).size).toBe(faelle.length)
    for (const f of faelle) {
      expect(f.name.startsWith(f.gueltig ? 'gueltig_' : 'ungueltig_'), f.name).toBe(true)
      expect(Object.keys(f).every((k) => ['name', 'html', 'gueltig', 'fehler_enthaelt', 'video'].includes(k)), f.name).toBe(true)
      expect('video' in f, f.name).toBe(f.gueltig)
      expect('fehler_enthaelt' in f && f.gueltig, f.name).toBe(false)
    }
  })

  it('deckt die Grenzen der Aufgabe ab', () => {
    const namen = faelle.map((f) => f.name)
    for (const muss of [
      'gueltig_8_szenen', 'gueltig_15_szenen', 'ungueltig_7_szenen', 'ungueltig_16_szenen', 'ungueltig_minuten_6',
      'ungueltig_9_stufen_9_szenen', 'ungueltig_kurz_301_zeichen', 'gueltig_kurz_300_zeichen', 'ungueltig_bildart_unbekannt',
      'ungueltig_block_20001_zeichen', 'gueltig_block_genau_20000_zeichen', 'gueltig_zwei_bloecke_der_erste_gilt',
      'ungueltig_kaputtes_json_abgeschnitten', 'ungueltig_art_konzept_ohne_video', 'gueltig_auftrag_8_hex', 'ungueltig_auftrag_xyz',
    ]) expect(namen, muss).toContain(muss)
  })

  for (const f of faelle) {
    it(f.name, () => {
      const r = readKonzept(f.html)
      const fehler = r.daten === null ? r.fehler : checkVideoKonzept(r.daten.video)
      expect(r.daten !== null && fehler.length === 0).toBe(f.gueltig)
      if (f.gueltig) {
        expect(r.daten?.video).toEqual(f.video)
      } else if (f.fehler_enthaelt !== undefined) {
        expect(fehler[0]).toContain(f.fehler_enthaelt)
      } else {
        expect(r.daten).toBeNull()
        expect(r.fehler).toEqual([])
      }
    })
  }
})
