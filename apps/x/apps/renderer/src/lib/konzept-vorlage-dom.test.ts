// Fuehrt die Videokonzept-Vorlage (Kern-Paket) in jsdom aus: das Skript der Seite muss
// aus dem Datenblock die Szenenkarten zeichnen und Verweise als postMessage senden.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { videoKonzeptSeite } from '../../../../packages/core/src/runtime/assembly/skills/konzept/vorlage'

const VIDEO = { thema: 'KI im Alltag', zielgruppe: 'Inhaber', minuten: 4, hook: 'H', kernaussage: 'K', abschluss: 'A', auftrag: null,
  stufen: [{ name: 'Einstieg', szenen: Array.from({ length: 8 }, (_, i) => ({ kurz: `Szene ${i}`, bildart: 'slide' as const })) }] }

function zeige(html: string): void {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  document.head.innerHTML = doc.head.innerHTML
  document.body.innerHTML = doc.body.innerHTML
  const skript = Array.from(doc.querySelectorAll('script')).find((s) => !s.id)
  // Wie der Rahmen: das Seitenskript laeuft im Dokument; parent ist hier das eigene Fenster.
  new Function(skript!.textContent ?? '')()
}

afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = '' })

describe('Videokonzept-Vorlage im Dokument', () => {
  it('zeichnet 8 Szenenkarten, Zusammenfassung und sendet Verweise per postMessage', () => {
    const senden = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    zeige(videoKonzeptSeite({ art: 'videokonzept', bezuege: ['[[Marke/Marke]]', '[[Konzepte/x.html|Seite]]'], video: { ...VIDEO, auftrag: null } }, 'KI im Alltag'))
    expect(document.querySelectorAll('.szene')).toHaveLength(8)
    expect(document.querySelectorAll('details')).toHaveLength(1)
    expect(document.body.textContent).toContain('Geschätzte Länge 2:00 (Ziel 4:00)')
    expect(document.querySelector('.warnung')).toBeNull()
    const knoepfe = Array.from(document.querySelectorAll('button'))
    expect(knoepfe.map((b) => b.textContent)).toEqual(['Marke/Marke', 'Seite'])
    knoepfe[0].click(); knoepfe[1].click()
    expect(senden).toHaveBeenNthCalledWith(1, { type: 'rowboat:notiz-oeffnen', pfad: 'knowledge/Marke/Marke.md' }, '*')
    expect(senden).toHaveBeenNthCalledWith(2, { type: 'rowboat:notiz-oeffnen', pfad: 'knowledge/Konzepte/x.html' }, '*')
    senden.mockRestore()
  })

  it('warnt außerhalb der Grenzen und zeigt den Auftrag, Daten landen nur als Text', () => {
    const video = { ...VIDEO, minuten: 9, hook: '<img src=x onerror=alert(1)>', auftrag: 'A-7' as unknown as null,
      stufen: [{ name: 'S', szenen: [{ kurz: '<b>fett</b>', bildart: 'clip' as const, notiz: 'n' }] }] }
    zeige(videoKonzeptSeite({ art: 'videokonzept', bezuege: [], video }, 't'))
    expect(document.querySelector('.warnung')?.textContent).toContain('8 bis 15 Szenen')
    expect(document.querySelector('.warnung')?.textContent).toContain('3 und 5 Minuten')
    expect(document.body.textContent).toContain('Übergeben als Auftrag A-7')
    expect(document.querySelector('blockquote img')).toBeNull()
    expect(document.querySelector('.szene b')).toBeNull()
    expect(document.querySelector('.badge')?.textContent).toBe('Clip')
  })
})
