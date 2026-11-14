// Strenges Ja (Konzept-Fläche Teil B, Aufgabe 7): Werkzeuge, die Rowboat nie ohne sichtbares Ja eines Menschen in
// der App ausführt – gleich in welcher Betriebsart. Reine Bausteine ohne Datei- oder Netzzugriff (Kern und Renderer).
import { z } from 'zod'

/**
 * Die strengen Werkzeuge. `server` ist der Name, unter dem der Dienst beim Ausrollen in `mcp.json` steht; entschieden
 * wird aber nach `werkzeug` (siehe {@link strengeFreigabe}).
 */
export const STRENGE_WERKZEUGE: ReadonlyArray<{ readonly server: string; readonly werkzeug: string }> = [
  { server: 'rowboat-auftraege', werkzeug: 'video_auftrag_aus_konzept' },
]

/** Hinweis der Rückfrage, wörtlich aus den Global Constraints des Plans. */
export const UEBERGABE_HINWEIS = 'Was im Konzept steht, geht an das Videomodell und kann im Video landen.'
/** Absage an das Modell: Lauf ohne Menschen, Kanal-Lauf, Agenten-Zugang. */
export const ABSAGE_OHNE_JA = 'Die Übergabe braucht ein Ja von Felix in der App.'
/** Antwort an das Modell, wenn der Mensch „Nein" sagt. */
export const ABSAGE_ABGELEHNT = 'Felix hat abgelehnt.'
/** Längste Beschreibung des Werkzeugs (`ziel`), die die Karte zeigt. */
export const UEBERGABE_ZIEL_MAX = 500

/** Werkzeugnamen ohne Groß/Klein und mit `-`, `.` und Leerraum wie `_` vergleichen. */
function werkzeugSchluessel(name: string): string {
  return name.trim().toLowerCase().replace(/[-.\s]+/g, '_')
}

/**
 * Gilt für diesen MCP-Aufruf das strenge Ja?
 *
 * Die Laufzeit leitet `executeMcpTool` und `mcp:<server>:<werkzeug>` über den Eintrag `serverName` in `mcp.json` an
 * einen Dienst weiter und schickt `toolName` unverändert mit (`core/src/mcp/mcp.ts` `executeTool`). Der Servername ist
 * also nur ein frei wählbarer Schlüssel: Ein zweiter Eintrag kann denselben Dienst unter anderem Namen ansprechen
 * (`addMcpServer`). Was der Dienst selbst ausführt, bestimmt allein der Werkzeugname. Deshalb entscheidet nur er –
 * auf jedem Server und auch in Schreibvarianten. Falsch-positiv heißt nur: ein Mensch wird gefragt.
 */
export function strengeFreigabe(_serverName: string, toolName: string): boolean {
  const schluessel = werkzeugSchluessel(toolName)
  return schluessel !== '' && STRENGE_WERKZEUGE.some((w) => werkzeugSchluessel(w.werkzeug) === schluessel)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Ist diese Freigabe-Anfrage (`tool_permission_required.request`) die eines strengen Werkzeugs? */
export function istStrengeAnfrage(request: unknown): boolean {
  if (!isRecord(request) || request.kind !== 'mcp' || typeof request.toolName !== 'string') return false
  return strengeFreigabe(typeof request.serverName === 'string' ? request.serverName : '', request.toolName)
}

/** Was die Rückfrage zeigt und womit die Laufzeit nach einem Ja aufruft. Von der Laufzeit aus der Datei berechnet. */
export const KonzeptUebergabe = z.object({
  pfad: z.string(),
  thema: z.string(),
  minuten: z.number(),
  stufen: z.number().int().nonnegative(),
  szenen: z.number().int().nonnegative(),
  auftrag: z.string().nullable(),
  /** sha256 (hex, klein) der Dateibytes beim Erzeugen der Rückfrage. */
  stand: z.string().regex(/^[0-9a-f]{64}$/),
  /** Beschreibung des Werkzeugs, wie der Dienst sie liefert (nennt den Laden), als schlichter Text. */
  ziel: z.string(),
  hinweis: z.string(),
})
export type KonzeptUebergabe = z.infer<typeof KonzeptUebergabe>

/** Satz für Pfade außerhalb von `knowledge/Konzepte/` (auch über einen Symlink). */
export const UEBERGABE_PFAD_AUSSERHALB = 'Übergeben lassen sich nur Konzepte unter knowledge/Konzepte/ als HTML-Datei.'
const PFAD_AUSSERHALB = UEBERGABE_PFAD_AUSSERHALB

/**
 * Prüft den Pfad, den das Modell für die Übergabe nennt (arbeitsverzeichnis-relativ). `null` = in Ordnung, sonst der
 * Satz für das Modell. Nur die Form; ob die Datei wirklich dort liegt (Symlinks), prüft der Kern beim Lesen.
 */
export function uebergabePfadFehler(pfad: unknown): string | null {
  if (typeof pfad !== 'string' || pfad.trim() === '') return 'Für die Übergabe fehlt der Pfad des Konzepts.'
  if (pfad.includes('\u0000') || /^[\\/]/.test(pfad) || /^[a-zA-Z]:/.test(pfad)) return PFAD_AUSSERHALB
  const segs = pfad.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) return PFAD_AUSSERHALB
  if (segs.length >= 2 && segs[0].toLowerCase() === 'knowledge' && segs[1].replace(/[. ]+$/, '').toLowerCase() === 'kanal') {
    return 'Aus knowledge/Kanal/ wird nichts übergeben.'
  }
  if (segs.length < 3 || segs[0] !== 'knowledge' || segs[1] !== 'Konzepte' || !/\.html$/i.test(segs[segs.length - 1])) {
    return PFAD_AUSSERHALB
  }
  return null
}

/** Beschreibung des Werkzeugs als schlichter, einzeiliger Text mit Längengrenze. */
export function uebergabeZiel(beschreibung: unknown): string {
  if (typeof beschreibung !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const text = beschreibung.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= UEBERGABE_ZIEL_MAX ? text : `${text.slice(0, UEBERGABE_ZIEL_MAX - 1)}…`
}

/** Herkunft „Agent": Nachrichten über den `rowboat-ui`-Zugang. Liegt auf `turn_created.config` bzw. `input_added`. */
export const HERKUNFT_AGENT = 'agent' as const
export const Herkunft = z.literal(HERKUNFT_AGENT)

/**
 * Kam der Lauf (oder eine in ihn nachgereichte Eingabe) von einem Agenten? Beides steht unveränderlich im Turn-Protokoll,
 * die Kennzeichnung haftet also für den ganzen Lauf.
 */
export function turnVonAgent(turn: {
  definition: { config: { herkunft?: string } }
  addedInputs: ReadonlyArray<{ event: { herkunft?: string } }>
}): boolean {
  return (
    turn.definition.config.herkunft === HERKUNFT_AGENT ||
    turn.addedInputs.some((a) => a.event.herkunft === HERKUNFT_AGENT)
  )
}
