import { describe, expect, it } from 'vitest'
import {
  cacheBustedUrl,
  canAcceptRequest,
  canConfirm,
  eventTime,
  konzeptHinweise,
  konzeptPathFromTool,
  konzeptSchreibvorgaenge,
  linkOpenRequest,
  nextPendingRequest,
  noteOpenRequest,
  reloadDebounceMs,
  shouldAutoOpen,
  workspaceEventTouches,
} from './konzept-flaeche'

const fertig = (name: string, rel: unknown) => ({ name, status: 'completed', result: { success: true, workspaceRelPath: rel } })

describe('konzept-flaeche', () => {
  it('erkennt Konzept-Schreibvorgänge', () => {
    expect(konzeptPathFromTool(fertig('file-writeText', 'knowledge/Konzepte/k.html'))).toBe('knowledge/Konzepte/k.html')
    expect(konzeptPathFromTool(fertig('file-editText', 'knowledge/Konzepte/k.HTM'))).toBe('knowledge/Konzepte/k.HTM')
    expect(konzeptPathFromTool(fertig('file-writeText', 'knowledge/Kanal/k.html'))).toBeNull()
    expect(konzeptPathFromTool(fertig('file-writeText', 'knowledge/n.md'))).toBeNull()
    expect(konzeptPathFromTool(fertig('file-writeText', 42))).toBeNull()
    expect(konzeptPathFromTool({ name: 'file-writeText', status: 'running' })).toBeNull()
    expect(konzeptPathFromTool({ name: 'file-writeText', status: 'completed', result: 'text' })).toBeNull()
    expect(konzeptPathFromTool(fertig('deck-create', 'knowledge/k.html'))).toBeNull()
  })

  it('öffnet nur beim ersten Schreiben eines Zugs', () => {
    const seen = new Set<string>()
    expect(shouldAutoOpen({ path: 'knowledge/k.html', openedThisTurn: seen, currentPath: null })).toBe(true)
    seen.add('knowledge/k.html')
    expect(shouldAutoOpen({ path: 'knowledge/k.html', openedThisTurn: seen, currentPath: 'knowledge/n.md' })).toBe(false)
    expect(shouldAutoOpen({ path: 'knowledge/j.html', openedThisTurn: seen, currentPath: 'knowledge/j.html' })).toBe(false)
    expect(shouldAutoOpen({ path: 'knowledge/j.html', openedThisTurn: seen, currentPath: 'knowledge/n.md' })).toBe(true)
  })

  describe('konzeptSchreibvorgaenge: Erinnerung je Zug (R41)', () => {
    const nutzer = (id: string) => ({ id, role: 'user', content: 'x' })
    const schreib = (id: string, rel: string, status = 'completed') => ({ id, ...fertig('file-writeText', rel), status })
    const k = 'knowledge/Konzepte/k.html'

    it('öffnet im Zug einmal; spätere Schreibvorgänge im selben Zug laden nur neu', () => {
      const processed = new Set<string>()
      const memory = { turn: null, opened: new Set<string>() }
      const items = [nutzer('t1:user'), schreib('a', k), schreib('b', k), schreib('c', k)]
      expect(konzeptSchreibvorgaenge(items, processed, memory, null)).toEqual([
        { path: k, open: true },
        { path: k, open: false },
        { path: k, open: false },
      ])
    })

    it('neuer Zug -> öffnet wieder, wenn Felix die Fläche geschlossen hat', () => {
      const processed = new Set<string>()
      const memory = { turn: null, opened: new Set<string>() }
      const items = [nutzer('t1:user'), schreib('a', k)]
      expect(konzeptSchreibvorgaenge(items, processed, memory, null)).toEqual([{ path: k, open: true }])
      // Felix schließt die Fläche (zeigt eine Notiz); im selben Zug schreibt der Agent nochmal: bleibt zu
      items.push(schreib('b', k))
      expect(konzeptSchreibvorgaenge(items, processed, memory, 'knowledge/n.md')).toEqual([{ path: k, open: false }])
      // nächste Nutzernachricht ("füge eine Szene ein"), der Agent schreibt: geht wieder auf
      items.push(nutzer('t2:user'), schreib('c', k))
      expect(konzeptSchreibvorgaenge(items, processed, memory, 'knowledge/n.md')).toEqual([{ path: k, open: true }])
    })

    it('nicht, wenn die Datei schon angezeigt wird; ein Zug ohne Nutzertext zählt nach dem Verbrauchseintrag für sich', () => {
      const processed = new Set<string>()
      const memory = { turn: null, opened: new Set<string>() }
      const items = [nutzer('t1:user'), schreib('a', k), { id: 't1:usage', kind: 'turn-usage' }]
      expect(konzeptSchreibvorgaenge(items, processed, memory, k)).toEqual([{ path: k, open: false }])
      items.push(schreib('b', k))
      expect(konzeptSchreibvorgaenge(items, processed, memory, null)).toEqual([{ path: k, open: true }])
    })

    it('schon verarbeitete (beim Sitzungswechsel vorgemerkte) und laufende Aufrufe werden nicht abgespielt', () => {
      const processed = new Set<string>(['a'])
      const memory = { turn: null, opened: new Set<string>() }
      const items = [nutzer('t1:user'), schreib('a', k), schreib('b', k, 'running'), schreib('c', 'knowledge/Kanal/x.html')]
      expect(konzeptSchreibvorgaenge(items, processed, memory, null)).toEqual([])
      expect(processed.has('b')).toBe(false)
      items[2] = schreib('b', k)
      expect(konzeptSchreibvorgaenge(items, processed, memory, null)).toEqual([{ path: k, open: true }])
    })
  })

  it('bündelt mit 300 ms', () => {
    expect(reloadDebounceMs).toBe(300)
  })

  it('prüft Notiz-Anfragen aus dem Rahmen', () => {
    const msg = (pfad: unknown) => ({ type: 'rowboat:notiz-oeffnen', pfad })
    expect(noteOpenRequest(msg('knowledge/Marke/Marke.md'))).toBe('knowledge/Marke/Marke.md')
    expect(noteOpenRequest(msg('knowledge\\Marke\\Marke.md'))).toBe('knowledge/Marke/Marke.md')
    expect(noteOpenRequest(msg('knowledge/../config/mcp.json'))).toBeNull()
    expect(noteOpenRequest(msg('config/mcp.json'))).toBeNull()
    expect(noteOpenRequest(msg('C:/knowledge/x.md'))).toBeNull()
    expect(noteOpenRequest(msg('knowledge'))).toBeNull()
    expect(noteOpenRequest(msg('knowledge/Ordner'))).toBeNull()
    expect(noteOpenRequest(msg('knowledge/Kanal/x.md'))).toBeNull()
    expect(noteOpenRequest(msg('Knowledge/kanal/x.md'))).toBeNull()
    expect(noteOpenRequest(msg('knowledge/Kanal./x.html'))).toBeNull()
    expect(noteOpenRequest(msg('knowledge/a\u0000.md'))).toBeNull()
    expect(noteOpenRequest(msg('knowledge/.git/hooks/x.md'))).toBeNull()
    expect(noteOpenRequest(msg('knowledge/.assets/a.png'))).toBeNull()
    expect(noteOpenRequest(msg('knowledge/Ordner/.versteckt.md'))).toBeNull()
    expect(noteOpenRequest(msg(42))).toBeNull()
    expect(noteOpenRequest({ type: 'rowboat:andere', pfad: 'knowledge/x.md' })).toBeNull()
    expect(noteOpenRequest('rowboat:notiz-oeffnen')).toBeNull()
    expect(noteOpenRequest(null)).toBeNull()
  })

  it('prüft Link-Anfragen aus dem Rahmen', () => {
    const msg = (url: unknown) => ({ type: 'rowboat:link-oeffnen', url })
    expect(linkOpenRequest(msg('https://example.com/a?b=1'))).toBe('https://example.com/a?b=1')
    expect(linkOpenRequest(msg('http://example.com/'))).toBe('http://example.com/')
    expect(linkOpenRequest(msg('javascript:alert(1)'))).toBeNull()
    expect(linkOpenRequest(msg('file:///c:/x'))).toBeNull()
    expect(linkOpenRequest(msg('app://workspace/x'))).toBeNull()
    expect(linkOpenRequest(msg('https://user:pw@example.com/'))).toBeNull()
    expect(linkOpenRequest(msg('https://user@example.com/'))).toBeNull()
    expect(linkOpenRequest(msg('https://example.com/' + 'a'.repeat(3000)))).toBeNull()
    expect(linkOpenRequest(msg('kein url'))).toBeNull()
    expect(linkOpenRequest(msg(42))).toBeNull()
    expect(linkOpenRequest({ type: 'rowboat:notiz-oeffnen', url: 'https://example.com/' })).toBeNull()
    expect(linkOpenRequest('https://example.com/')).toBeNull()
    expect(linkOpenRequest(null)).toBeNull()
  })

  it('sammelt Hinweise', () => {
    expect(konzeptHinweise('<title>t</title><p>x</p>')).toEqual([])
    expect(konzeptHinweise('<script type="application/json" id="rowboat-konzept">{kaputt</script>')).toHaveLength(1)
    const gut = '<script type="application/json" id="rowboat-konzept">{"art":"konzept","bezuege":["[[A]]"]}</script>'
    expect(konzeptHinweise(gut)).toEqual([])
    const ohneKlammern = '<script type="application/json" id="rowboat-konzept">{"art":"konzept","bezuege":["A"]}</script>'
    expect(konzeptHinweise(ohneKlammern)).toHaveLength(1)
  })

  it('meldet Verstöße im Videokonzept', () => {
    const block = '<script type="application/json" id="rowboat-konzept">{"art":"videokonzept","bezuege":["[[A]]"],"video":{"thema":"x"}}</script>'
    expect(konzeptHinweise(block).length).toBeGreaterThan(0)
  })

  it('meldet die Größe nur bei Dateien mit Datenblock', () => {
    const gut = '<script type="application/json" id="rowboat-konzept">{"art":"konzept","bezuege":["[[A]]"]}</script>'
    expect(konzeptHinweise(gut, 2_000_000)).toHaveLength(1)
    expect(konzeptHinweise(gut, 1_048_576)).toEqual([])
    expect(konzeptHinweise('<p>fremd</p>', 4_000_000)).toEqual([])
  })

  it('erkennt Änderungen am Pfad aus workspace:didChange', () => {
    const p = 'knowledge/k.html'
    expect(workspaceEventTouches({ type: 'changed', path: p }, p)).toBe(true)
    expect(workspaceEventTouches({ type: 'created', path: p }, p)).toBe(true)
    expect(workspaceEventTouches({ type: 'changed', path: 'knowledge/x.html' }, p)).toBe(false)
    expect(workspaceEventTouches({ type: 'moved', from: 'knowledge/a.html', to: p }, p)).toBe(true)
    expect(workspaceEventTouches({ type: 'bulkChanged', paths: [p, 'x'] }, p)).toBe(true)
    expect(workspaceEventTouches({ type: 'bulkChanged', paths: ['x'] }, p)).toBe(false)
    expect(workspaceEventTouches({ type: 'bulkChanged' }, p)).toBe(true)
    expect(workspaceEventTouches({ type: 'deleted', path: p }, p)).toBe(false)
    expect(workspaceEventTouches(null, p)).toBe(false)
  })

  it('setzt den Cache-Brecher an die Adresse', () => {
    expect(cacheBustedUrl('app://workspace/knowledge/k.html', 0)).toBe('app://workspace/knowledge/k.html')
    expect(cacheBustedUrl('app://workspace/knowledge/k.html', 3)).toBe('app://workspace/knowledge/k.html?v=3')
    expect(cacheBustedUrl('app://workspace/k.html?x=1', 3)).toBe('app://workspace/k.html?x=1&v=3')
  })

  const req = (id: number, now: number, kind: 'link' | 'note' = 'link', value = 'https://a.example/') =>
    ({ type: 'request', id, kind, value, now }) as const

  it('führt die Rückfrage durch ihre Zustände (Link und Notiz zusammen)', () => {
    const a = nextPendingRequest(null, req(1, 1000))
    expect(a).toEqual({ id: 1, kind: 'link', value: 'https://a.example/', at: 1000 })
    expect(nextPendingRequest(a, req(2, 5000, 'note', 'knowledge/n.md'))).toBe(a)
    expect(nextPendingRequest(a, req(2, 11000, 'link', 'https://b.example/'))).toBe(a)
    expect(nextPendingRequest(a, req(2, 11001, 'note', 'knowledge/n.md'))).toEqual({ id: 2, kind: 'note', value: 'knowledge/n.md', at: 11001 })
    expect(nextPendingRequest(a, { type: 'cancel' })).toBeNull()
    expect(nextPendingRequest(a, { type: 'open' })).toBeNull()
    expect(nextPendingRequest(a, { type: 'reset' })).toBeNull()
    expect(nextPendingRequest(null, { type: 'cancel' })).toBeNull()
  })

  it('nimmt höchstens eine Anfrage zur Zeit an', () => {
    const a = nextPendingRequest(null, req(1, 1000))
    expect(canAcceptRequest(null, false, 1000, null)).toBe(true)
    expect(canAcceptRequest(null, true, 1000, null)).toBe(false)
    expect(canAcceptRequest(a, false, 5000, null)).toBe(false)
    expect(canAcceptRequest(a, false, 11000, null)).toBe(false)
    expect(canAcceptRequest(a, false, 11001, null)).toBe(true)
    expect(canAcceptRequest(a, true, 20000, null)).toBe(false)
  })

  it('hört nach "Abbrechen" 10 s lang nicht auf die Seite', () => {
    expect(canAcceptRequest(null, false, 1000, 1000)).toBe(false)
    expect(canAcceptRequest(null, false, 6000, 1000)).toBe(false)
    expect(canAcceptRequest(null, false, 11000, 1000)).toBe(false)
    expect(canAcceptRequest(null, false, 11001, 1000)).toBe(true)
    // Ruhezeit vorbei, aber Existenzprüfung läuft: weiter nein
    expect(canAcceptRequest(null, true, 20000, 1000)).toBe(false)
    // Uhr springt zurück: die Ruhezeit wird nicht verlängert
    expect(canAcceptRequest(null, false, 500, 1000)).toBe(true)
  })

  it('nimmt Zeitpunkte aus dem Ereignis, nicht aus der verspäteten Behandlung', () => {
    expect(eventTime(300, 900)).toBe(300)
    // Plattform mit anderem Zeitursprung (timeStamp in der Zukunft): nie später als jetzt
    expect(eventTime(5000, 900)).toBe(900)
    const a = nextPendingRequest(null, req(7, 1000))
    const armed = { id: 7, armedAt: 100 }
    // Zeiger kam während der Sperre (Ereignis bei 300), behandelt erst bei 900 nach einem Hänger: nein
    expect(canConfirm(a, armed, { id: 7, at: eventTime(300, 900) }, eventTime(2000, 2000))).toBe(false)
    // Klick-Ereignis vor dem Ansteuern: nein
    expect(canConfirm(a, armed, { id: 7, at: 900 }, eventTime(850, 950))).toBe(false)
    expect(canConfirm(a, armed, { id: 7, at: 900 }, 900)).toBe(false)
    // normale Reihenfolge: Sperre vorbei, dann hinein, dann Klick
    expect(canConfirm(a, armed, { id: 7, at: eventTime(900, 905) }, eventTime(1200, 1210))).toBe(true)
  })

  it('sperrt "Öffnen" 700 ms ab dem gemalten Bild dieser Anfrage und verlangt danach bewusstes Ansteuern', () => {
    const a = nextPendingRequest(null, req(7, 1000))
    expect(canConfirm(null, { id: 7, armedAt: 0 }, { id: 7, at: 900 }, 5000)).toBe(false)
    expect(canConfirm(a, null, { id: 7, at: 900 }, 5000)).toBe(false) // noch nicht gemalt
    // gemalt + 700 ms, aber nicht angesteuert
    expect(canConfirm(a, { id: 7, armedAt: 100 }, null, 5000)).toBe(false)
    // angesteuert, bevor die Sperre ablief (z. B. Zeiger ruhte schon dort): nein
    expect(canConfirm(a, { id: 7, armedAt: 100 }, { id: 7, at: 799 }, 5000)).toBe(false)
    // angesteuert nach Ablauf der Sperre, danach geklickt: ja
    expect(canConfirm(a, { id: 7, armedAt: 100 }, { id: 7, at: 800 }, 801)).toBe(true)
    expect(canConfirm(a, { id: 7, armedAt: 100 }, { id: 7, at: 2000 }, 2500)).toBe(true)
    // angesteuert für eine andere Anfrage: nein
    expect(canConfirm(a, { id: 7, armedAt: 100 }, { id: 6, at: 2000 }, 2500)).toBe(false)
    // Bild einer anderen (älteren) Anfrage schaltet die neue nicht frei
    expect(canConfirm(a, { id: 6, armedAt: 0 }, { id: 7, at: 2000 }, 5000)).toBe(false)
    // spätes Bild: Sperre zählt ab dem Bild, nicht ab der Anfrage
    expect(canConfirm(a, { id: 7, armedAt: 4000 }, { id: 7, at: 4500 }, 4500)).toBe(false)
  })
})
