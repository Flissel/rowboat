import { describe, expect, it } from 'vitest'
import { istVertrauterMcpName, vertrautesMcpWerkzeug } from './vertraute-mcp-werkzeuge.js'

const SERVER = 'rowboat-auftraege'
const WERKZEUG = 'video_auftrag_aus_konzept'
const URL_OK = 'http://127.0.0.1:8156/mcp'

describe('vertrautesMcpWerkzeug', () => {
  it('genau der eingetragene Server, das Werkzeug und die URL: vertraut', () => {
    expect(vertrautesMcpWerkzeug({ serverName: SERVER, toolName: WERKZEUG, serverUrl: URL_OK })).toBe(true)
  })

  it.each([
    ['anderer Servername', { serverName: 'rowboat-auftraege2', toolName: WERKZEUG, serverUrl: URL_OK }],
    ['Servername mit Großbuchstaben', { serverName: 'Rowboat-Auftraege', toolName: WERKZEUG, serverUrl: URL_OK }],
    ['Servername mit Leerzeichen', { serverName: ` ${SERVER}`, toolName: WERKZEUG, serverUrl: URL_OK }],
    ['anderes Werkzeug', { serverName: SERVER, toolName: 'video_auftrag_loeschen', serverUrl: URL_OK }],
    ['Werkzeug mit Großbuchstaben', { serverName: SERVER, toolName: 'Video_Auftrag_Aus_Konzept', serverUrl: URL_OK }],
    ['Werkzeug mit Anhang', { serverName: SERVER, toolName: `${WERKZEUG}_x`, serverUrl: URL_OK }],
  ])('%s: nicht vertraut', (_name, n) => {
    expect(vertrautesMcpWerkzeug(n)).toBe(false)
  })

  it.each([
    ['localhost', 'http://localhost:8156/mcp'],
    ['127.0.0.2', 'http://127.0.0.2:8156/mcp'],
    ['Domain', 'http://auftraege.example.com:8156/mcp'],
    ['Domain mit 127.0.0.1 als Teil', 'http://127.0.0.1.example.com:8156/mcp'],
    ['IPv6-Loopback', 'http://[::1]:8156/mcp'],
    ['anderer Port', 'http://127.0.0.1:8157/mcp'],
    ['ohne Port', 'http://127.0.0.1/mcp'],
    ['https', 'https://127.0.0.1:8156/mcp'],
    ['ws', 'ws://127.0.0.1:8156/mcp'],
    ['Pfad /mcp/', 'http://127.0.0.1:8156/mcp/'],
    ['Pfad /mcp2', 'http://127.0.0.1:8156/mcp2'],
    ['Pfad /MCP', 'http://127.0.0.1:8156/MCP'],
    ['Pfad /', 'http://127.0.0.1:8156/'],
    ['Pfad /x/mcp', 'http://127.0.0.1:8156/x/mcp'],
    ['Benutzer', 'http://nutzer@127.0.0.1:8156/mcp'],
    ['Benutzer und Passwort', 'http://nutzer:geheim@127.0.0.1:8156/mcp'],
    ['Query', 'http://127.0.0.1:8156/mcp?a=1'],
    ['leere Query', 'http://127.0.0.1:8156/mcp?'],
    ['Fragment', 'http://127.0.0.1:8156/mcp#x'],
    ['leeres Fragment', 'http://127.0.0.1:8156/mcp#'],
    ['leerer Text', ''],
    ['Unsinn', 'kein url'],
    ['nur Host', '127.0.0.1:8156/mcp'],
  ])('URL %s: nicht vertraut', (_name, serverUrl) => {
    expect(vertrautesMcpWerkzeug({ serverName: SERVER, toolName: WERKZEUG, serverUrl })).toBe(false)
  })

  it('ohne URL (stdio-Server oder kein Eintrag): nicht vertraut', () => {
    expect(vertrautesMcpWerkzeug({ serverName: SERVER, toolName: WERKZEUG, serverUrl: null })).toBe(false)
  })
})

describe('istVertrauterMcpName', () => {
  it('nur das eingetragene Paar aus Servername und Werkzeug', () => {
    expect(istVertrauterMcpName(SERVER, WERKZEUG)).toBe(true)
    expect(istVertrauterMcpName(SERVER, 'anderes')).toBe(false)
    expect(istVertrauterMcpName('anderer', WERKZEUG)).toBe(false)
    expect(istVertrauterMcpName(WERKZEUG, SERVER)).toBe(false)
  })
})
