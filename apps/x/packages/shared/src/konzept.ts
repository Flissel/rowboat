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

/** Pfad in Segmente zerlegen: Trenner `\` und `/`, leere und `.`-Segmente entfallen. */
function segmente(relPath: string): string[] {
  return relPath.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
}

/** Windows ignoriert Punkte und Leerzeichen am Segmentende. */
function segName(s: string): string {
  return s.replace(/[. ]+$/, '').toLowerCase()
}

export function isHtmlPath(relPath: string): boolean {
  return /\.(html?|xhtml)$/i.test(relPath)
}

export function isKnowledgeHtmlPath(relPath: string): boolean {
  const segs = segmente(relPath)
  if (segs.includes('..')) return false
  return segs.length >= 2 && segName(segs[0]) === 'knowledge' && isHtmlPath(segs[segs.length - 1])
}

/** Quarantäne-Ordner `knowledge/Kanal/`. Bei `..` im Pfad wird sicherheitshalber `true` geliefert. */
export function isKanalPath(relPath: string): boolean {
  const segs = segmente(relPath)
  if (segs.includes('..')) return true
  return segs.length >= 2 && segName(segs[0]) === 'knowledge' && segName(segs[1]) === 'kanal'
}

function codepoint(n: number, roh: string): string {
  return n >= 1 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : roh
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d{1,7});/g, (m, d: string) => codepoint(parseInt(d, 10), m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => codepoint(parseInt(h, 16), m))
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function begrenzt(html: string): string {
  return html.length > KONZEPT_LESE_MAX ? html.slice(0, KONZEPT_LESE_MAX) : html
}

type Token =
  | { k: 'text'; v: string }
  | { k: 'open' | 'close'; name: string; attrs: Record<string, string> }
  | { k: 'raw'; name: string; attrs: Record<string, string>; body: string }

const WS = /\s/

/** Liest ein Tag ab `start` (zeigt auf `<`). Liefert null, wenn es nicht abgeschlossen ist. Linear. */
function parseTag(
  h: string,
  start: number,
): { closing: boolean; name: string; attrs: Record<string, string>; end: number } | null {
  const n = h.length
  let j = start + 1
  const closing = h[j] === '/'
  if (closing) j++
  const ns = j
  while (j < n && !WS.test(h[j]) && h[j] !== '/' && h[j] !== '>') j++
  const name = h.slice(ns, j).toLowerCase()
  const attrs: Record<string, string> = {}
  for (;;) {
    while (j < n && (WS.test(h[j]) || h[j] === '/')) j++
    if (j >= n) return null
    if (h[j] === '>') return { closing, name, attrs, end: j + 1 }
    const as = j
    j++ // mindestens ein Zeichen (auch ein führendes `=`)
    while (j < n && !WS.test(h[j]) && h[j] !== '=' && h[j] !== '>' && h[j] !== '/') j++
    const an = h.slice(as, j).toLowerCase()
    let k = j
    while (k < n && WS.test(h[k])) k++
    let wert = ''
    if (h[k] === '=') {
      k++
      while (k < n && WS.test(h[k])) k++
      if (k >= n) return null
      const q = h[k]
      if (q === '"' || q === "'") {
        const e = h.indexOf(q, k + 1)
        if (e === -1) return null
        wert = h.slice(k + 1, e)
        j = e + 1
      } else {
        const vs = k
        while (k < n && !WS.test(h[k]) && h[k] !== '>') k++
        wert = h.slice(vs, k)
        j = k
      }
    }
    if (!Object.prototype.hasOwnProperty.call(attrs, an)) attrs[an] = wert
  }
}

/**
 * Ein linearer Durchlauf über höchstens KONZEPT_LESE_MAX Zeichen. Kommentare entfallen,
 * script/style kommen als `raw`-Token mit Inhalt. Nicht abgeschlossene Konstrukte beenden den Lauf.
 */
function scan(html: string): Token[] {
  const h = begrenzt(html)
  const n = h.length
  const out: Token[] = []
  let textStart = 0
  let i = 0
  const flush = (end: number) => {
    if (end > textStart) out.push({ k: 'text', v: h.slice(textStart, end) })
  }
  while (i < n) {
    const lt = h.indexOf('<', i)
    if (lt === -1) break
    const c = h[lt + 1]
    if (h.startsWith('<!--', lt)) {
      flush(lt)
      const e = h.indexOf('-->', lt + 4)
      if (e === -1) return out
      i = textStart = e + 3
    } else if (c === '!' || c === '?') {
      flush(lt)
      const e = h.indexOf('>', lt + 2)
      if (e === -1) return out
      i = textStart = e + 1
    } else if (c !== undefined && (c === '/' || /[A-Za-z]/.test(c))) {
      flush(lt)
      const t = parseTag(h, lt)
      if (t === null) return out
      i = textStart = t.end
      if (t.closing) {
        out.push({ k: 'close', name: t.name, attrs: t.attrs })
      } else if (t.name === 'script' || t.name === 'style') {
        const re = new RegExp(`</${t.name}(?=[\\s/>])`, 'gi')
        re.lastIndex = t.end
        const m = re.exec(h)
        if (m === null) {
          out.push({ k: 'raw', name: t.name, attrs: t.attrs, body: h.slice(t.end) })
          return out
        }
        out.push({ k: 'raw', name: t.name, attrs: t.attrs, body: h.slice(t.end, m.index) })
        const e = h.indexOf('>', m.index)
        if (e === -1) return out
        i = textStart = e + 1
      } else {
        out.push({ k: 'open', name: t.name, attrs: t.attrs })
      }
    } else {
      i = lt + 1 // einzelnes `<` ist Text
    }
  }
  flush(n)
  return out
}

export function htmlTitle(html: string): string | null {
  const toks = scan(html)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.k === 'open' && t.name === 'title') {
      let text = ''
      for (let j = i + 1; j < toks.length; j++) {
        const u = toks[j]
        if (u.k !== 'text') break
        text += u.v
      }
      const r = decodeEntities(text).trim()
      return r === '' ? null : r
    }
  }
  return null
}

export function htmlVisibleText(html: string): string {
  const teile: string[] = []
  for (const t of scan(html)) if (t.k === 'text') teile.push(t.v)
  return decodeEntities(teile.join(' ')).replace(/\s+/g, ' ').trim()
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Rohtext des ersten Blocks (`<script type="application/json" id="rowboat-konzept">`) in Dokumentreihenfolge. */
function findBlock(html: string): string | null {
  for (const t of scan(html)) {
    if (t.k !== 'raw' || t.name !== 'script' || t.attrs.id !== KONZEPT_BLOCK_ID) continue
    const typ = (t.attrs.type ?? '').split(';')[0].trim().toLowerCase()
    if (typ === 'application/json') return t.body
  }
  return null
}

/**
 * Liest den ersten Datenblock. Ein unbrauchbarer Block liefert `daten: null` und genau einen Satz.
 * `bezuege` darf beliebige Zeichenketten enthalten; Einträge ohne `[[...]]` ergeben nur einen Hinweis
 * in `fehler` (bei weiterhin gesetztem `daten`). Bei `videokonzept` wird `video` UNGEPRÜFT durchgereicht
 * (nur als Objekt bestätigt); Verbraucher müssen es mit `checkVideoKonzept` prüfen.
 */
export function readKonzept(html: string): { daten: KonzeptDaten | null; fehler: string[] } {
  const roh = findBlock(html)
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
  const hinweise: string[] = []
  if (!bezuege.every((b) => /^\[\[[\s\S]+\]\]$/.test(b.trim()))) {
    hinweise.push(
      'Mindestens ein Eintrag in "bezuege" steht nicht in doppelten eckigen Klammern, z. B. "[[Marke/Marke]]", und ergibt keine Verknüpfung.',
    )
  }
  return { daten, fehler: hinweise }
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

/** Pfadteil einer URL oder eines Pfads: ohne `?`/`#`, prozent-dekodiert, ohne Punkte/Leerzeichen am Ende. */
function istHtmlNamentlich(pfadOderUrl: string): boolean {
  const ohneRest = pfadOderUrl.split(/[?#]/)[0]
  let dekodiert = ohneRest
  try {
    dekodiert = decodeURIComponent(ohneRest)
  } catch {
    // ungültige Kodierung: Rohform prüfen
  }
  const trim = (x: string) => x.replace(/[. ]+$/, '')
  return isHtmlPath(trim(ohneRest)) || isHtmlPath(trim(dekodiert))
}

/** Im Zweifel (Query, Fragment, Kodierung, Endpunkt) gilt eine Datei als HTML und bekommt die Regel. */
export function workspaceHtmlHeaders(relPath: string): Record<string, string> | null {
  if (!istHtmlNamentlich(relPath)) return null
  return htmlAntwortKoepfe()
}

function htmlAntwortKoepfe(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': WORKSPACE_HTML_CSP,
    'X-Content-Type-Options': 'nosniff',
  }
}

function mimeOhneParameter(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

/**
 * Entscheidung für eine Arbeitsverzeichnis-Antwort: Regel anwenden, wenn EINER der Namen
 * der angefragte Pfad (URL-artig: Query, Fragment, Prozent-Kodierung gelten) oder einer der
 * aufgelösten Dateisystempfade (reine Namen: nur das letzte Segment zählt, `#`, `?`, `%` sind
 * gewöhnliche Zeichen) nach HTML aussieht, oder der Content-Type HTML/XHTML ist.
 */
export function shouldApplyHtmlHeaders(relPath: string, resolvedPaths: string[], contentType: string | null): boolean {
  const mime = mimeOhneParameter(contentType)
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return true
  if (relPath !== '' && istHtmlNamentlich(relPath)) return true
  return resolvedPaths.some((p) => {
    const segs = p.split(/[\\/]/)
    return isHtmlPath(segs[segs.length - 1].replace(/[. ]+$/, ''))
  })
}

/** Die drei Köpfe für eine Antwort, die {@link shouldApplyHtmlHeaders} bejaht hat. */
export function htmlResponseHeaders(): Record<string, string> {
  return htmlAntwortKoepfe()
}

/** Content-Type fehlt oder ist generisch: Chromium könnte den Inhalt als Dokument erraten. */
export function needsNosniffOnly(contentType: string | null): boolean {
  const mime = mimeOhneParameter(contentType)
  return mime === '' || mime === 'application/octet-stream' || mime === 'text/plain'
}

export function frameNavigationDecision(frameUrl: string, targetUrl: string): 'allow' | 'block' {
  void targetUrl
  const praefix = 'app://workspace/'
  if (frameUrl.slice(0, praefix.length).toLowerCase() !== praefix) return 'allow'
  return istHtmlNamentlich(frameUrl.slice(praefix.length)) ? 'block' : 'allow'
}
