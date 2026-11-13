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
  workspaceHtmlHeaders,
  htmlResponseHeaders,
  isHtmlPath,
  needsNosniffOnly,
  shouldApplyHtmlHeaders,
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
  it('liefert Köpfe und Navigationsentscheid', () => {
    expect(workspaceHtmlHeaders('knowledge/a.html')?.['Content-Security-Policy']).toBe(WORKSPACE_HTML_CSP)
    expect(workspaceHtmlHeaders('knowledge/a.md')).toBeNull()
    expect(frameNavigationDecision('app://workspace/knowledge/a.html', 'https://example.com/?d=1')).toBe('block')
    expect(frameNavigationDecision('app://workspace/knowledge/a.html', 'app://workspace/knowledge/b.html')).toBe('block')
    expect(frameNavigationDecision('https://www.youtube.com/embed/x', 'https://www.youtube.com/y')).toBe('allow')
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
  it('HTML-Köpfe und Navigation: Schreibweisen, Query, Fragment, Kodierung, Endpunkt', () => {
    for (const p of ['knowledge/a.HTML', 'knowledge/a.html?x=1', 'knowledge/a.html#y', 'knowledge/a%2Ehtml', 'knowledge/a.html.', 'knowledge/a.html ']) {
      expect(workspaceHtmlHeaders(p)?.['Content-Security-Policy'], p).toBe(WORKSPACE_HTML_CSP)
      expect(frameNavigationDecision(`app://workspace/${p}`, 'https://example.com/'), p).toBe('block')
    }
    expect(frameNavigationDecision('APP://Workspace/knowledge/a.html', 'x')).toBe('block')
    expect(frameNavigationDecision('app://workspace/knowledge/a.png?f=a.html', 'x')).toBe('allow')
    expect(workspaceHtmlHeaders('knowledge/a.md')).toBeNull()
  })
  it('.xhtml gilt als HTML (Typ bleibt text/html)', () => {
    expect(isHtmlPath('knowledge/a.XHTML')).toBe(true)
    expect(workspaceHtmlHeaders('knowledge/a.xhtml')?.['Content-Type']).toBe('text/html; charset=utf-8')
    expect(workspaceHtmlHeaders('knowledge/a.xhtml')?.['Content-Security-Policy']).toBe(WORKSPACE_HTML_CSP)
    expect(frameNavigationDecision('app://workspace/knowledge/a.xhtml', 'https://example.com/')).toBe('block')
  })
  it('shouldApplyHtmlHeaders: Namen und erkannter Content-Type', () => {
    expect(shouldApplyHtmlHeaders(['x.txt', 'y.html'], 'text/plain')).toBe(true) // Verknüpfung
    expect(shouldApplyHtmlHeaders(['x.txt'], 'Text/HTML; charset=utf-8')).toBe(true)
    expect(shouldApplyHtmlHeaders(['x'], 'application/xhtml+xml')).toBe(true)
    expect(shouldApplyHtmlHeaders(['a.HTM'], null)).toBe(true)
    expect(shouldApplyHtmlHeaders(['x.txt', 'y.md'], 'text/plain')).toBe(false)
    expect(shouldApplyHtmlHeaders(['a.png'], 'image/png')).toBe(false)
    expect(shouldApplyHtmlHeaders(['a.mp4'], 'video/mp4')).toBe(false)
    expect(htmlResponseHeaders()['Content-Security-Policy']).toBe(WORKSPACE_HTML_CSP)
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
