import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { WORKSPACE_HTML_CSP } from '@x/shared/dist/konzept.js';
import { createWorkspaceRoutes } from './workspace-route.js';

describe('workspace route: HTML delivery', () => {
  let root: string;
  let app: Hono;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-route-'));
    fs.mkdirSync(path.join(root, 'knowledge'));
    fs.writeFileSync(path.join(root, 'knowledge', 'a.html'), '<p>hi</p>');
    fs.writeFileSync(path.join(root, 'knowledge', 'b.md'), '# b');
    app = createWorkspaceRoutes((rel) => path.join(root, rel));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('liefert HTML mit Typ und Kein-Netz-Regel', async () => {
    const res = await app.request('/workspace/knowledge/a.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(WORKSPACE_HTML_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('<p>hi</p>');
    const md = await app.request('/workspace/knowledge/b.md');
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('content-security-policy')).toBeNull();
  });
});
