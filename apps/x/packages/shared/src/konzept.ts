// Gemeinsame Bausteine der Konzept-Fläche: reine Funktionen ohne DOM (Node und Browser).

/**
 * Kein-Netz-Regel für Wissens-HTML (R40): CSP plus `sandbox allow-scripts` (das Dokument ist auch dann
 * abgeschottet, wenn das iframe-Attribut fehlt) und `webrtc 'block'`. Gilt nur für HTML unter `knowledge/` (R38).
 */
export const WORKSPACE_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; sandbox allow-scripts; webrtc 'block'"

export const KONZEPT_BLOCK_ID = 'rowboat-konzept'
export const KONZEPT_MAX_BYTES = 1_048_576
export const KONZEPT_LESE_MAX = 1_048_576
/** Größte HTML-Datei, die Ansicht, Umbenennen (Verweise nachziehen) und Versionsverlauf noch anfassen. */
export const KONZEPT_HTML_MAX_BYTES = 5 * 1024 * 1024
/** Längster Datenblock (Zeichen), den Leser und Umschreiben noch beachten. */
export const KONZEPT_BLOCK_MAX = 20_000

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

export function decodeEntities(s: string): string {
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

/** `s`/`e`: Offsets von Text bzw. Rohinhalt (script/style) im Eingabestring. */
type Token =
  | { k: 'text'; v: string; s: number; e: number }
  | { k: 'open' | 'close'; name: string; attrs: Record<string, string> }
  | { k: 'raw'; name: string; attrs: Record<string, string>; body: string; s: number; e: number }

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
 * `ohneDeckel` liest die ganze Datei (Umschreiben von Verweisen), sonst höchstens KONZEPT_LESE_MAX Zeichen.
 */
function scan(html: string, ohneDeckel = false): Token[] {
  const h = ohneDeckel ? html : begrenzt(html)
  const n = h.length
  const out: Token[] = []
  let textStart = 0
  let i = 0
  const flush = (end: number) => {
    if (end > textStart) out.push({ k: 'text', v: h.slice(textStart, end), s: textStart, e: end })
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
          out.push({ k: 'raw', name: t.name, attrs: t.attrs, body: h.slice(t.end), s: t.end, e: n })
          return out
        }
        out.push({ k: 'raw', name: t.name, attrs: t.attrs, body: h.slice(t.end, m.index), s: t.end, e: m.index })
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
function istDatenblock(t: Token): t is Extract<Token, { k: 'raw' }> {
  if (t.k !== 'raw' || t.name !== 'script' || t.attrs.id !== KONZEPT_BLOCK_ID) return false
  return (t.attrs.type ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
}

function findBlock(html: string): string | null {
  for (const t of scan(html)) if (istDatenblock(t)) return t.body
  return null
}

export type UmschreibBereich = { start: number; end: number; art: 'json' | 'text' }

/**
 * Bereiche einer HTML-Datei, in denen `[[...]]` als Verweis gilt: der Inhalt des ersten Datenblocks
 * (`art: 'json'`) und Text außerhalb von Tags, script, style und Kommentaren (`art: 'text'`).
 * Gleicher Scanner wie die Leser (`readKonzept`, `htmlVisibleText`), aber ohne 1-MB-Deckel.
 */
export function htmlUmschreibBereiche(html: string): UmschreibBereich[] {
  const out: UmschreibBereich[] = []
  let blockGefunden = false
  for (const t of scan(html, true)) {
    if (t.k === 'text') out.push({ start: t.s, end: t.e, art: 'text' })
    else if (!blockGefunden && istDatenblock(t)) {
      blockGefunden = true
      if (t.e > t.s) out.push({ start: t.s, end: t.e, art: 'json' })
    }
  }
  return out
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
  if (roh.length > KONZEPT_BLOCK_MAX) {
    return fehler(`Der Datenblock ist länger als ${KONZEPT_BLOCK_MAX} Zeichen und wird ignoriert.`)
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

const ohneEndpunkt = (x: string) => x.replace(/[. ]+$/, '')

/**
 * Liegt ein reiner, arbeitsverzeichnis-relativer Pfad im Wissensordner (erstes Segment `knowledge`, Groß/Klein und
 * Endpunkt egal)? Bei `..` sicherheitshalber `true`: dann gilt die strengere Regel.
 */
export function isKnowledgeScopePath(relPath: string): boolean {
  const segs = segmente(relPath)
  if (segs.includes('..')) return true
  return segs.length >= 2 && segName(segs[0]) === 'knowledge'
}

/**
 * Rahmen-Schutz (R43): zeigt ein Rahmen ein Dokument unter `app://workspace/knowledge/`, gleich welcher Endung? Ein
 * Nicht-HTML-Dokument führt kein Skript aus, es einzusperren kostet nichts; HTML unter einem seltsamen Namen ist so
 * mit erfasst. Schema und Host ohne Groß/Klein; der Pfad (ohne Query/Fragment) zählt roh und prozent-dekodiert,
 * `\` trennt wie `/`, `.`-Segmente entfallen. Ungültige Kodierung oder `..`: eingesperrt. Adressen außerhalb von
 * app://workspace (auch leer oder about:blank beim ersten Laden eines Rahmens): nicht eingesperrt.
 * Endung und Content-Type zählen nur beim Ausliefern ({@link workspaceResponseDecision}).
 */
export function isKnowledgeFrameUrl(url: string): boolean {
  const m = /^app:\/\/workspace(?=[/?#]|$)/i.exec(url)
  if (m === null) return false
  const roh = url.slice(m[0].length).split(/[?#]/)[0]
  let dekodiert: string
  try {
    dekodiert = decodeURIComponent(roh)
  } catch {
    return true
  }
  return [roh, dekodiert].some((pfad) => {
    const segs = segmente(pfad)
    return segs.includes('..') || (segs.length >= 1 && segName(segs[0]) === 'knowledge')
  })
}

/** Schlüssel, unter dem ein ausgeliefertes Dokument wiedererkannt wird: die Adresse ohne Fragment. */
export function konzeptDocumentKey(url: string): string {
  const i = url.indexOf('#')
  return i === -1 ? url : url.slice(0, i)
}

function htmlAntwortKoepfe(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': WORKSPACE_HTML_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
  }
}

function mimeOhneParameter(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

/**
 * Sieht EINER der Namen nach HTML aus oder ist der Content-Type HTML/XHTML? Die Pfade sind REINE Namen (bereits
 * dekodierter Anfragepfad ohne Query/Fragment, aufgelöster Dateisystempfad): nur das letzte Segment zählt, `#`, `?`,
 * `%` sind gewöhnliche Zeichen.
 */
export function shouldApplyHtmlHeaders(plainPaths: string[], contentType: string | null): boolean {
  const mime = mimeOhneParameter(contentType)
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return true
  return plainPaths.some((p) => {
    const segs = p.split(/[\\/]/)
    return isHtmlPath(ohneEndpunkt(segs[segs.length - 1]))
  })
}

/** Die Köpfe für eine Antwort, die {@link workspaceResponseDecision} als `'konzept'` einstuft. */
export function htmlResponseHeaders(): Record<string, string> {
  return htmlAntwortKoepfe()
}

/** Content-Type fehlt oder ist generisch: Chromium könnte den Inhalt als Dokument erraten. */
export function needsNosniffOnly(contentType: string | null): boolean {
  const mime = mimeOhneParameter(contentType)
  return mime === '' || mime === 'application/octet-stream' || mime === 'text/plain'
}

/**
 * Was eine Antwort von app://workspace bzw. GET /workspace bekommt (R38, R9). Nur Wissens-HTML bekommt die Regel.
 * `relPaths` sind REINE arbeitsverzeichnis-relative Namen: der dekodierte Anfragepfad und, wo bekannt, das aufgelöste
 * Ziel relativ zur aufgelösten Wurzel. Liegt keiner davon unter `knowledge/`, bleibt die Antwort wie vor der
 * Konzept-Fläche (`'unveraendert'`), außer sie trägt die Regel schon (`csp`, vom Fern-Server entschieden). Im
 * Wissensordner: HTML nach einem der Namen oder nach Content-Type -> `'konzept'` (Fehlerantworten nur nach
 * Content-Type, ein 404-Text bleibt Text); fehlender oder generischer Typ -> `'nosniff'`.
 */
export function workspaceResponseDecision(args: {
  relPaths: string[]
  contentType: string | null
  ok?: boolean
  csp?: string | null
}): 'konzept' | 'nosniff' | 'unveraendert' {
  if (args.csp === WORKSPACE_HTML_CSP) return 'konzept'
  if (!args.relPaths.some(isKnowledgeScopePath)) return 'unveraendert'
  const html = args.ok === false
    ? shouldApplyHtmlHeaders([], args.contentType)
    : shouldApplyHtmlHeaders(args.relPaths, args.contentType)
  if (html) return 'konzept'
  return needsNosniffOnly(args.contentType) ? 'nosniff' : 'unveraendert'
}

/**
 * Darf ein Rahmen wegnavigieren? Nein, wenn er ein Dokument unter `app://workspace/knowledge/` zeigt (R43) oder der
 * Hauptprozess es als Wissens-HTML ausgeliefert hat (Symlink-Ziel, Content-Type): keine Navigation im Rahmen, auch
 * nicht zu app://. Der erste Ladevorgang ist nicht betroffen, dort ist die Rahmen-Adresse noch leer/about:blank.
 * Andere Rahmen (Hintergrund-Berichte, Einbettungen) entscheidet der Aufrufer wie vor der Konzept-Fläche.
 */
export function frameNavigationDecision(frameUrl: string, servedAsKnowledgeHtml = false): 'allow' | 'block' {
  return servedAsKnowledgeHtml || isKnowledgeFrameUrl(frameUrl) ? 'block' : 'allow'
}

function schema(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  return m ? m[1].toLowerCase() : null
}

/**
 * Bleibt im Dokument bzw. in der App, nie im Netz: `data:`, `blob:`, `about:`, `app:`, `devtools:` und
 * `chrome-extension:` (Chromiums eingebauter PDF-Betrachter lädt seine Oberfläche so; ein PDF unter knowledge/ ist
 * seit R43 ein eingesperrter Rahmen).
 */
const FREIE_SCHEMATA = new Set(['data', 'blob', 'about', 'app', 'devtools', 'chrome-extension'])

function gleicherHost(a: string, b: string): boolean {
  try {
    const ha = new URL(a).host
    return ha !== '' && ha === new URL(b).host
  } catch {
    return false
  }
}

/** So lange bleibt ein Rahmen nach dem Verlassen der Menge `confined` noch eingesperrt (R46). */
export const CONFINED_GRACE_MS = 5000

/**
 * Zustand des Rückhalts je Ansicht (R46), geschlüsselt nach der Rahmen-Knoten-Id (frameTreeNodeId): `confined` hält
 * die eingesperrten Rahmen, `recentlyConfined` die vor kurzem entlassenen mit dem Zeitpunkt des Entlassens.
 */
export type BackstopState = { confined: Set<number>; recentlyConfined: Map<number, number> }

export function createBackstopState(): BackstopState {
  return { confined: new Set(), recentlyConfined: new Map() }
}

function kuerzlich(recently: ReadonlyMap<number, number>, id: number, now: number): boolean {
  const t = recently.get(id)
  return t !== undefined && now - t <= CONFINED_GRACE_MS // Uhr zurückgesprungen: weiter eingesperrt
}

function entlassen(state: BackstopState, id: number, now: number): void {
  if (state.confined.delete(id)) state.recentlyConfined.set(id, now)
}

function abgelaufeneVergessen(state: BackstopState, now: number): void {
  for (const id of [...state.recentlyConfined.keys()]) {
    if (!kuerzlich(state.recentlyConfined, id, now)) state.recentlyConfined.delete(id)
  }
}

/**
 * Wird ein Rahmen beim Übernehmen eines Dokuments eingesperrt? Ja, wenn die Adresse unter knowledge/ liegt
 * ({@link isKnowledgeFrameUrl}), der Hauptprozess sie als Wissens-HTML ausgeliefert hat, oder sein Elternrahmen
 * eingesperrt ist.
 */
export function isConfinedCommit(url: string, servedAsKnowledgeHtml: boolean, parentConfined: boolean): boolean {
  return parentConfined || servedAsKnowledgeHtml || isKnowledgeFrameUrl(url)
}

/**
 * Ein Unterrahmen hat ein Dokument übernommen (R46). Eingesperrt -> in `confined`. Sonst nur bei einem echten
 * Dokumentwechsel (`inPage: false`) entlassen, nie bei einer Navigation innerhalb der Seite.
 */
export function noteFrameCommit(
  state: BackstopState,
  c: { frameId: number; parentId: number | null; url: string; servedAsKnowledgeHtml?: boolean; inPage: boolean; now: number },
): void {
  abgelaufeneVergessen(state, c.now)
  const parentConfined = c.parentId !== null && state.confined.has(c.parentId)
  if (isConfinedCommit(c.url, c.servedAsKnowledgeHtml === true, parentConfined)) {
    state.confined.add(c.frameId)
    state.recentlyConfined.delete(c.frameId)
  } else if (!c.inPage) {
    entlassen(state, c.frameId, c.now)
  }
}

/** Rahmen, die nicht mehr im Baum der Ansicht hängen (abgebaut, gelöst), werden entlassen (R46). */
export function noteFramesAttached(state: BackstopState, attachedIds: ReadonlySet<number>, now: number): void {
  for (const id of [...state.confined]) if (!attachedIds.has(id)) entlassen(state, id, now)
  abgelaufeneVergessen(state, now)
}

/**
 * Entscheidung des Rückhalts (R44-R46), nur aus Werten. Der Verweiser (Referer) zählt nie.
 * - Laden eines Hauptrahmens, freie Schemata ({@link FREIE_SCHEMATA}) und der eigene Entwicklungsserver (`appUrl`,
 *   gleicher Host): durchlassen.
 * - Rahmen oder ein Vorfahr zeigt eine Adresse unter knowledge/ (`chainConfinedByUrl`, greift schon vor dem
 *   Navigations-Ereignis): abbrechen.
 * - Rahmen identifiziert, lesbar und im Baum der Ansicht (`frameId` gesetzt, `attached`): abbrechen, wenn er oder ein
 *   Vorfahr (`ancestorIds`) in `confined` oder noch nicht abgelaufen in `recentlyConfined` steht; sonst durchlassen.
 * - Sonst (nicht identifizierbar, nicht lesbar, nicht im Baum): abbrechen, solange `confined` nicht leer ist oder
 *   `recentlyConfined` einen nicht abgelaufenen Eintrag hat.
 */
export function backstopDecision(r: {
  url: string
  resourceType: string
  frameId: number | null
  ancestorIds: readonly number[]
  attached: boolean
  chainConfinedByUrl: boolean
  confined: ReadonlySet<number>
  recentlyConfined: ReadonlyMap<number, number>
  now: number
  appUrl?: string | null
}): boolean {
  if (r.resourceType === 'mainFrame') return false
  const s = schema(r.url)
  if (s !== null && FREIE_SCHEMATA.has(s)) return false
  if (r.appUrl && gleicherHost(r.url, r.appUrl)) return false
  if (r.chainConfinedByUrl) return true
  const eingesperrt = (id: number) => r.confined.has(id) || kuerzlich(r.recentlyConfined, id, r.now)
  if (r.frameId !== null && r.attached) return [r.frameId, ...r.ancestorIds].some(eingesperrt)
  return r.confined.size > 0 || [...r.recentlyConfined.keys()].some((id) => kuerzlich(r.recentlyConfined, id, r.now))
}
