import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BEZUG_FARBE,
  GRAPH_ANSICHT_SCHLUESSEL,
  KONZEPT_BEZUG_LEGENDE,
  konzeptBezugKnoten,
  konzeptGraphAnsicht,
  leseGraphAnsicht,
  merkeGraphAnsicht,
} from './konzept-graph-ansicht'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('konzept-graph-ansicht', () => {
  it('merkt die Wahl unter rowboat.graph.ansicht, Vorgabe notizen', () => {
    expect(leseGraphAnsicht()).toBe('notizen')
    merkeGraphAnsicht('konzepte')
    expect(localStorage.getItem(GRAPH_ANSICHT_SCHLUESSEL)).toBe('konzepte')
    expect(leseGraphAnsicht()).toBe('konzepte')
    localStorage.setItem(GRAPH_ANSICHT_SCHLUESSEL, 'quatsch')
    expect(leseGraphAnsicht()).toBe('notizen')
  })

  it('gesperrter Speicher wirft nicht', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('gesperrt') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('gesperrt') })
    expect(leseGraphAnsicht()).toBe('notizen')
    expect(() => merkeGraphAnsicht('konzepte')).not.toThrow()
  })

  it('setzt den Konzepte-Graphen in die Form der 2D-Ansicht um', () => {
    const g = konzeptGraphAnsicht({
      nodes: [
        { id: 'knowledge/Konzepte/a.html', label: 'A', art: 'konzept' },
        { id: 'knowledge/Konzepte/v.html', label: 'V', art: 'videokonzept' },
        { id: 'knowledge/Konzepte/h.html', label: 'H', art: 'html' },
        { id: 'knowledge/Marke.md', label: 'Marke', art: 'notiz' },
      ],
      edges: [
        { source: 'knowledge/Konzepte/a.html', target: 'knowledge/Marke.md', kind: 'verweis' },
        { source: 'knowledge/Konzepte/v.html', target: 'knowledge/Marke.md', kind: 'verweis' },
      ],
    })
    expect(g.nodes.map((n) => n.group)).toEqual(['Konzept', 'Videokonzept', 'HTML-Seite', 'Notiz (Bezug)'])
    expect(g.nodes.every((n) => n.level === undefined)).toBe(true)
    const notiz = g.nodes[3]
    expect(notiz.color).toBe(BEZUG_FARBE.color)
    expect(notiz.degree).toBe(2)
    expect(notiz.radius).toBeLessThan(g.nodes[0].radius + 1)
    expect(g.edges).toEqual([
      { source: 'knowledge/Konzepte/a.html', target: 'knowledge/Marke.md' },
      { source: 'knowledge/Konzepte/v.html', target: 'knowledge/Marke.md' },
    ])
  })

  it('Konzept als Bezug im Notizen-Graphen: Legende und gedämpfte Farbe', () => {
    const n = konzeptBezugKnoten('knowledge/Konzepte/a.html', 'A', 1)
    expect(n.group).toBe(KONZEPT_BEZUG_LEGENDE)
    expect(n.group).toBe('Konzept (Bezug)')
    expect(n.color).toBe(BEZUG_FARBE.color)
    expect(n.level).toBeUndefined()
  })
})
