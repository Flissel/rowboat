// Gemeinsame Bausteine der Konzept-Fläche: reine Funktionen ohne DOM (Node und Browser).

export const WORKSPACE_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'"

export const KONZEPT_BLOCK_ID = 'rowboat-konzept'
export const KONZEPT_MAX_BYTES = 1_048_576
export const KONZEPT_LESE_MAX = 1_048_576
const BLOCK_MAX_ZEICHEN = 20_000

export const BILDARTEN = ['slide', 'avatar_slide', 'avatar_gross', 'clip'] as const

export type VideoSzene = { kurz: string; bildart: (typeof BILDARTEN)[number]; notiz?: string }
export type VideoStufe = { name: string; szenen: VideoSzene[] }
export type VideoKonzept = {
  thema: string
  zielgruppe: string
  minuten: number
  hook: string
  kernaussage: string
  stufen: VideoStufe[]
  abschluss: string
  auftrag: null
  firma?: string
}
export type KonzeptDaten = { art: 'konzept' | 'videokonzept'; bezuege: string[]; video?: VideoKonzept }

function normPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function isHtmlPath(relPath: string): boolean {
  return /\.html?$/i.test(relPath)
}

export function isKnowledgeHtmlPath(relPath: string): boolean {
  const p = normPath(relPath)
  return p.startsWith('knowledge/') && isHtmlPath(p)
}

export function isKanalPath(relPath: string): boolean {
  return normPath(relPath).toLowerCase().startsWith('knowledge/kanal/')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function begrenzt(html: string): string {
  return html.length > KONZEPT_LESE_MAX ? html.slice(0, KONZEPT_LESE_MAX) : html
}

export function htmlTitle(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(begrenzt(html))
  if (!m) return null
  const t = decodeEntities(m[1]).trim()
  return t === '' ? null : t
}

export function htmlVisibleText(html: string): string {
  const ohne = begrenzt(html)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(ohne).replace(/\s+/g, ' ').trim()
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Rohtext des ersten Blocks mit der Id, oder null. */
function findBlock(html: string): string | null {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  const idRe = new RegExp(
    `(?:^|\\s)id\\s*=\\s*(?:"${KONZEPT_BLOCK_ID}"|'${KONZEPT_BLOCK_ID}'|${KONZEPT_BLOCK_ID}(?=\\s|$))`,
    'i',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (idRe.test(m[1])) return m[2]
  }
  return null
}

export function readKonzept(html: string): { daten: KonzeptDaten | null; fehler: string[] } {
  const roh = findBlock(begrenzt(html))
  if (roh === null) return { daten: null, fehler: [] }
  const fehler = (satz: string) => ({ daten: null, fehler: [satz] })
  if (roh.length > BLOCK_MAX_ZEICHEN) {
    return fehler(`Der Datenblock ist länger als ${BLOCK_MAX_ZEICHEN} Zeichen und wird ignoriert.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(roh)
  } catch {
    return fehler('Der Datenblock enthält kein gültiges JSON und wird ignoriert.')
  }
  if (!isRecord(parsed)) return fehler('Der Datenblock muss ein JSON-Objekt sein und wird ignoriert.')
  if (parsed.art !== 'konzept' && parsed.art !== 'videokonzept') {
    return fehler('Im Datenblock fehlt "art" mit dem Wert "konzept" oder "videokonzept".')
  }
  const bezuege = parsed.bezuege
  if (!Array.isArray(bezuege) || !bezuege.every((b): b is string => typeof b === 'string')) {
    return fehler('Im Datenblock muss "bezuege" eine Liste von Zeichenketten sein.')
  }
  const daten: KonzeptDaten = { art: parsed.art, bezuege }
  if (parsed.art === 'videokonzept') {
    if (!isRecord(parsed.video)) return fehler('Beim Videokonzept fehlt im Datenblock das Objekt "video".')
    daten.video = parsed.video as unknown as VideoKonzept
  }
  return { daten, fehler: [] }
}

function textLaenge(v: unknown, min: number, max: number): boolean {
  return typeof v === 'string' && v.trim().length >= min && v.length <= max
}

export function checkVideoKonzept(v: unknown): string[] {
  if (!isRecord(v)) return ['Das Videokonzept fehlt oder ist kein Objekt.']
  const f: string[] = []
  if (!textLaenge(v.thema, 3, 300)) f.push('Das Thema muss 3 bis 300 Zeichen lang sein.')
  if (!textLaenge(v.zielgruppe, 1, Infinity)) f.push('Die Zielgruppe fehlt.')
  if (typeof v.minuten !== 'number' || !(v.minuten >= 3 && v.minuten <= 5)) f.push('Die Länge muss zwischen 3 und 5 Minuten liegen.')
  if (!textLaenge(v.hook, 1, Infinity)) f.push('Der Hook fehlt.')
  if (!textLaenge(v.kernaussage, 1, Infinity)) f.push('Die Kernaussage fehlt.')
  if (!textLaenge(v.abschluss, 1, Infinity)) f.push('Der Abschluss fehlt.')
  if (v.auftrag !== null) f.push('Der Auftrag muss leer (null) sein.')
  if (v.firma !== undefined && typeof v.firma !== 'string') f.push('Die Firma muss ein Text sein.')
  if (!Array.isArray(v.stufen)) {
    f.push('Die Stufen fehlen oder sind keine Liste.')
    return f
  }
  if (v.stufen.length > 8) f.push('Es sind höchstens 8 Stufen erlaubt.')
  let szenenGesamt = 0
  let stufenOk = true
  let kurzOk = true
  let bildartOk = true
  let notizOk = true
  for (const s of v.stufen) {
    if (!isRecord(s) || typeof s.name !== 'string' || !Array.isArray(s.szenen)) {
      stufenOk = false
      continue
    }
    for (const sz of s.szenen) {
      szenenGesamt++
      if (!isRecord(sz)) {
        kurzOk = false
        bildartOk = false
        continue
      }
      if (typeof sz.kurz !== 'string' || sz.kurz.length > 300) kurzOk = false
      if (typeof sz.bildart !== 'string' || !(BILDARTEN as readonly string[]).includes(sz.bildart)) bildartOk = false
      if (sz.notiz !== undefined && typeof sz.notiz !== 'string') notizOk = false
    }
  }
  if (!stufenOk) f.push('Jede Stufe braucht einen Namen und eine Liste von Szenen.')
  if (szenenGesamt < 8 || szenenGesamt > 15) f.push(`Es sind insgesamt 8 bis 15 Szenen nötig, gefunden wurden ${szenenGesamt}.`)
  if (!kurzOk) f.push('Jede Szene braucht eine Kurzbeschreibung mit höchstens 300 Zeichen.')
  if (!bildartOk) f.push('Die Bildart jeder Szene muss slide, avatar_slide, avatar_gross oder clip sein.')
  if (!notizOk) f.push('Eine Notiz muss ein Text sein.')
  return f
}

export function workspaceHtmlHeaders(relPath: string): Record<string, string> | null {
  if (!isHtmlPath(relPath)) return null
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': WORKSPACE_HTML_CSP,
    'X-Content-Type-Options': 'nosniff',
  }
}

export function frameNavigationDecision(frameUrl: string, targetUrl: string): 'allow' | 'block' {
  void targetUrl
  if (!frameUrl.startsWith('app://workspace/')) return 'allow'
  const pfad = frameUrl.split(/[?#]/)[0]
  return isHtmlPath(pfad) ? 'block' : 'allow'
}
