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
  it('liest höchstens KONZEPT_LESE_MAX Zeichen', () => {
    const html = '<title>t</title>' + 'x'.repeat(KONZEPT_LESE_MAX + 10) + '<p>ende</p>'
    expect(htmlVisibleText(html).endsWith('ende')).toBe(false)
  })
})
