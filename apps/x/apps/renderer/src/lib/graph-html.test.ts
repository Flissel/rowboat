import { describe, expect, it } from 'vitest'
import { konzept } from '@x/shared'
import { graphHtmlData, graphNodeLabel, knowledgeHtmlFiles } from './graph-html'
import { wikiLabel } from './wiki-links'

describe('graph-html', () => {
  it('benennt Knoten', () => {
    expect(graphNodeLabel('knowledge/Konzepte/x.html', '<title>Mein Konzept</title>')).toBe('Mein Konzept')
    expect(graphNodeLabel('knowledge/Konzepte/x.HTM', '<p>ohne</p>')).toBe('x')
    expect(graphNodeLabel('knowledge/Konzepte/y.xhtml', '')).toBe('y')
  })

  it('benennt Notizen wie bisher', () => {
    expect(graphNodeLabel('knowledge/Notiz.md', '# Titel\n<title>nein</title>')).toBe('Notiz')
  })

  it('kappt große Dateien', () => {
    expect(graphHtmlData('a'.repeat(konzept.KONZEPT_LESE_MAX + 5)).length).toBe(konzept.KONZEPT_LESE_MAX)
    expect(graphHtmlData('klein')).toBe('klein')
  })

  it('listet HTML-Dateien unter knowledge/ ohne Praefix und mit Endung', () => {
    expect(knowledgeHtmlFiles([
      'knowledge/Notiz.md',
      'knowledge/Konzepte/a.html',
      'knowledge/Konzepte/b.XHTML',
      'knowledge/Bild.png',
      'other/c.html',
    ])).toEqual(['Konzepte/a.html', 'Konzepte/b.XHTML'])
  })

  it('wikiLabel zeigt HTML-Namen ohne Endung', () => {
    expect(wikiLabel('Konzepte/x.html')).toBe('x')
    expect(wikiLabel('Konzepte/x.xhtml')).toBe('x')
    expect(wikiLabel('Konzepte/x.HTM')).toBe('x')
  })
})
