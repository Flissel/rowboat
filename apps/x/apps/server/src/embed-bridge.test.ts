import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { ipc } from '@x/shared'
import {
  EMBED_CLOSE_UNAUTHORIZED, EMBED_TOO_LARGE, EMBED_UNSUPPORTED,
  isEmbedSender, startEmbedBridge, type EmbedBridge, type EmbedBridgeOptions, type EmbedSender,
} from './embed-bridge.js'

type Msg = Record<string, unknown>
const TOKEN = 'geheim-geheim-geheim'
const open: EmbedBridge[] = []
afterEach(async () => { while (open.length) await open.pop()!.close() })

async function bridge(over: Partial<EmbedBridgeOptions> = {}) {
  const calls: Array<{ channel: string; args: unknown; sender: EmbedSender }> = []
  const shown: number[] = []
  const b = await startEmbedBridge({
    token: TOKEN,
    invokeChannels: () => ['workspace:exists', 'turns:subscribe'],
    isUnsupported: (c) => c.startsWith('browser:'),
    invoke: async (channel, sender, args) => { calls.push({ channel, args, sender }); return { echo: args } },
    serveApp: async () => new Response('x'),
    onShowApp: () => { shown.push(1) },
    helloTimeoutMs: 300,
    ...over,
  })
  open.push(b)
  return { b, calls, shown }
}

function client(b: EmbedBridge, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/embed`, { headers })
  const inbox: Msg[] = []
  const waiters: Array<(m: Msg) => void> = []
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Msg
    const w = waiters.shift()
    if (w) w(m); else inbox.push(m)
  })
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    ws.on('error', reject)
  })
  const next = () => inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<Msg>((r) => waiters.push(r))
  const send = (m: Msg) => ws.send(JSON.stringify(m))
  return { ws, opened, closed, next, send }
}

async function loggedIn(b: EmbedBridge) {
  const c = client(b)
  await c.opened
  c.send({ type: 'hello', v: 1, token: TOKEN })
  const welcome = await c.next()
  return { ...c, welcome }
}

describe('Einbettungszugang: Anmeldung', () => {
  it('falsches Token schliesst mit 4401, nichts wird aufgerufen', async () => {
    const { b, calls } = await bridge()
    const c = client(b); await c.opened
    c.send({ type: 'hello', v: 1, token: 'falsch' })
    expect(await c.closed).toBe(EMBED_CLOSE_UNAUTHORIZED)
    expect(calls).toEqual([])
  })
  it('erste Nachricht ist kein hello: 4401', async () => {
    const { b, calls } = await bridge()
    const c = client(b); await c.opened
    c.send({ type: 'invoke', id: 1, channel: 'workspace:exists', args: { path: 'a' } })
    expect(await c.closed).toBe(EMBED_CLOSE_UNAUTHORIZED)
    expect(calls).toEqual([])
  })
  it('kein hello innerhalb der Frist: 4401', async () => {
    const { b } = await bridge()
    const c = client(b); await c.opened
    expect(await c.closed).toBe(EMBED_CLOSE_UNAUTHORIZED)
  })
  it('Browser-Origin wird beim Upgrade abgewiesen', async () => {
    const { b } = await bridge()
    await expect(client(b, { origin: 'https://evil.example' }).opened).rejects.toThrow('HTTP 403')
  })
  it('fremder Host-Header wird abgewiesen (DNS-Rebinding)', async () => {
    const { b } = await bridge()
    await expect(client(b, { host: `localhost:${b.port}` }).opened).rejects.toThrow('HTTP 403')
  })
  it('welcome nennt die Aufrufkanaele', async () => {
    const { b } = await bridge()
    const c = await loggedIn(b)
    expect(c.welcome).toEqual({ type: 'welcome', v: 1, invokeChannels: ['workspace:exists', 'turns:subscribe'] })
  })
})

describe('Einbettungszugang: Aufrufe', () => {
  it('Ergebnis kommt mit derselben id zurueck', async () => {
    const { b, calls } = await bridge()
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 7, channel: 'workspace:exists', args: { path: 'a.md' } })
    expect(await c.next()).toEqual({ type: 'result', id: 7, ok: true, result: { echo: { path: 'a.md' } } })
    expect(calls[0]?.channel).toBe('workspace:exists')
  })
  it('Fehler des Handlers kommt als ok:false mit Meldung', async () => {
    const { b } = await bridge({ invoke: async () => { throw new Error('kaputt') } })
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 1, channel: 'workspace:exists', args: null })
    expect(await c.next()).toEqual({ type: 'result', id: 1, ok: false, error: { message: 'kaputt' } })
  })
  it('Zod-Fehler gleicht dem Electron-Weg (gleiche validateRequest-Meldung)', async () => {
    const { b } = await bridge({
      invoke: async (channel, _s, args) => ipc.validateRequest(channel as 'workspace:exists', args),
    })
    let expected = ''
    try { ipc.validateRequest('workspace:exists', { path: 42 }) } catch (e) { expected = (e as Error).message }
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 2, channel: 'workspace:exists', args: { path: 42 } })
    const r = await c.next()
    expect(r.ok).toBe(false)
    expect((r.error as Msg).message).toBe(expected)
  })
  it('fensterbezogener Kanal: embed_unsupported, Handler wird nicht aufgerufen', async () => {
    const { b, calls } = await bridge()
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 3, channel: 'browser:setVisible', args: { visible: true } })
    const r = await c.next()
    expect(r.ok).toBe(false)
    expect((r.error as Msg).code).toBe(EMBED_UNSUPPORTED)
    expect(calls).toEqual([])
  })
  it('zu grosse Antwort: embed_too_large, Verbindung bleibt offen', async () => {
    const { b } = await bridge({ maxMessageBytes: 1024, invoke: async () => 'x'.repeat(4096) })
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 4, channel: 'workspace:exists', args: null })
    const r = await c.next()
    expect(r).toMatchObject({ type: 'result', id: 4, ok: false, error: { code: EMBED_TOO_LARGE } })
    c.send({ type: 'invoke', id: 5, channel: 'workspace:exists', args: null })
    expect((await c.next()).id).toBe(5)
  })
  it('zu grosse eingehende Nachricht schliesst mit 1009', async () => {
    const { b } = await bridge({ maxMessageBytes: 1024 })
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 6, channel: 'workspace:exists', args: 'x'.repeat(4096) })
    expect(await c.closed).toBe(1009)
  })
  it('show-app ruft onShowApp', async () => {
    const { b, shown } = await bridge()
    const c = await loggedIn(b)
    c.send({ type: 'show-app' })
    await new Promise((r) => setTimeout(r, 50))
    expect(shown).toEqual([1])
  })
})

describe('Einbettungszugang: Absender und Push', () => {
  it('sender.send erreicht nur die aufrufende Verbindung', async () => {
    const { b } = await bridge({
      invoke: async (_c, sender, args) => { sender.send('voice:tts-chunk', { by: args }); return { ok: true } },
    })
    const a = await loggedIn(b)
    const other = await loggedIn(b)
    a.send({ type: 'invoke', id: 1, channel: 'workspace:exists', args: 'a' })
    expect(await a.next()).toEqual({ type: 'push', channel: 'voice:tts-chunk', payload: { by: 'a' } })
    expect((await a.next()).type).toBe('result')
    other.send({ type: 'invoke', id: 9, channel: 'workspace:exists', args: 'b' })
    // Waere der Push von a durchgesickert, kaeme hier zuerst { by: 'a' }.
    expect(await other.next()).toEqual({ type: 'push', channel: 'voice:tts-chunk', payload: { by: 'b' } })
  })
  it('Absender ist als Einbettung erkennbar, hat eigene id und wird beim Schliessen zerstoert', async () => {
    const seen: EmbedSender[] = []
    const { b } = await bridge({ invoke: async (_c, s) => { seen.push(s); return null } })
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 1, channel: 'workspace:exists', args: null })
    await c.next()
    const sender = seen[0]!
    expect(isEmbedSender(sender)).toBe(true)
    expect(isEmbedSender({ id: 1, send() {} })).toBe(false)
    expect(sender.id).toBeGreaterThanOrEqual(1_000_000_000)
    let destroyedEvent = false
    sender.once('destroyed', () => { destroyedEvent = true })
    c.ws.close()
    await c.closed
    await new Promise((r) => setTimeout(r, 50))
    expect(sender.isDestroyed()).toBe(true)
    expect(destroyedEvent).toBe(true)
    expect(b.connectionCount()).toBe(0)
  })
  it('broadcast erreicht alle angemeldeten Verbindungen, keine unangemeldeten', async () => {
    const { b } = await bridge({ helloTimeoutMs: 2000 })
    const a = await loggedIn(b)
    const anon = client(b); await anon.opened
    b.broadcast('runs:events', { x: 1 })
    expect(await a.next()).toEqual({ type: 'push', channel: 'runs:events', payload: { x: 1 } })
    anon.send({ type: 'hello', v: 1, token: TOKEN })
    expect((await anon.next()).type).toBe('welcome') // kein Push vor der Anmeldung
  })
})

describe('Einbettungszugang: Schliessen und Fehlerpfade', () => {
  it('close() endet zuegig, auch mit unangemeldeter Verbindung', async () => {
    const { b } = await bridge({ helloTimeoutMs: 60_000 })
    const c = client(b); await c.opened
    const done = await Promise.race([
      b.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('hang'), 3000)),
    ])
    expect(done).toBe('closed')
    await c.closed
  })
  it('hello nach Beginn von close() ergibt kein welcome und keinen Handleraufruf', async () => {
    const { b, calls } = await bridge({ helloTimeoutMs: 60_000 })
    const c = client(b); await c.opened
    const closing = b.close()
    let welcomed = false
    c.ws.on('message', () => { welcomed = true })
    try { c.send({ type: 'hello', v: 1, token: TOKEN }) } catch { /* Socket schon zu */ }
    try { c.send({ type: 'invoke', id: 1, channel: 'workspace:exists', args: null }) } catch { /* ebenso */ }
    await c.closed
    await closing
    expect(welcomed).toBe(false)
    expect(calls).toEqual([])
    expect(b.connectionCount()).toBe(0)
  })
  it('synchron werfender invoke ergibt ok:false mit Meldung', async () => {
    const { b } = await bridge({ invoke: (() => { throw new Error('sync kaputt') }) as EmbedBridgeOptions['invoke'] })
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 1, channel: 'workspace:exists', args: null })
    expect(await c.next()).toEqual({ type: 'result', id: 1, ok: false, error: { message: 'sync kaputt' } })
  })
  it('nicht serialisierbares Ergebnis (BigInt) ergibt ok:false, Verbindung bleibt nutzbar', async () => {
    let n = 0
    const { b } = await bridge({ invoke: async () => (n++ === 0 ? { v: 10n } : 'fein') })
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 1, channel: 'workspace:exists', args: null })
    const r = await c.next()
    expect(r).toMatchObject({ type: 'result', id: 1, ok: false })
    c.send({ type: 'invoke', id: 2, channel: 'workspace:exists', args: null })
    expect(await c.next()).toEqual({ type: 'result', id: 2, ok: true, result: 'fein' })
  })
  it('werfendes isUnsupported ergibt ok:false fuer diese id', async () => {
    const { b } = await bridge({ isUnsupported: () => { throw new Error('u kaputt') } })
    const c = await loggedIn(b)
    c.send({ type: 'invoke', id: 1, channel: 'workspace:exists', args: null })
    expect(await c.next()).toEqual({ type: 'result', id: 1, ok: false, error: { message: 'u kaputt' } })
  })
})
