// Modified for VibeMind (Flissel/rowboat vibemind): ticket #330, Task 17 fix
// round 1 (review I-1, I-2). A scoped key — and the owner key carrying the
// restricted-principal header the Electron main process sets for the embed
// bridge — may not read protected workspace entries and may not answer a
// permission request as the human. Real server over loopback, real handlers,
// a real SessionsImpl + TurnRuntime with a scripted model (no network, no
// process start: addMcpServer only writes mcp.json and records the approval).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue, ResolvedAgent, ToolDescriptor, TurnEvent } from '@x/shared/dist/turns.js';
import type { z } from 'zod';
import type { RowboatServer } from './server.js';

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-restricted-'));
process.env.ROWBOAT_WORKDIR = workDir;

const container = (await import('@x/core/dist/di/container.js')).default;
const approvals = await import('@x/core/dist/mcp/stdio-approvals.js');
const security = await import('@x/core/dist/config/security.js');
const { TurnRuntime } = await import('@x/core/dist/runtime/turns/runtime.js');
const { InMemoryTurnRepo } = await import('@x/core/dist/runtime/turns/in-memory-turn-repo.js');
const { TurnRepoContextResolver } = await import('@x/core/dist/runtime/turns/context-resolver.js');
const { RealPermissionChecker } = await import('@x/core/dist/runtime/turns/bridges/real-permission-checker.js');
const { RealToolRegistry } = await import('@x/core/dist/runtime/turns/bridges/real-tool-registry.js');
const { SessionsImpl } = await import('@x/core/dist/runtime/sessions/sessions.js');
const { InMemorySessionRepo } = await import('@x/core/dist/runtime/sessions/in-memory-session-repo.js');
type IModelRegistry = import('@x/core/dist/runtime/turns/model-registry.js').IModelRegistry;
type LlmStreamEvent = import('@x/core/dist/runtime/turns/model-registry.js').LlmStreamEvent;

type TEvent = z.infer<typeof TurnEvent>;
type Call = { id: string; name: string; args: JsonValue };

const STDIO = { command: 'calc.exe' };
const EMPTY = JSON.stringify({ mcpServers: {} });
const KEY_MARKER = 'server-key-content-marker';

function builtin(name: string): z.infer<typeof ToolDescriptor> {
  return { toolId: `builtin:${name}`, name, description: name, inputSchema: {}, execution: 'sync', requiresHuman: false };
}
const agent: z.infer<typeof ResolvedAgent> = {
  agentId: 'copilot',
  systemPrompt: 'SYS',
  model: { provider: 'fake', model: 'm' },
  tools: [builtin('addMcpServer')],
};

function respondCalls(...calls: Call[]) {
  return async function* (): AsyncGenerator<LlmStreamEvent, void, void> {
    yield {
      type: 'completed',
      message: { role: 'assistant', content: calls.map((c) => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, arguments: c.args })) },
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  };
}
function respondText(text: string) {
  return async function* (): AsyncGenerator<LlmStreamEvent, void, void> {
    yield { type: 'completed', message: { role: 'assistant', content: text }, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  };
}

// Every model call answers from the queue; the tests push what the next turn says.
const script: Array<() => AsyncGenerator<LlmStreamEvent, void, void>> = [];
const models: IModelRegistry = {
  async resolve(descriptor) {
    return {
      descriptor,
      encodeMessages: (messages) => messages as unknown as JsonValue[],
      stream: () => {
        const next = script.shift();
        if (!next) throw new Error('no scripted model call remaining');
        return next();
      },
    };
  },
};

let ids = 0;
const turnRepo = new InMemoryTurnRepo();
const turnRuntime = new TurnRuntime({
  turnRepo,
  idGenerator: { next: async () => `2026-11-16T10-00-00Z-${String(++ids).padStart(7, '0')}-000` },
  clock: { now: () => '2026-11-16T10:00:00Z' },
  agentResolver: { resolve: async () => agent },
  modelRegistry: models,
  toolRegistry: new RealToolRegistry(),
  contextResolver: new TurnRepoContextResolver({ turnRepo }),
  permissionChecker: new RealPermissionChecker(),
  permissionClassifier: { classify: async (batch) => batch.requests.map((r) => ({ toolCallId: r.toolCallId, decision: 'defer' as const, reason: 'test' })) },
  lifecycleBus: { publish: () => undefined },
  turnEventBus: { publish: () => undefined, subscribe: () => () => undefined, subscribeAll: () => () => undefined },
  usageReporter: { reportModelUsage: () => undefined },
});
let sid = 0;
const sessions = new SessionsImpl({
  sessionRepo: new InMemorySessionRepo(),
  turnRuntime,
  idGenerator: { next: async () => `2026-11-16T09-00-00Z-${String(++sid).padStart(7, '0')}-000` },
  clock: { now: () => '2026-11-16T09:00:00Z' },
  sessionBus: { publish: () => undefined },
});

// Legacy runs: the run log and the runtime trigger are the only seams.
const legacy = { log: [] as unknown[], appended: [] as unknown[] };

// awilix resolver objects without importing awilix here.
const value = (v: unknown) => ({ resolve: () => v, isLeakSafe: true });
container.register({
  sessions: value(sessions) as never,
  runsRepo: value({
    fetch: async () => ({ log: legacy.log }),
    appendEvents: async (_runId: string, events: unknown[]) => { legacy.appended.push(...events); },
  }) as never,
  agentRuntime: value({ trigger: () => undefined }) as never,
});

async function waitForPermission(turnId: string, toolCallId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { events } = await sessions.getTurn(turnId);
    if ((events as TEvent[]).some((e) => e.type === 'tool_permission_required' && e.toolCallId === toolCallId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no permission request for ${toolCallId}`);
}

describe('restricted callers (scoped key, embed via the restricted header)', () => {
  let server: RowboatServer;
  let base: string;
  let scoped: string;

  beforeAll(async () => {
    await fs.mkdir(path.join(workDir, 'config'), { recursive: true });
    await fs.mkdir(path.join(workDir, 'knowledge'), { recursive: true });
    await fs.writeFile(path.join(workDir, 'knowledge', 'note.md'), '# note\n');
    const { createRowboatServer } = await import('./server.js');
    const { createCoreRpcHandlers, createCoreEventSources } = await import('./core-deps.js');
    const { addScopedKey } = await import('./auth.js');
    scoped = await addScopedKey(workDir, 'bot', [
      'workspace:readFile', 'workspace:readdir', 'workspace:stat', 'workspace:exists', 'workspace:writeFile',
      'sessions:respondToPermission', 'runs:authorizePermission',
    ]);
    server = await createRowboatServer({
      workDir,
      handlers: createCoreRpcHandlers(),
      events: createCoreEventSources(),
      resolveWorkspacePath: (rel) => path.join(workDir, rel),
      serverVersion: 'test',
      port: 0,
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    approvals.resetStdioApprovalsForTests();
    await fs.writeFile(path.join(workDir, 'config', 'mcp.json'), EMPTY);
    await fs.writeFile(path.join(workDir, 'config', 'security.json'), JSON.stringify({ allowedCommands: ['ls'], allowedFileAccess: [] }));
    await fs.writeFile(path.join(workDir, 'cipher-key'), KEY_MARKER);
    security.resetSecurityAllowListCache();
    security.reloadSecurityConfig();
    script.length = 0;
    legacy.log = [];
    legacy.appended = [];
  });

  const call = async (channel: string, body: unknown, token: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/rpc/${channel}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as { error?: { message?: string } } & Record<string, unknown> };
  };
  const RESTRICTED = { 'x-rowboat-principal': 'restricted' };

  describe('I-1: reads of protected entries', () => {
    it('scoped key: readFile of server-key, cipher-key and config/ is refused, nothing leaks', async () => {
      for (const p of ['server-key', 'cipher-key', 'config/mcp.json', 'scoped-keys.json']) {
        const r = await call('workspace:readFile', { path: p }, scoped);
        expect(r.status, p).not.toBe(200);
        expect(r.json.error?.message, p).toMatch(/protected workspace entries/);
        expect(r.text).not.toContain(server.key);
        expect(r.text).not.toContain(KEY_MARKER);
      }
    });

    it('scoped key: stat/exists/readdir inside a protected entry are refused; the root listing works', async () => {
      expect((await call('workspace:stat', { path: 'server-key' }, scoped)).status).not.toBe(200);
      expect((await call('workspace:exists', { path: 'config/mcp.json' }, scoped)).status).not.toBe(200);
      expect((await call('workspace:readdir', { path: 'config' }, scoped)).status).not.toBe(200);
      const rootList = await call('workspace:readdir', { path: '' }, scoped);
      expect(rootList.status).toBe(200);
      expect((rootList.json as unknown as Array<{ path: string }>).map((e) => e.path)).toEqual(expect.arrayContaining(['config', 'knowledge']));
    });

    it('scoped key: a recursive root listing drops what lies inside protected entries', async () => {
      const r = await call('workspace:readdir', { path: '', opts: { recursive: true } }, scoped);
      expect(r.status).toBe(200);
      const paths = (r.json as unknown as Array<{ path: string }>).map((e) => e.path.replace(/\\/g, '/'));
      expect(paths).toContain('knowledge/note.md');
      expect(paths.filter((p) => p.startsWith('config/'))).toEqual([]);
    });

    it('scoped key: an unprotected read works', async () => {
      const r = await call('workspace:readFile', { path: 'knowledge/note.md' }, scoped);
      expect(r.status).toBe(200);
      expect(r.json.data).toBe('# note\n');
    });

    it('owner key: reads of protected entries are unchanged', async () => {
      const r = await call('workspace:readFile', { path: 'cipher-key' }, server.key);
      expect(r.status).toBe(200);
      expect(r.json.data).toBe(KEY_MARKER);
    });

    it('owner key with the restricted header (embed bridge): treated like a scoped key', async () => {
      const read = await call('workspace:readFile', { path: 'cipher-key' }, server.key, RESTRICTED);
      expect(read.status).not.toBe(200);
      expect(read.text).not.toContain(KEY_MARKER);
      const write = await call('workspace:writeFile', { path: 'config/mcp.json', data: JSON.stringify({ mcpServers: { s: STDIO } }) }, server.key, RESTRICTED);
      expect(write.status).not.toBe(200);
      expect(await fs.readFile(path.join(workDir, 'config', 'mcp.json'), 'utf8')).toBe(EMPTY);
      expect(approvals.isStdioEntryApproved('s', STDIO)).toBe(false);
    });
  });

  describe('I-2: permission answers', () => {
    async function suspendedOn(call0: Call): Promise<string> {
      script.push(respondCalls(call0), respondText('done'));
      const sessionId = await sessions.createSession();
      const { turnId } = await sessions.sendMessage(sessionId, { role: 'user', content: 'go' }, { agent: { agentId: 'copilot' } });
      await waitForPermission(turnId, call0.id);
      return turnId;
    }
    const addStdio: Call = { id: 'A', name: 'addMcpServer', args: { serverName: 'pwn', config: STDIO } };
    const addUrl: Call = { id: 'B', name: 'addMcpServer', args: { serverName: 'web', config: { url: 'http://127.0.0.1:9000/mcp' } } };

    it('scoped key allowing a human-only addMcpServer stdio request is refused: nothing written or approved; owner key then works', async () => {
      const turnId = await suspendedOn(addStdio);
      const refused = await call('sessions:respondToPermission', { turnId, toolCallId: 'A', decision: 'allow' }, scoped);
      expect(refused.status).not.toBe(200);
      expect(refused.json.error?.message).toMatch(/human/);
      expect(await fs.readFile(path.join(workDir, 'config', 'mcp.json'), 'utf8')).toBe(EMPTY);
      expect(approvals.isStdioEntryApproved('pwn', STDIO)).toBe(false);

      const embed = await call('sessions:respondToPermission', { turnId, toolCallId: 'A', decision: 'allow' }, server.key, RESTRICTED);
      expect(embed.status).not.toBe(200);
      expect(approvals.isStdioEntryApproved('pwn', STDIO)).toBe(false);

      const owner = await call('sessions:respondToPermission', { turnId, toolCallId: 'A', decision: 'allow' }, server.key);
      expect(owner.status).toBe(200);
      expect(approvals.isStdioEntryApproved('pwn', STDIO)).toBe(true);
      const { events } = await sessions.getTurn(turnId);
      expect((events as TEvent[]).find((e) => e.type === 'tool_permission_resolved')).toMatchObject({ source: 'human' });
    });

    it('scoped key answering "always" on an ordinary request is refused; a one-time allow is recorded as delegated', async () => {
      const turnId = await suspendedOn(addUrl);
      const always = await call('sessions:respondToPermission', { turnId, toolCallId: 'B', decision: 'allow', metadata: { scope: 'always' } }, scoped);
      expect(always.status).not.toBe(200);
      expect(always.json.error?.message).toMatch(/scope/);
      const once = await call('sessions:respondToPermission', { turnId, toolCallId: 'B', decision: 'allow' }, scoped);
      expect(once.status).toBe(200);
      const { events } = await sessions.getTurn(turnId);
      expect((events as TEvent[]).find((e) => e.type === 'tool_permission_resolved')).toMatchObject({ decision: 'allow', source: 'delegated' });
    });

    const legacyRequest = (toolCallId: string) => ({
      runId: 'r1', type: 'tool-permission-request', subflow: [],
      toolCall: { type: 'tool-call', toolCallId, toolName: 'executeCommand', arguments: { command: 'git status' } },
      permission: { kind: 'command', commandNames: ['git'] },
    });
    const authorize = (scope: 'once' | 'always', token: string, headers: Record<string, string> = {}) =>
      call('runs:authorizePermission', { runId: 'r1', authorization: { toolCallId: 'C', response: 'approve', scope, subflow: [] } }, token, headers);

    it('legacy: scoped key answering "always" on an ordinary command is refused, the allow-list is unchanged; owner key adds it', async () => {
      legacy.log = [legacyRequest('C')];
      const refused = await authorize('always', scoped);
      expect(refused.status).not.toBe(200);
      expect(refused.json.error?.message).toMatch(/scope/);
      expect(security.getSecurityAllowList()).toEqual(['ls']);
      expect(JSON.parse(await fs.readFile(path.join(workDir, 'config', 'security.json'), 'utf8')).allowedCommands).toEqual(['ls']);
      expect(legacy.appended).toEqual([]);

      expect((await authorize('always', server.key, RESTRICTED)).status).not.toBe(200);
      expect(security.getSecurityAllowList()).toEqual(['ls']);

      const owner = await authorize('always', server.key);
      expect(owner.status).toBe(200);
      expect(security.getSecurityAllowList()).toContain('git');
    });

    it('legacy: a scoped one-time approve of an ordinary command is accepted', async () => {
      legacy.log = [legacyRequest('C')];
      expect((await authorize('once', scoped)).status).toBe(200);
      expect(legacy.appended).toMatchObject([{ toolCallId: 'C', response: 'approve' }]);
      expect(security.getSecurityAllowList()).toEqual(['ls']);
    });
  });
});
