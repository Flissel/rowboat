import { describe, expect, it } from 'vitest'
import {
  ABSAGE_ABGELEHNT,
  ABSAGE_OHNE_JA,
  KonzeptUebergabe,
  UEBERGABE_HINWEIS,
  UEBERGABE_ZIEL_MAX,
  istStrengeAnfrage,
  strengeFreigabe,
  turnVonAgent,
  uebergabePfadFehler,
  uebergabeZiel,
} from './strenge-freigabe.js'
import { ToolPermissionMetadata } from './runs.js'
import { InputAdded, TurnCreated } from './turns.js'
import { validateRequest } from './ipc.js'

describe('strengeFreigabe', () => {
  it('ist wahr für rowboat-auftraege / video_auftrag_aus_konzept', () => {
    expect(strengeFreigabe('rowboat-auftraege', 'video_auftrag_aus_konzept')).toBe(true)
  })

  it('ist falsch für andere Werkzeuge, auch auf demselben Server', () => {
    expect(strengeFreigabe('rowboat-auftraege', 'health')).toBe(false)
    expect(strengeFreigabe('rowboat-werkzeuge', 'github_suchen')).toBe(false)
    expect(strengeFreigabe('wissen', 'wissen_suchen')).toBe(false)
    expect(strengeFreigabe('rowboat-auftraege', '')).toBe(false)
  })

  it('hängt nicht am Servernamen: derselbe Dienst unter anderem Namen bleibt streng', () => {
    // Der Dienst kennt sein Werkzeug nur unter diesem Namen; ein zweiter mcp.json-Eintrag (oder ein fremder Server mit
    // demselben Werkzeugnamen) darf nicht am Ja vorbeiführen. Falsch-positiv heißt nur: ein Mensch wird gefragt.
    expect(strengeFreigabe('auftraege-2', 'video_auftrag_aus_konzept')).toBe(true)
    expect(strengeFreigabe('Rowboat-Auftraege', 'video_auftrag_aus_konzept')).toBe(true)
    expect(strengeFreigabe('', 'video_auftrag_aus_konzept')).toBe(true)
  })

  it('ist streng auch bei Schreibvarianten des Werkzeugnamens', () => {
    for (const name of [
      'VIDEO_AUFTRAG_AUS_KONZEPT',
      ' video_auftrag_aus_konzept ',
      'video-auftrag-aus-konzept',
      'video.auftrag.aus.konzept',
      'Video_Auftrag_Aus_Konzept',
    ]) {
      expect(strengeFreigabe('rowboat-auftraege', name)).toBe(true)
    }
  })
})

describe('istStrengeAnfrage', () => {
  it('erkennt die MCP-Anfrage für das strenge Werkzeug', () => {
    expect(istStrengeAnfrage({ kind: 'mcp', serverName: 'rowboat-auftraege', toolName: 'video_auftrag_aus_konzept' })).toBe(true)
    expect(istStrengeAnfrage({ kind: 'mcp', toolName: 'video_auftrag_aus_konzept' })).toBe(true)
    expect(istStrengeAnfrage({ kind: 'mcp', serverName: 'github', toolName: 'create_issue' })).toBe(false)
    expect(istStrengeAnfrage({ kind: 'tool', toolId: 'x', toolName: 'video_auftrag_aus_konzept' })).toBe(false)
    expect(istStrengeAnfrage(null)).toBe(false)
    expect(istStrengeAnfrage('video_auftrag_aus_konzept')).toBe(false)
  })
})

describe('uebergabePfadFehler', () => {
  it('lässt Konzepte unter knowledge/Konzepte/ als HTML durch', () => {
    expect(uebergabePfadFehler('knowledge/Konzepte/Video Herbst.html')).toBeNull()
    expect(uebergabePfadFehler('knowledge/Konzepte/2026/Video.html')).toBeNull()
  })

  it('lehnt alles andere mit einem klaren Satz ab', () => {
    const ausserhalb = 'Übergeben lassen sich nur Konzepte unter knowledge/Konzepte/ als HTML-Datei.'
    expect(uebergabePfadFehler('')).toBe('Für die Übergabe fehlt der Pfad des Konzepts.')
    expect(uebergabePfadFehler('knowledge/Kanal/x.html')).toBe('Aus knowledge/Kanal/ wird nichts übergeben.')
    expect(uebergabePfadFehler('knowledge/kanal/Konzepte/x.html')).toBe('Aus knowledge/Kanal/ wird nichts übergeben.')
    expect(uebergabePfadFehler('knowledge/Notizen/x.html')).toBe(ausserhalb)
    expect(uebergabePfadFehler('knowledge/Konzepte/x.md')).toBe(ausserhalb)
    expect(uebergabePfadFehler('knowledge/Konzepte/x.htm')).toBe(ausserhalb)
    expect(uebergabePfadFehler('knowledge/Konzepte/../Kanal/x.html')).toBe(ausserhalb)
    expect(uebergabePfadFehler('knowledge/Konzepte/../../config/mcp.json')).toBe(ausserhalb)
    expect(uebergabePfadFehler('/home/x/knowledge/Konzepte/x.html')).toBe(ausserhalb)
    expect(uebergabePfadFehler('C:/x/knowledge/Konzepte/x.html')).toBe(ausserhalb)
    expect(uebergabePfadFehler('knowledge/Konzepte/')).toBe(ausserhalb)
    expect(uebergabePfadFehler('knowledge/Konzepte/x\u0000.html')).toBe(ausserhalb)
  })
})

describe('uebergabeZiel', () => {
  it('macht aus der Beschreibung schlichten Text mit Längengrenze', () => {
    expect(uebergabeZiel('Übergibt ein Videokonzept\n an die   Werkbank.')).toBe('Übergibt ein Videokonzept an die Werkbank.')
    expect(uebergabeZiel('a\u0000b\u001bc')).toBe('a b c')
    const lang = uebergabeZiel('x'.repeat(UEBERGABE_ZIEL_MAX + 50))
    expect(lang.length).toBe(UEBERGABE_ZIEL_MAX)
    expect(lang.endsWith('…')).toBe(true)
    expect(uebergabeZiel(undefined)).toBe('')
  })
})

describe('turnVonAgent', () => {
  const turn = (herkunft: 'agent' | undefined, steered: Array<'agent' | undefined>) => ({
    definition: { config: herkunft === undefined ? {} : { herkunft } },
    addedInputs: steered.map((h) => ({ event: h === undefined ? {} : { herkunft: h } })),
  })

  it('ist wahr, sobald der Lauf oder eine nachgereichte Eingabe vom Agenten kommt', () => {
    expect(turnVonAgent(turn(undefined, []))).toBe(false)
    expect(turnVonAgent(turn('agent', []))).toBe(true)
    expect(turnVonAgent(turn(undefined, [undefined, 'agent']))).toBe(true)
    expect(turnVonAgent(turn(undefined, [undefined]))).toBe(false)
  })
})

describe('Herkunft im Protokoll und an der Schnittstelle', () => {
  const created = {
    type: 'turn_created',
    schemaVersion: 1,
    turnId: 't1',
    ts: 'x',
    sessionId: 's1',
    agent: { requested: { agentId: 'copilot' }, resolved: { agentId: 'copilot', model: { provider: 'p', model: 'm' }, inheritedFrom: 't0' } },
    context: [],
    input: { role: 'user', content: 'hi' },
    config: { autoPermission: true, humanAvailable: true, maxModelCalls: 5 },
  }

  it('turn_created.config.herkunft bleibt erhalten, nur "agent" ist erlaubt', () => {
    const mitAgent = TurnCreated.parse({ ...created, config: { ...created.config, herkunft: 'agent' } })
    expect(mitAgent.config.herkunft).toBe('agent')
    expect(TurnCreated.parse(created).config.herkunft).toBeUndefined()
    expect(TurnCreated.safeParse({ ...created, config: { ...created.config, herkunft: 'mensch' } }).success).toBe(false)
  })

  it('input_added.herkunft bleibt erhalten', () => {
    const e = InputAdded.parse({
      type: 'input_added',
      turnId: 't1',
      ts: 'x',
      inputIndex: 1,
      message: { role: 'user', content: 'mehr' },
      herkunft: 'agent',
    })
    expect(e.herkunft).toBe('agent')
  })

  it('sessions:sendMessage und sessions:sendOrQueueMessage nehmen herkunft: "agent" an', () => {
    for (const kanal of ['sessions:sendMessage', 'sessions:sendOrQueueMessage'] as const) {
      const args = validateRequest(kanal, {
        sessionId: 's1',
        input: { role: 'user', content: 'hi' },
        config: { agent: { agentId: 'copilot' }, autoPermission: true, herkunft: 'agent' },
      })
      expect(args.config.herkunft).toBe('agent')
    }
  })
})

describe('Texte und Schema', () => {
  it('Hinweis und Absagen stehen wörtlich wie im Plan', () => {
    expect(UEBERGABE_HINWEIS).toBe('Was im Konzept steht, geht an das Videomodell und kann im Video landen.')
    expect(ABSAGE_OHNE_JA).toBe('Die Übergabe braucht ein Ja von Felix in der App.')
    expect(ABSAGE_ABGELEHNT).toBe('Felix hat abgelehnt.')
  })

  const uebergabe = {
    pfad: 'knowledge/Konzepte/x.html',
    thema: 'Herbst',
    minuten: 4,
    stufen: 3,
    szenen: 10,
    auftrag: null,
    stand: 'a'.repeat(64),
    ziel: 'Übergibt ein Videokonzept.',
    hinweis: UEBERGABE_HINWEIS,
  }

  it('KonzeptUebergabe nimmt eine vollständige Übergabe an und lehnt einen falschen Stand ab', () => {
    expect(KonzeptUebergabe.parse(uebergabe)).toEqual(uebergabe)
    expect(KonzeptUebergabe.safeParse({ ...uebergabe, stand: 'xyz' }).success).toBe(false)
    expect(KonzeptUebergabe.safeParse({ ...uebergabe, auftrag: '0a1b2c3d' }).success).toBe(true)
  })

  it('die MCP-Anfrage behält die Übergabe beim Prüfen (Fern-Modus)', () => {
    const anfrage = { kind: 'mcp', serverName: 'rowboat-auftraege', toolName: 'video_auftrag_aus_konzept', uebergabe }
    expect(ToolPermissionMetadata.parse(anfrage)).toEqual(anfrage)
    // Andere MCP-Anfragen bleiben, wie sie sind.
    expect(ToolPermissionMetadata.parse({ kind: 'mcp', serverName: 'github', toolName: 'q' })).toEqual({
      kind: 'mcp',
      serverName: 'github',
      toolName: 'q',
    })
  })
})
