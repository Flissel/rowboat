// Die Fläche (Konzept-HTML neben dem Chat): reine Entscheidungen ohne DOM, getestet in konzept-flaeche.test.ts.
import { konzept } from '@x/shared'

/** Änderungen am selben Pfad werden so lange gebündelt, bevor der Rahmen neu eingehängt wird. */
export const reloadDebounceMs = 300

const MAX_LINK_LENGTH = 2000
const MAX_NOTE_PATH_LENGTH = 1000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Pfad des Wissens-HTMLs, das ein abgeschlossener file-writeText/file-editText-Aufruf geschrieben hat; sonst null. */
export function konzeptPathFromTool(tool: { name: string; status: string; result?: unknown }): string | null {
  if (tool.name !== 'file-writeText' && tool.name !== 'file-editText') return null
  if (tool.status !== 'completed') return null
  if (!isRecord(tool.result)) return null
  const rel = tool.result.workspaceRelPath
  if (typeof rel !== 'string') return null
  if (!konzept.isKnowledgeHtmlPath(rel) || konzept.isKanalPath(rel)) return null
  return rel
}

/** Von selbst öffnen nur beim ersten Schreiben eines Pfads im Lauf und nur, wenn er nicht schon angezeigt wird. */
export function shouldAutoOpen(args: { path: string; openedThisRun: Set<string>; currentPath: string | null }): boolean {
  if (args.openedThisRun.has(args.path)) return false
  return args.currentPath !== args.path
}

/** Notiz-Anfrage der Seite: `{ type: 'rowboat:notiz-oeffnen', pfad }` mit einer Datei unter `knowledge/` (nicht Kanal), sonst null. */
export function noteOpenRequest(msg: unknown): string | null {
  if (!isRecord(msg) || msg.type !== 'rowboat:notiz-oeffnen') return null
  const raw = msg.pfad
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_NOTE_PATH_LENGTH) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(raw)) return null
  if (raw.startsWith('/') || raw.startsWith('\\')) return null
  const segs = raw.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) return null
  if (segs.length < 2 || segs[0] !== 'knowledge') return null
  if (segs.some((seg) => seg.startsWith('.'))) return null
  if (!/\.[A-Za-z0-9]{1,8}$/.test(segs[segs.length - 1])) return null
  const norm = segs.join('/')
  if (konzept.isKanalPath(norm)) return null
  return norm
}

/** Link-Anfrage der Seite: `{ type: 'rowboat:link-oeffnen', url }` mit http(s)-Adresse ohne Zugangsdaten, sonst null. */
export function linkOpenRequest(msg: unknown): string | null {
  if (!isRecord(msg) || msg.type !== 'rowboat:link-oeffnen') return null
  const raw = msg.url
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK_LENGTH) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username !== '' || u.password !== '') return null
  if (u.href.length > MAX_LINK_LENGTH) return null
  return u.href
}

/** Hinweise für den Streifen unter der Kopfzeile. Fremde Seiten ohne Datenblock: keine. `sizeBytes` = echte Dateigröße. */
export function konzeptHinweise(html: string, sizeBytes?: number): string[] {
  const { daten, fehler } = konzept.readKonzept(html)
  const hinweise = [...fehler]
  const hatBlock = daten !== null || fehler.length > 0
  if (daten?.art === 'videokonzept') hinweise.push(...konzept.checkVideoKonzept(daten.video))
  if (hatBlock && (sizeBytes ?? html.length) > konzept.KONZEPT_MAX_BYTES) {
    hinweise.push('Die Datei ist größer als 1 MB. Graph und Suche lesen nur den Anfang.')
  }
  return hinweise
}

/** Betrifft ein `workspace:didChange`-Ereignis diesen Pfad (Neuladen nötig)? Ohne Pfadliste (bulkChanged) im Zweifel ja. */
export function workspaceEventTouches(event: unknown, path: string): boolean {
  if (!isRecord(event)) return false
  switch (event.type) {
    case 'changed':
    case 'created':
      return event.path === path
    case 'moved':
      return event.to === path
    case 'bulkChanged':
      return !Array.isArray(event.paths) || event.paths.includes(path)
    default:
      return false
  }
}

/** Adresse mit Cache-Brecher; Version 0 lässt sie unverändert. */
export function cacheBustedUrl(url: string, version: number): string {
  if (version <= 0) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${version}`
}

/**
 * Eine offene Rückfrage der Seite (Bestätigung in der Kopfzeile): Web-Link oder Notiz. `id` ist je Anfrage
 * eindeutig, `at` (Date.now) der Zeitpunkt der Anfrage für die 10-s-Regel.
 */
export type PendingRequest = { id: number; kind: 'link' | 'note'; value: string; at: number }
export const pendingMaxAgeMs = 10_000
/** So lange bleibt "Öffnen" nach dem ersten gemalten Bild der Bestätigung gesperrt (gegen Zeitdruck-Klicks). */
export const confirmDelayMs = 700

/**
 * Zustandsübergänge der Rückfrage (Links und Notizen zusammen, eine offene Anfrage). Eine neue Anfrage ersetzt
 * die offene nur, wenn keine offen ist oder die offene älter als 10 s ist. Abbrechen, Öffnen und Zurücksetzen
 * (Neuladen, Ansicht verborgen) leeren sie.
 */
export function nextPendingRequest(
  state: PendingRequest | null,
  event:
    | { type: 'request'; id: number; kind: 'link' | 'note'; value: string; now: number }
    | { type: 'cancel' | 'open' | 'reset' },
): PendingRequest | null {
  if (event.type !== 'request') return null
  if (state === null || event.now - state.at > pendingMaxAgeMs) {
    return { id: event.id, kind: event.kind, value: event.value, at: event.now }
  }
  return state
}

/** So lange (Date.now) nach "Abbrechen" ignoriert die Brücke alle Anfragen der Seite (gegen Dauerschleifen). */
export const cancelQuietMs = 10_000

/**
 * Nimmt die Brücke eine neue Anfrage der Seite an? Nein, solange eine Existenzprüfung läuft; nein bis 10 s nach
 * "Abbrechen" (`cancelledAt`, Date.now; null = nicht abgebrochen); nein, solange eine Rückfrage offen ist, außer sie
 * ist älter als 10 s (dann darf sie ersetzt werden). Es wird nichts eingereiht.
 */
export function canAcceptRequest(
  state: PendingRequest | null,
  checkInFlight: boolean,
  now: number,
  cancelledAt: number | null,
): boolean {
  if (checkInFlight) return false
  if (cancelledAt !== null && now - cancelledAt <= cancelQuietMs) return false
  return state === null || now - state.at > pendingMaxAgeMs
}

/** Moment (performance.now), ab dem die Bestätigung einer bestimmten Anfrage tatsächlich gemalt war. */
export type Armed = { id: number; armedAt: number }
/** Moment (performance.now), in dem der Nutzer "Öffnen" für eine Anfrage angesteuert hat (Zeiger hinein / Tastaturfokus). */
export type Engaged = { id: number; at: number }

/**
 * "Öffnen" gilt nur für die Anfrage, die gemalt wurde, erst `confirmDelayMs` nach dem ersten Bild, und nur, wenn der
 * Nutzer den Knopf NACH Ablauf dieser Sperre angesteuert hat. Ein Zeiger, der schon dort ruhte, muss hinaus und zurück.
 */
export function canConfirm(state: PendingRequest | null, armed: Armed | null, engaged: Engaged | null, now: number): boolean {
  if (state === null || armed === null || engaged === null) return false
  if (armed.id !== state.id || engaged.id !== state.id) return false
  if (engaged.at < armed.armedAt + confirmDelayMs) return false
  return now - armed.armedAt >= confirmDelayMs
}
