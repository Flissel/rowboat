// Modified for VibeMind (Flissel/rowboat vibemind): the server's workspace:* handlers are human write paths
// (ticket #330, Task 17): a write to config/mcp.json or config/security.json through them takes effect now,
// a raw write to the file does not (until a restart). Nothing is spawned: only the approval set and the
// allow-list are inspected.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// WorkDir is resolved when @x/core loads, so point it at a temp dir first.
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-human-config-'));
process.env.ROWBOAT_WORKDIR = workDir;

const { createCoreRpcHandlers } = await import('./core-deps.js');
const security = await import('@x/core/dist/config/security.js');
const approvals = await import('@x/core/dist/mcp/stdio-approvals.js');

const STDIO = { command: 'node', args: ['server.js'] };
const handlers = createCoreRpcHandlers();

describe('server workspace:* handlers as human write paths', () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(workDir, 'config'), { recursive: true });
  });

  beforeEach(async () => {
    approvals.resetStdioApprovalsForTests();
    await fs.writeFile(path.join(workDir, 'config', 'security.json'), JSON.stringify({ allowedCommands: ['ls'], allowedFileAccess: [] }));
    security.resetSecurityAllowListCache();
    security.reloadSecurityConfig();
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('workspace:writeFile config/mcp.json approves its stdio entries', async () => {
    await handlers['workspace:writeFile']({ path: 'config/mcp.json', data: JSON.stringify({ mcpServers: { s: STDIO } }) });
    expect(approvals.isStdioEntryApproved('s', STDIO)).toBe(true);
  });

  it('a raw write of the same file approves nothing', async () => {
    await fs.writeFile(path.join(workDir, 'config', 'mcp.json'), JSON.stringify({ mcpServers: { s: STDIO } }));
    expect(approvals.isStdioEntryApproved('s', STDIO)).toBe(false);
  });

  it('workspace:writeFile config/security.json replaces the live allow-list; a raw write does not', async () => {
    await fs.writeFile(path.join(workDir, 'config', 'security.json'), JSON.stringify(['*']));
    expect(security.getSecurityAllowList()).toEqual(['ls']);
    await handlers['workspace:writeFile']({ path: 'config/security.json', data: JSON.stringify(['git', 'ls']) });
    expect(security.getSecurityAllowList().sort()).toEqual(['git', 'ls']);
  });

  it('workspace:copy onto config/mcp.json approves the copied entries', async () => {
    await fs.writeFile(path.join(workDir, 'staged.json'), JSON.stringify({ mcpServers: { c: STDIO } }));
    await handlers['workspace:copy']({ from: 'staged.json', to: 'config/mcp.json', overwrite: true });
    expect(approvals.isStdioEntryApproved('c', STDIO)).toBe(true);
  });
});
