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

/** Wahr nur, wenn der Browser `navigator.userActivation.isActive === true` meldet; fehlt die API, gilt es als nicht aktiv. */
export function userActivationActive(nav: unknown): boolean {
  if (!isRecord(nav)) return false
  const ua = nav.userActivation
  return isRecord(ua) && ua.isActive === true
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
