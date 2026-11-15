import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphMitAnsicht } from './graph-ansicht'
import type { GraphNode } from './graph-view'
import { GRAPH_ANSICHT_SCHLUESSEL, KONZEPTE_LEER } from '@/lib/konzept-graph-ansicht'

class StillerBeobachter {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StillerBeobachter)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const knoten = (id: string, label: string, group: string): GraphNode => ({
  id, label, degree: 0, radius: 6, group, color: '#888', stroke: '#444',
})
const notizen = { nodes: [knoten('knowledge/Notiz.md', 'Eine Notiz', 'root')], edges: [] }
const konzepte = {
  nodes: [knoten('knowledge/Konzepte/a.html', '<img src=x onerror=alert(1)>', 'Konzept')],
  edges: [],
}

describe('GraphMitAnsicht', () => {
  it('zeigt den Umschalter, Vorgabe Notizen', () => {
    render(<GraphMitAnsicht notizen={notizen} konzepte={konzepte} error={null} onSelectNode={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Notizen' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Konzepte' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Eine Notiz')).toBeInTheDocument()
  })

  it('wechselt auf Konzepte, merkt die Wahl, zeigt Titel als Text und keinen 3D-Schalter', () => {
    const { container } = render(<GraphMitAnsicht notizen={notizen} konzepte={konzepte} error={null} onSelectNode={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Konzepte' }))
    expect(localStorage.getItem(GRAPH_ANSICHT_SCHLUESSEL)).toBe('konzepte')
    expect(screen.queryByText('Eine Notiz')).toBeNull()
    expect(screen.getAllByText('<img src=x onerror=alert(1)>').length).toBeGreaterThan(0)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button', { name: '3D' })).toBeNull()
    expect(screen.queryByRole('button', { name: '2D' })).toBeNull()
  })

  it('startet mit der gemerkten Wahl und zeigt den leeren Zustand', () => {
    localStorage.setItem(GRAPH_ANSICHT_SCHLUESSEL, 'konzepte')
    render(<GraphMitAnsicht notizen={notizen} konzepte={{ nodes: [], edges: [] }} error={null} onSelectNode={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Konzepte' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(KONZEPTE_LEER)).toBeInTheDocument()
    expect(screen.queryByText('No notes found.')).toBeNull()
  })
})
