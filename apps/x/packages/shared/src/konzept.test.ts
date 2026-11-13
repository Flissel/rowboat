import { describe, expect, it } from 'vitest'
import {
  KONZEPT_LESE_MAX,
  WORKSPACE_HTML_CSP,
  checkVideoKonzept,
  frameNavigationDecision,
  htmlTitle,
  htmlVisibleText,
  isKanalPath,
  isKnowledgeHtmlPath,
  readKonzept,
  htmlResponseHeaders,
  isHtmlPath,
  isKnowledgeFrameUrl,
  isKnowledgeScopePath,
  needsNosniffOnly,
  shouldApplyHtmlHeaders,
  backstopDecision,
  createBackstopState,
  isConfinedCommit,
  noteFrameCommit,
  noteFramesAttached,
  CONFINED_GRACE_MS,
  workspaceResponseDecision,
} from './konzept.js'

const SEITE = (block: string) => `<!doctype html><html><head><title>Mein &amp; Konzept</title>
<script type="application/json" id="rowboat-konzept">${block}</script><style>.x{color:red}</style></head>
<body><h1>Hallo</h1><script>var geheim = 1</script><!-- weg --><p>Welt</p></body></html>`
const VIDEO = { thema: 'KI im Alltag', zielgruppe: 'Inhaber', minuten: 4, hook: 'H', kernaussage: 'K', abschluss: 'A', auftrag: null,
  stufen: [{ name: 'Einstieg', szenen: Array.from({ length: 8 }, (_, i) => ({ kurz: `Szene ${i}`, bildart: 'slide' })) }] }

describe('konzept', () => {
  it('liest Titel, Text und Block', () => {
    const html = SEITE(JSON.stringify({ art: 'konzept', bezuege: ['[[Marke/Marke]]'] }))
    expect(htmlTitle(html)).toBe('Mein & Konzept')
    expect(htmlVisibleText(html)).toBe('Mein & Konzept Hallo Welt')
    expect(readKonzept(html)).toEqual({ daten: { art: 'konzept', bezuege: ['[[Marke/Marke]]'] }, fehler: [] })
  })
  it('Seite ohne Block: keine Daten, kein Fehler', () => {
    expect(readKonzept('<html><title>t</title></html>')).toEqual({ daten: null, fehler: [] })
  })
  it.each(['{kaputt', '{"art":"x","bezuege":[]}', '{"art":"konzept","bezuege":"a"}', '[]'])(
    'kaputter Block meldet genau einen Fehler statt zu werfen: %s', (block) => {
      const r = readKonzept(SEITE(block))
      expect(r.daten).toBeNull()
      expect(r.fehler).toHaveLength(1)
    })
  it('bei zwei Blöcken gilt der erste', () => {
    const html = SEITE(JSON.stringify({ art: 'konzept', bezuege: [] })) + SEITE(JSON.stringify({ art: 'videokonzept', bezuege: [] }))
    expect(readKonzept(html).daten?.art).toBe('konzept')
  })
  it('findet den Block unabhängig von Attributreihenfolge und Anführungszeichen', () => {
    const json = JSON.stringify({ art: 'konzept', bezuege: [] })
    for (const tag of [
      `<script id="rowboat-konzept" type="application/json">`,
      `<script id='rowboat-konzept' type='application/json'>`,
      `<SCRIPT type=application/json id=\"rowboat-konzept\">`,
    ]) {
      expect(readKonzept(`<html>${tag}${json}</script></html>`).daten?.art).toBe('konzept')
    }
  })
  it('liest </script> im JSON, das als <\/script> geschrieben ist', () => {
    const json = JSON.stringify({ art: 'konzept', bezuege: ['[[a</script>b]]'] }).replace(/<\/script>/g, String.raw`<\/script>`)
    expect(json).toContain(String.raw`<\/script>`)
    expect(readKonzept(SEITE(json)).daten?.bezuege).toEqual(['[[a</script>b]]'])
  })
  it('prüft die Grenzen des Videokonzepts', () => {
    expect(checkVideoKonzept(VIDEO)).toEqual([])
    expect(checkVideoKonzept({ ...VIDEO, minuten: 6 })).toHaveLength(1)
    expect(checkVideoKonzept({ ...VIDEO, stufen: [{ name: 'E', szenen: VIDEO.stufen[0].szenen.slice(0, 6) }] })).toHaveLength(1) // 6 Szenen
    expect(checkVideoKonzept({ ...VIDEO, stufen: [{ name: 'E', szenen: [...VIDEO.stufen[0].szenen, ...VIDEO.stufen[0].szenen] }] })).toHaveLength(1) // 16
    expect(checkVideoKonzept({ ...VIDEO, stufen: [{ name: 'E', szenen: VIDEO.stufen[0].szenen.map((s) => ({ ...s, bildart: 'film' })) }] }).length).toBeGreaterThan(0)
    expect(checkVideoKonzept(null)).toHaveLength(1)
  })
  it('readKonzept gibt video bei videokonzept unverändert zurück', () => {
    const r = readKonzept(SEITE(JSON.stringify({ art: 'videokonzept', bezuege: [], video: VIDEO })))
    expect(r.fehler).toEqual([])
    expect(r.daten?.video).toEqual(VIDEO)
  })
  it('kennt Pfade', () => {
    expect(isKnowledgeHtmlPath('knowledge/Konzepte/Ä b.HTM')).toBe(true)
    expect(isKnowledgeHtmlPath('config/x.html')).toBe(false)
    expect(isKanalPath('knowledge/kanal/x.html')).toBe(true)
    expect(isKanalPath('knowledge/Kanalarbeit/x.html')).toBe(false)
  })
  it('die Regel lautet wörtlich wie in R40', () => {
    expect(WORKSPACE_HTML_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; sandbox allow-scripts; webrtc 'block'",
    )
    expect(htmlResponseHeaders()).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': WORKSPACE_HTML_CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off',
    })
  })
  it('Navigationsentscheid: Rahmen unter knowledge/ gesperrt, alles andere wie vorher', () => {
    expect(frameNavigationDecision('app://workspace/knowledge/a.html')).toBe('block')
    // R43: ohne Blick auf die Endung
    expect(frameNavigationDecision('app://workspace/knowledge/seite')).toBe('block')
    expect(frameNavigationDecision('app://workspace/knowledge/a.png?f=a.html')).toBe('block')
    expect(frameNavigationDecision('https://www.youtube.com/embed/x')).toBe('allow')
    // Hintergrund-Bericht außerhalb von knowledge/: unberührt (R38)
    expect(frameNavigationDecision('app://workspace/bg-tasks/x/index.html')).toBe('allow')
    expect(frameNavigationDecision('app://workspace/knowledge.html')).toBe('allow')
    expect(frameNavigationDecision('app://space-document/o/s/a/x.html')).toBe('allow')
    // vom Hauptprozess als Wissens-HTML ausgeliefert (Symlink-Ziel, Content-Type)
    expect(frameNavigationDecision('app://workspace/bg-tasks/link.html', true)).toBe('block')
  })
  it('Pfade: Backslash, führender Slash, //, ., .. und Groß/Klein', () => {
    expect(isKnowledgeHtmlPath('\\knowledge\\a.html')).toBe(true)
    expect(isKnowledgeHtmlPath('/Knowledge/a.html')).toBe(true)
    expect(isKnowledgeHtmlPath('knowledge//./a.html')).toBe(true)
    expect(isKnowledgeHtmlPath('knowledge/../config/x.html')).toBe(false)
    expect(isKnowledgeHtmlPath('knowledge/a.txt')).toBe(false)
    expect(isKanalPath('knowledge//Kanal/x.html')).toBe(true)
    expect(isKanalPath('knowledge/./Kanal/x.html')).toBe(true)
    expect(isKanalPath('\\Knowledge\\KANAL\\x.html')).toBe(true)
    expect(isKanalPath('/knowledge/kanal./x.html')).toBe(true)
    expect(isKanalPath('knowledge/a/../Kanal/x.html')).toBe(true)
    expect(isKanalPath('knowledge/Konzepte/x.html')).toBe(false)
  })
  it('Titel stammt nicht aus Script, Style oder Kommentar', () => {
    expect(htmlTitle('<script>x="<title>fake</title>"</script><title>real</title>')).toBe('real')
    expect(htmlTitle('<!-- <title>fake</title> --><style>/*<title>f</title>*/</style><title>real</title>')).toBe('real')
    expect(htmlTitle('<script>x="<title>fake</title>"</script>')).toBeNull()
  })
  it('Block in Kommentar, Style oder fremdem Attribut gilt nicht', () => {
    const json = JSON.stringify({ art: 'konzept', bezuege: [] })
    const echt = `<script type="application/json" id="rowboat-konzept">${json}</script>`
    const falsch = `<script type="application/json" id="rowboat-konzept">{"art":"videokonzept","bezuege":[]}</script>`
    expect(readKonzept(`<!-- ${falsch} -->${echt}`).daten?.art).toBe('konzept')
    expect(readKonzept(`<style>${falsch}</style>${echt}`).daten?.art).toBe('konzept')
    expect(readKonzept(`<script data-x=" id=rowboat-konzept" type="application/json">${falsch}</script>`).daten).toBeNull()
    expect(readKonzept(`<script data-x="a>b" id="rowboat-konzept" type="application/json">${json}</script>`).daten?.art).toBe('konzept')
    expect(readKonzept(`<script id="rowboat-konzept">${json}</script>`).daten).toBeNull() // ohne type
  })
  it('Einträge ohne [[...]] geben Hinweis und behalten die Daten', () => {
    const r = readKonzept(SEITE(JSON.stringify({ art: 'konzept', bezuege: ['[[A/B]]', 'Marke'] })))
    expect(r.daten?.bezuege).toEqual(['[[A/B]]', 'Marke'])
    expect(r.fehler).toHaveLength(1)
  })
  it('isKnowledgeFrameUrl (R43): alles unter app://workspace/knowledge/, im Zweifel eingesperrt', () => {
    for (const p of [
      'knowledge/a.html', 'knowledge/a.HTML', 'knowledge/a.html?x=1', 'knowledge/a.html#y', 'knowledge/a%2Ehtml',
      'knowledge/a.html.', 'Knowledge/K/a.htm', '%6Bnowledge/a.html', 'knowledge%2Fa.html', 'knowledge%5Ca.html',
      '/knowledge/a.html', 'knowledge./a.html', 'knowledge/a.xhtml', 'knowledge/a.png', 'knowledge/seite',
      'knowledge/a.pdf', 'knowledge', 'knowledge/', './knowledge/a', 'bg-tasks/../knowledge/a.html', 'bg-tasks/%2e%2e/x',
      'x/..', 'knowledge/%E0%A4%A', 'bg-tasks/%ZZ',
    ]) {
      expect(isKnowledgeFrameUrl(`app://workspace/${p}`), p).toBe(true)
      expect(frameNavigationDecision(`app://workspace/${p}`), p).toBe('block')
    }
    expect(isKnowledgeFrameUrl('APP://Workspace/knowledge/a.html')).toBe(true)
    expect(isKnowledgeFrameUrl('app://workspace\\knowledge\\a.html')).toBe(false) // kein Host app://workspace
    for (const u of [
      'app://workspace/bg-tasks/x/index.html', 'app://workspace/knowledge.html', 'app://workspace/wissen/a.html',
      'app://workspace/index.html', 'app://workspace', 'app://workspace/', 'app://workspacex/knowledge/a.html',
      'app://workspace@evil/knowledge/a.html', 'app://file-preview/knowledge/a.html', 'app://-/index.html',
      'app://space-document/o/s/knowledge/a.html', 'about:blank', 'about:srcdoc', '', 'https://example.com/knowledge/a.html',
    ]) {
      expect(isKnowledgeFrameUrl(u), u).toBe(false)
    }
  })
  it('isKnowledgeScopePath: erstes Segment knowledge, bei .. im Zweifel ja', () => {
    expect(isKnowledgeScopePath('knowledge/a.html')).toBe(true)
    expect(isKnowledgeScopePath('\\Knowledge\\x\\y.txt')).toBe(true)
    expect(isKnowledgeScopePath('bg-tasks/x/index.html')).toBe(false)
    expect(isKnowledgeScopePath('knowledge')).toBe(false)
    expect(isKnowledgeScopePath('bg-tasks/../knowledge/a.html')).toBe(true)
  })
  it('.xhtml gilt als HTML (Typ bleibt text/html)', () => {
    expect(isHtmlPath('knowledge/a.XHTML')).toBe(true)
    expect(workspaceResponseDecision({ relPaths: ['knowledge/a.xhtml'], contentType: null })).toBe('konzept')
    expect(htmlResponseHeaders()['Content-Type']).toBe('text/html; charset=utf-8')
    expect(frameNavigationDecision('app://workspace/knowledge/a.xhtml')).toBe('block')
  })
  it('workspaceResponseDecision: nur Wissens-HTML bekommt die Regel (R38)', () => {
    const d = workspaceResponseDecision
    expect(d({ relPaths: ['knowledge/a.html'], contentType: 'text/html' })).toBe('konzept')
    expect(d({ relPaths: ['knowledge/a.html'], contentType: 'application/octet-stream' })).toBe('konzept')
    // Hintergrund-Bericht und seine Geschwister: wie vor der Konzept-Fläche
    expect(d({ relPaths: ['bg-tasks/x/index.html', 'bg-tasks/x/index.html'], contentType: 'text/html' })).toBe('unveraendert')
    expect(d({ relPaths: ['bg-tasks/x/bild.png'], contentType: 'image/png' })).toBe('unveraendert')
    expect(d({ relPaths: ['bg-tasks/x/daten'], contentType: null })).toBe('unveraendert')
    // Symlink: angefragt außerhalb, Ziel im Wissensordner (oder umgekehrt) -> Regel
    expect(d({ relPaths: ['bg-tasks/link.html', 'knowledge/a.html'], contentType: 'text/html' })).toBe('konzept')
    expect(d({ relPaths: ['bg-tasks/x.txt', 'knowledge\\a.html'], contentType: 'text/plain' })).toBe('konzept')
    expect(d({ relPaths: ['knowledge/l.html', 'bg-tasks/x/index.html'], contentType: 'text/html' })).toBe('konzept')
    // im Wissensordner nach Content-Type; generisch -> nosniff; Medien unverändert
    expect(d({ relPaths: ['knowledge/seite'], contentType: 'Text/HTML; charset=utf-8' })).toBe('konzept')
    expect(d({ relPaths: ['knowledge/seite'], contentType: null })).toBe('nosniff')
    expect(d({ relPaths: ['knowledge/a.png'], contentType: 'image/png' })).toBe('unveraendert')
    // Fehlerantworten: nur der Content-Type zählt
    expect(d({ relPaths: ['knowledge/a.html'], contentType: 'text/plain', ok: false })).toBe('nosniff')
    expect(d({ relPaths: ['knowledge/a.html'], contentType: 'text/html', ok: false })).toBe('konzept')
    // der Fern-Server hat schon entschieden (z. B. über das Symlink-Ziel)
    expect(d({ relPaths: ['bg-tasks/link.html'], contentType: 'text/html', csp: WORKSPACE_HTML_CSP })).toBe('konzept')
    expect(d({ relPaths: ['bg-tasks/link.html'], contentType: 'text/html', csp: 'default-src *' })).toBe('unveraendert')
  })
  it('isConfinedCommit: knowledge/, ausgeliefert oder Kind eines eingesperrten Rahmens', () => {
    expect(isConfinedCommit('app://workspace/knowledge/a.html', false, false)).toBe(true)
    expect(isConfinedCommit('app://workspace/knowledge/a.pdf', false, false)).toBe(true)
    expect(isConfinedCommit('app://workspace/knowledge/seite', false, false)).toBe(true)
    expect(isConfinedCommit('about:srcdoc', false, true)).toBe(true)
    expect(isConfinedCommit('app://workspace/bg-tasks/l.html', true, false)).toBe(true)
    expect(isConfinedCommit('app://workspace/bg-tasks/x/index.html', false, false)).toBe(false)
    expect(isConfinedCommit('https://www.youtube.com/embed/x', false, false)).toBe(false)
  })
  it('Rückhalt-Zustand (R46): In-Page entlässt nie, Dokumentwechsel und Abbau entlassen in recentlyConfined, Ablauf', () => {
    const k = 'app://workspace/knowledge/a.html'
    const st = createBackstopState()
    noteFrameCommit(st, { frameId: 7, parentId: 1, url: k, inPage: false, now: 1000 })
    expect([...st.confined]).toEqual([7])
    // In-Page-Navigation zu einer fremden Adresse: bleibt eingesperrt
    noteFrameCommit(st, { frameId: 7, parentId: 1, url: 'https://example.com/#x', inPage: true, now: 1100 })
    expect(st.confined.has(7)).toBe(true)
    // In-Page innerhalb von knowledge/ fügt hinzu
    noteFrameCommit(st, { frameId: 9, parentId: 1, url: `${k}#teil`, inPage: true, now: 1100 })
    expect(st.confined.has(9)).toBe(true)
    // Kind eines eingesperrten Rahmens
    noteFrameCommit(st, { frameId: 8, parentId: 7, url: 'about:srcdoc', inPage: false, now: 1150 })
    expect(st.confined.has(8)).toBe(true)
    // Dokumentwechsel nach außerhalb: entlassen, mit Zeitpunkt
    noteFrameCommit(st, { frameId: 7, parentId: 1, url: 'https://www.figma.com/embed', inPage: false, now: 1200 })
    expect(st.confined.has(7)).toBe(false)
    expect(st.recentlyConfined.get(7)).toBe(1200)
    // erneut eingesperrt: aus recentlyConfined heraus
    noteFrameCommit(st, { frameId: 7, parentId: 1, url: k, inPage: false, now: 1300 })
    expect(st.confined.has(7)).toBe(true)
    expect(st.recentlyConfined.has(7)).toBe(false)
    // Abbau: nicht mehr im Baum -> entlassen
    noteFramesAttached(st, new Set([1, 7]), 2000)
    expect([...st.confined]).toEqual([7])
    expect(st.recentlyConfined.get(8)).toBe(2000)
    expect(st.recentlyConfined.get(9)).toBe(2000)
    // Ablauf nach CONFINED_GRACE_MS
    noteFramesAttached(st, new Set([1, 7]), 2000 + CONFINED_GRACE_MS)
    expect(st.recentlyConfined.has(8)).toBe(true)
    noteFramesAttached(st, new Set([1, 7]), 2001 + CONFINED_GRACE_MS)
    expect(st.recentlyConfined.size).toBe(0)
    expect(CONFINED_GRACE_MS).toBe(5000)
  })
  it('backstopDecision (R44-R46): jeder Zweig, der Verweiser zählt nie', () => {
    const leer = { confined: new Set<number>(), recentlyConfined: new Map<number, number>() }
    const offen = { confined: new Set([7]), recentlyConfined: new Map<number, number>() }
    const kuerzlich = { confined: new Set<number>(), recentlyConfined: new Map([[7, 1000]]) }
    const basis = {
      url: 'https://example.com/x', resourceType: 'image', frameId: 7, ancestorIds: [1], attached: true,
      chainConfinedByUrl: false, ...offen, now: 1000, appUrl: null,
    }
    // Rahmen in confined / in nicht abgelaufenem recentlyConfined -> abbrechen
    expect(backstopDecision(basis)).toBe(true)
    expect(backstopDecision({ ...basis, ...kuerzlich, now: 1000 + CONFINED_GRACE_MS })).toBe(true)
    expect(backstopDecision({ ...basis, ...kuerzlich, now: 1001 + CONFINED_GRACE_MS })).toBe(false)
    // Vorfahr eingesperrt -> abbrechen (verschachtelter Rahmen im Konzept)
    expect(backstopDecision({ ...basis, frameId: 8, ancestorIds: [7, 1] })).toBe(true)
    expect(backstopDecision({ ...basis, frameId: 8, ancestorIds: [7, 1], ...kuerzlich, now: 1500 })).toBe(true)
    // Rahmen bekannt, im Baum, weder er noch ein Vorfahr eingesperrt -> durchlassen, auch bei offenem Konzept
    expect(backstopDecision({ ...basis, frameId: 1, ancestorIds: [] })).toBe(false)
    expect(backstopDecision({ ...basis, frameId: 12, ancestorIds: [1] })).toBe(false)
    // Adresse des Rahmens oder eines Vorfahren unter knowledge/ (vor dem Navigations-Ereignis) -> abbrechen
    expect(backstopDecision({ ...basis, ...leer, frameId: 12, chainConfinedByUrl: true })).toBe(true)
    // Rahmen nicht identifizierbar/nicht lesbar oder nicht im Baum: nach der Ansicht
    for (const rahmen of [{ frameId: null }, { frameId: 12, attached: false }]) {
      expect(backstopDecision({ ...basis, ...rahmen }), JSON.stringify(rahmen)).toBe(true)
      expect(backstopDecision({ ...basis, ...rahmen, ...kuerzlich, now: 2000 }), JSON.stringify(rahmen)).toBe(true)
      expect(backstopDecision({ ...basis, ...rahmen, ...kuerzlich, now: 1001 + CONFINED_GRACE_MS })).toBe(false)
      expect(backstopDecision({ ...basis, ...rahmen, ...leer }), JSON.stringify(rahmen)).toBe(false)
    }
    // freie Schemata und der eigene Entwicklungsserver: auch aus einem eingesperrten Rahmen
    for (const url of ['app://-/assets/x.js', 'app://workspace/knowledge/b.png', 'data:,x', 'blob:null/1', 'about:blank',
      'devtools://devtools/x', 'chrome-extension://pdf/x.js', 'http://localhost:5173/src/x.ts', 'ws://localhost:5173/']) {
      expect(backstopDecision({ ...basis, url, chainConfinedByUrl: true, appUrl: 'http://localhost:5173' }), url).toBe(false)
    }
    expect(backstopDecision({ ...basis, url: 'http://localhost:9999/', appUrl: 'http://localhost:5173' })).toBe(true)
    expect(backstopDecision({ ...basis, url: 'kein-schema' })).toBe(true)
    // Laden eines Hauptrahmens: nie
    expect(backstopDecision({ ...basis, resourceType: 'mainFrame', chainConfinedByUrl: true })).toBe(false)
    expect(backstopDecision({ ...basis, resourceType: 'mainFrame', frameId: null })).toBe(false)
  })
  it('needsNosniffOnly: fehlend oder generisch', () => {
    expect(needsNosniffOnly(null)).toBe(true)
    expect(needsNosniffOnly('')).toBe(true)
    expect(needsNosniffOnly('application/octet-stream')).toBe(true)
    expect(needsNosniffOnly('Text/Plain; charset=utf-8')).toBe(true)
    expect(needsNosniffOnly('image/png')).toBe(false)
    expect(needsNosniffOnly('video/mp4')).toBe(false)
    expect(needsNosniffOnly('application/pdf')).toBe(false)
  })
  it('hostile Eingaben bleiben linear schnell', () => {
    for (const eingabe of ['<'.repeat(200_000), '<script '.repeat(50_000), '<!--'.repeat(100_000), '<a title="'.repeat(50_000)]) {
      const t0 = Date.now()
      htmlTitle(eingabe)
      htmlVisibleText(eingabe)
      readKonzept(eingabe)
      expect(Date.now() - t0).toBeLessThan(1000)
    }
  })
  it('liest höchstens KONZEPT_LESE_MAX Zeichen', () => {
    const html = '<title>t</title>' + 'x'.repeat(KONZEPT_LESE_MAX + 10) + '<p>ende</p>'
    expect(htmlVisibleText(html).endsWith('ende')).toBe(false)
  })
})
