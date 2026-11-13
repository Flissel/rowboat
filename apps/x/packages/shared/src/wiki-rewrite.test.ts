import { describe, expect, it } from 'vitest'
import { htmlUmschreibBereiche } from './konzept.js'
import {
  isRewritableKnowledgePath,
  rewriteWikiLinksInHtml,
  rewriteWikiLinksInMarkdown,
} from './wiki-rewrite.js'

const BLOCK = (bezuege: string) =>
  `<script type="application/json" id="rowboat-konzept">{"art":"konzept","bezuege":${bezuege}}</script>`

describe('htmlUmschreibBereiche', () => {
  it('liefert Datenblock und Text, nicht Tags, andere Skripte, Styles und Kommentare', () => {
    const html = `<p title="[[A]]">[[T1]]</p><!-- [[K]] --><style>a[[0]]{}</style><script>x[[0]]</script>${BLOCK('["[[B]]"]')}<b>[[T2]]</b>`
    const teile = htmlUmschreibBereiche(html).map((b) => `${b.art}:${html.slice(b.start, b.end)}`)
    expect(teile).toEqual(['text:[[T1]]', 'json:{"art":"konzept","bezuege":["[[B]]"]}', 'text:[[T2]]'])
  })
  it('nimmt nur den ersten Datenblock', () => {
    const html = `${BLOCK('["[[A]]"]')}${BLOCK('["[[B]]"]')}`
    expect(htmlUmschreibBereiche(html).filter((b) => b.art === 'json')).toHaveLength(1)
  })
  it('liest auch hinter 1 MB und bricht bei offenem Konstrukt ab', () => {
    const lang = 'x'.repeat(1_100_000)
    const html = `<p>${lang}</p><p>[[Spaet]]</p><!-- offen [[X]]`
    const teile = htmlUmschreibBereiche(html).map((b) => html.slice(b.start, b.end))
    expect(teile).toContain('[[Spaet]]')
    expect(teile.some((t) => t.includes('[[X]]'))).toBe(false)
  })
})

describe('rewriteWikiLinksInMarkdown', () => {
  it('Notiz umbenannt: Verweis ohne Endung bleibt ohne Endung, Alias und Anker bleiben', () => {
    expect(rewriteWikiLinksInMarkdown('[[Marke/Marke#Abschnitt|Label]] [[marke/marke.md]]', 'Marke/Marke.md', 'Marke/Leitbild.md')).toBe(
      '[[Marke/Leitbild#Abschnitt|Label]] [[Marke/Leitbild.md]]',
    )
  })
  it('Konzept umbenannt: Endung bleibt, Alias bleibt, Gross/Klein egal', () => {
    expect(
      rewriteWikiLinksInMarkdown('[[Konzepte/k.html|das Konzept]] und [[Konzepte/K.HTML]]', 'Konzepte/k.html', 'Konzepte/Neu Ä.html'),
    ).toBe('[[Konzepte/Neu Ä.html|das Konzept]] und [[Konzepte/Neu Ä.html]]')
  })
  it('.htm bleibt .htm im Verweis, Verweis auf html trifft nicht eine Notiz gleichen Namens', () => {
    expect(rewriteWikiLinksInMarkdown('[[k.htm]] [[k.html]]', 'k.htm', 'n.htm')).toBe('[[n.htm]] [[k.html]]')
    expect(rewriteWikiLinksInMarkdown('[[k.html]]', 'k.md', 'n.md')).toBe('[[k.html]]')
  })
  it('Verweis ohne Endung auf ein Konzept: ohne Endung, wenn keine Notiz gleichen Namens da ist', () => {
    expect(rewriteWikiLinksInMarkdown('[[Konzepte/k]]', 'Konzepte/k.html', 'Konzepte/neu.html')).toBe('[[Konzepte/neu]]')
  })
  it('Verweis ohne Endung wird nicht umgeschrieben, wenn eine gleichnamige Notiz existiert', () => {
    const mdExists = (s: string) => s === 'konzepte/k'
    expect(rewriteWikiLinksInMarkdown('[[Konzepte/k]]', 'Konzepte/k.html', 'Konzepte/neu.html', { mdExists })).toBe('[[Konzepte/k]]')
  })
  it('Ziel kollidiert mit einer Notiz: Verweis bekommt die Endung', () => {
    const mdExists = (s: string) => s === 'konzepte/neu'
    expect(rewriteWikiLinksInMarkdown('[[Konzepte/k]]', 'Konzepte/k.html', 'Konzepte/neu.html', { mdExists })).toBe(
      '[[Konzepte/neu.html]]',
    )
  })
  it('knowledge/-Präfix bleibt erhalten', () => {
    expect(rewriteWikiLinksInMarkdown('[[knowledge/Konzepte/k.html]]', 'Konzepte/k.html', 'Konzepte/n.html')).toBe(
      '[[knowledge/Konzepte/n.html]]',
    )
  })
  it('Bare-Name nur mit allowBareSelfNameMatch', () => {
    expect(rewriteWikiLinksInMarkdown('[[k.html]] [[k]]', 'a/k.html', 'a/n.html')).toBe('[[k.html]] [[k]]')
    expect(rewriteWikiLinksInMarkdown('[[k.html]] [[k]]', 'a/k.html', 'a/n.html', { allowBareSelfNameMatch: true })).toBe(
      '[[n.html]] [[n]]',
    )
  })
})

describe('rewriteWikiLinksInHtml', () => {
  it('zieht Verweise im Datenblock nach und lässt das JSON gültig, auch bei Anführungszeichen', () => {
    const html = `<html>${BLOCK('["[[Marke/Marke]]","[[Marke/Marke|Alias]]"]')}</html>`
    const neu = rewriteWikiLinksInHtml(html, 'Marke/Marke.md', 'Marke/Neu "Ä" \\ x.md')
    const roh = /<script[^>]*>([\s\S]*?)<\/script>/.exec(neu)![1]
    expect(JSON.parse(roh)).toEqual({ art: 'konzept', bezuege: ['[[Marke/Neu "Ä" \\ x]]', '[[Marke/Neu "Ä" \\ x|Alias]]'] })
  })
  it('lässt Skriptcode, Styles, Kommentare und Attribute unberührt', () => {
    const html = `<p title="[[Marke/Marke]]">[[Marke/Marke]]</p><!-- [[Marke/Marke]] --><style>a[[Marke/Marke]]{}</style><script>var a=b[[Marke/Marke]]</script>`
    const neu = rewriteWikiLinksInHtml(html, 'Marke/Marke.md', 'Marke/Neu.md')
    expect(neu).toBe(html.replace('>[[Marke/Marke]]</p>', '>[[Marke/Neu]]</p>'))
  })
  it('sichtbarer Text: Entitäten werden erkannt und beim Schreiben maskiert', () => {
    const neu = rewriteWikiLinksInHtml('<p>[[A &amp; B]]</p>', 'A & B.md', 'C < D.md')
    expect(neu).toBe('<p>[[C &lt; D]]</p>')
  })
  it('ungültiger Block und fehlender Block stürzen nicht ab', () => {
    const kaputt = '<script type="application/json" id="rowboat-konzept">{ "bezuege": ["[[Marke/Marke]]" </script><p>x</p>'
    expect(rewriteWikiLinksInHtml(kaputt, 'Marke/Marke.md', 'Marke/N.md')).toContain('[[Marke/N]]')
    expect(rewriteWikiLinksInHtml('<p>nichts</p>', 'a.md', 'b.md')).toBe('<p>nichts</p>')
  })
  it('Konzept benennt sich selbst um: Verweise auf sich ziehen mit', () => {
    const html = `<p>[[Konzepte/k.html]]</p>`
    expect(rewriteWikiLinksInHtml(html, 'Konzepte/k.html', 'Konzepte/n.html')).toBe('<p>[[Konzepte/n.html]]</p>')
  })
})

describe('isRewritableKnowledgePath', () => {
  it('Notiz oder HTML unter knowledge/', () => {
    expect(isRewritableKnowledgePath('knowledge/a.md')).toBe(true)
    expect(isRewritableKnowledgePath('knowledge/Konzepte/a.HTML')).toBe(true)
    expect(isRewritableKnowledgePath('knowledge/a.htm')).toBe(true)
    expect(isRewritableKnowledgePath('other/a.html')).toBe(false)
    expect(isRewritableKnowledgePath('knowledge/a.txt')).toBe(false)
    expect(isRewritableKnowledgePath('knowledge/../a.html')).toBe(false)
  })
})
