// Modified for VibeMind (Flissel/rowboat vibemind): new test file (Konzept-Fläche Teil B, Task 7).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionRequest } from './permission-request'

afterEach(cleanup)

const HINWEIS = 'Was im Konzept steht, geht an das Videomodell und kann im Video landen.'

const uebergabe = (extra: Record<string, unknown> = {}) => ({
  pfad: 'knowledge/Konzepte/Herbst.html',
  thema: '<b>KI</b> im Alltag',
  minuten: 4,
  stufen: 2,
  szenen: 9,
  auftrag: null,
  stand: 'a'.repeat(64),
  ziel: 'Übergibt das Konzept an die Video-Werkbank des Ladens <i>Ivan</i>.',
  hinweis: 'irgendein anderer Satz aus der Anfrage',
  ...extra,
})

const toolCall = {
  type: 'tool-call' as const,
  toolCallId: 's1',
  toolName: 'executeMcpTool',
  arguments: { serverName: 'rowboat-auftraege', toolName: 'video_auftrag_aus_konzept' },
}

function karte(u: unknown, handlers: { onApprove?: () => void; onDeny?: () => void } = {}) {
  const permission = {
    kind: 'mcp' as const,
    serverName: 'rowboat-auftraege',
    toolName: 'video_auftrag_aus_konzept',
    uebergabe: u as ReturnType<typeof uebergabe>,
  }
  return render(
    <PermissionRequest
      toolCall={toolCall}
      permission={permission}
      onApprove={handlers.onApprove}
      onApproveSession={() => undefined}
      onApproveAlways={() => undefined}
      onDeny={handlers.onDeny}
    />,
  )
}

describe('Karte für das strenge Ja', () => {
  it('zeigt Ziel, Konzept, Thema, Minuten, Stufen und Szenen als Text und den Hinweis wörtlich', () => {
    const { container } = karte(uebergabe())
    expect(screen.getByText('Konzept an die Video-Werkbank übergeben?')).toBeTruthy()
    expect(screen.getByText('Übergibt das Konzept an die Video-Werkbank des Ladens <i>Ivan</i>.')).toBeTruthy()
    expect(screen.getByText('knowledge/Konzepte/Herbst.html')).toBeTruthy()
    expect(screen.getByText('<b>KI</b> im Alltag')).toBeTruthy()
    expect(screen.getByText('4 Minuten')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('9')).toBeTruthy()
    // Der Hinweis kommt aus dem Code, nicht aus der Anfrage.
    expect(screen.getByText(HINWEIS)).toBeTruthy()
    expect(screen.queryByText('irgendein anderer Satz aus der Anfrage')).toBeNull()
    // Werte sind Text: kein Markup aus der Anfrage im DOM.
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('i')).toBeNull()
    expect(screen.queryByText(/Es gibt schon den Auftrag/)).toBeNull()
  })

  it('nennt einen vorhandenen Auftrag', () => {
    karte(uebergabe({ auftrag: '0a1b2c3d' }))
    expect(screen.getByText('Es gibt schon den Auftrag 0a1b2c3d; es entsteht ein neuer.')).toBeTruthy()
  })

  it('hat genau „Ja, übergeben" und „Nein", kein Erlauben für Sitzung oder immer', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    karte(uebergabe(), { onApprove, onDeny })
    const knoepfe = screen.getAllByRole('button').map((b) => b.textContent?.trim())
    expect(knoepfe).toEqual(['Ja, übergeben', 'Nein'])
    expect(screen.queryByText('Always Allow')).toBeNull()
    expect(screen.queryByText('Allow for Session')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ja, übergeben' }))
    fireEvent.click(screen.getByRole('button', { name: 'Nein' }))
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onDeny).toHaveBeenCalledTimes(1)
  })

  it('ohne gültige Übergabe gibt es nur „Nein"', () => {
    karte({ pfad: 'knowledge/Konzepte/a.html' })
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Nein'])
    expect(screen.getByText('Die Rückfrage ist unvollständig. So lässt sich nichts übergeben.')).toBeTruthy()
  })

  it('andere MCP-Werkzeuge behalten die gewohnte Karte', () => {
    render(
      <PermissionRequest
        toolCall={{ ...toolCall, arguments: { serverName: 'github', toolName: 'create_issue' } }}
        permission={{ kind: 'mcp', serverName: 'github', toolName: 'create_issue' }}
        onApprove={() => undefined}
        onDeny={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: /Allow/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy()
    expect(screen.queryByText('Ja, übergeben')).toBeNull()
  })
})
