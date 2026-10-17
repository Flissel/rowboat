import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { tokenMatches } from './auth.js';

// VibeMind-Einbettung (Spec vibemind-os 2026-10-17-rowboat-einbettung): ein lokaler Zugang, ueber
// den eine fremde Electron-Ansicht (die Multiverse-Ansicht der voice-App) Rowboats eigene
// IPC-Handler aufruft. Nur 127.0.0.1, Token pro Start, erste Nachricht = hello. Der Kern hier
// kennt kein Electron; apps/main/src/embed-host.ts verdrahtet ihn mit der Handler-Tabelle.

export const EMBED_PROTOCOL_VERSION = 1;
export const EMBED_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const EMBED_HELLO_TIMEOUT_MS = 5000;
export const EMBED_CLOSE_UNAUTHORIZED = 4401;
export const EMBED_CLOSE_BAD_MESSAGE = 4400;
export const EMBED_UNSUPPORTED = 'embed_unsupported';
export const EMBED_TOO_LARGE = 'embed_too_large';

const EMBED_SENDER = Symbol.for('rowboat.embedSender');
// Weit weg von echten webContents-IDs (file-previews.ts schluesselt nach sender.id).
let nextSenderId = 1_000_000_000;

/** Nachgebauter `event.sender` einer Einbettungs-Verbindung (das, was Handler davon benutzen). */
export interface EmbedSender {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  on(event: 'destroyed', listener: () => void): this;
  once(event: 'destroyed', listener: () => void): this;
  removeListener(event: 'destroyed', listener: () => void): this;
}

class EmbedSenderImpl extends EventEmitter implements EmbedSender {
  readonly [EMBED_SENDER] = true;
  readonly id = nextSenderId++;
  private destroyed = false;

  constructor(private readonly deliver: (channel: string, payload: unknown) => void) {
    super();
  }

  send(channel: string, payload: unknown): void {
    if (!this.destroyed) this.deliver(channel, payload);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
    this.removeAllListeners();
  }
}

export function isEmbedSender(x: unknown): x is EmbedSender {
  return typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[EMBED_SENDER] === true;
}

export function generateEmbedToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export interface EmbedBridgeOptions {
  token: string;
  /** Validiert, ruft den Handler (oder den rowboat-server-Zwilling) und validiert die Antwort. */
  invoke(channel: string, sender: EmbedSender, args: unknown): Promise<unknown>;
  invokeChannels(): readonly string[];
  isUnsupported(channel: string): boolean;
  /** Der app://-Handler der App (Task 3). */
  serveApp(request: Request): Promise<Response>;
  onShowApp(): void;
  port?: number;
  helloTimeoutMs?: number;
  maxMessageBytes?: number;
  log?(message: string): void;
}

export interface EmbedBridge {
  readonly port: number;
  broadcast(channel: string, payload: unknown): void;
  connectionCount(): number;
  close(): Promise<void>;
}

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), v: z.literal(EMBED_PROTOCOL_VERSION), token: z.string() }),
  z.object({ type: z.literal('invoke'), id: z.number().int().nonnegative(), channel: z.string().min(1), args: z.unknown() }),
  z.object({ type: z.literal('show-app') }),
]);

interface Connection {
  socket: WebSocket;
  sender: EmbedSenderImpl;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startEmbedBridge(opts: EmbedBridgeOptions): Promise<EmbedBridge> {
  const log = opts.log ?? (() => {});
  const helloTimeoutMs = opts.helloTimeoutMs ?? EMBED_HELLO_TIMEOUT_MS;
  const maxBytes = opts.maxMessageBytes ?? EMBED_MAX_MESSAGE_BYTES;
  const connections = new Set<Connection>();
  let port = 0;

  const fromBrowser = (req: IncomingMessage) => req.headers.origin !== undefined;
  const hostOk = (req: IncomingMessage) => req.headers.host === `127.0.0.1:${port}`;

  const http = createServer((req, res) => {
    void handleHttp(req, res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBytes });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/embed' || !hostOk(req) || fromBrowser(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  function attach(socket: WebSocket): void {
    let sender: EmbedSenderImpl | null = null;
    const helloTimer = setTimeout(() => socket.close(EMBED_CLOSE_UNAUTHORIZED, 'hello timeout'), helloTimeoutMs);
    const sendJson = (msg: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    };

    socket.on('message', (data: RawData) => {
      let msg: z.infer<typeof ClientMessage>;
      try {
        msg = ClientMessage.parse(JSON.parse(data.toString()));
      } catch {
        socket.close(sender ? EMBED_CLOSE_BAD_MESSAGE : EMBED_CLOSE_UNAUTHORIZED, 'bad message');
        return;
      }
      if (!sender) {
        if (msg.type !== 'hello' || !tokenMatches(msg.token, opts.token)) {
          socket.close(EMBED_CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        clearTimeout(helloTimer);
        const own = new EmbedSenderImpl((channel, payload) => sendJson({ type: 'push', channel, payload }));
        sender = own;
        const entry: Connection = { socket, sender: own };
        connections.add(entry);
        socket.once('close', () => connections.delete(entry));
        sendJson({ type: 'welcome', v: EMBED_PROTOCOL_VERSION, invokeChannels: [...opts.invokeChannels()] });
        return;
      }
      if (msg.type === 'hello') return;
      if (msg.type === 'show-app') {
        opts.onShowApp();
        return;
      }
      const { id, channel, args } = msg;
      if (opts.isUnsupported(channel)) {
        sendJson({ type: 'result', id, ok: false, error: { code: EMBED_UNSUPPORTED, message: `${EMBED_UNSUPPORTED}: ${channel} gibt es nur im Rowboat-Fenster` } });
        return;
      }
      opts.invoke(channel, sender, args).then(
        (result) => {
          const text = JSON.stringify({ type: 'result', id, ok: true, result });
          if (Buffer.byteLength(text) > maxBytes) {
            sendJson({ type: 'result', id, ok: false, error: { code: EMBED_TOO_LARGE, message: `${EMBED_TOO_LARGE}: Antwort auf ${channel} ueber ${maxBytes} Bytes` } });
            return;
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        },
        (err: unknown) => sendJson({ type: 'result', id, ok: false, error: { message: errorMessage(err) } }),
      );
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      sender?.destroy();
    });
    socket.on('error', (err) => log(`[embed] socket error: ${err.message}`));
  }

  // Task 3 ersetzt das durch den app://-Medienweg.
  async function handleHttp(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port ?? 0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  port = (http.address() as AddressInfo).port;

  return {
    get port() {
      return port;
    },
    broadcast(channel, payload) {
      for (const c of connections) c.sender.send(channel, payload);
    },
    connectionCount: () => connections.size,
    async close() {
      for (const c of connections) c.socket.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
