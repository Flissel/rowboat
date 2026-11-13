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
  let symlinkOk = false;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-route-'));
    fs.mkdirSync(path.join(root, 'knowledge'));
    fs.writeFileSync(path.join(root, 'knowledge', 'a.html'), '<p>hi</p>');
    fs.writeFileSync(path.join(root, 'knowledge', 'b.md'), '# b');
    fs.writeFileSync(path.join(root, 'knowledge', 'c.HTM'), '<p>c</p>');
    fs.writeFileSync(path.join(root, 'knowledge', 'd.xhtml'), '<p>d</p>');
    try {
      fs.symlinkSync(path.join(root, 'knowledge', 'a.html'), path.join(root, 'knowledge', 'x.txt'));
      symlinkOk = true;
    } catch {
      symlinkOk = false; // Windows ohne Symlink-Recht
    }
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

  it('wendet die Regel auch auf .HTM, .xhtml und Endpunkt-Namen an', async () => {
    for (const p of ['c.HTM', 'd.xhtml', 'a.html.', 'a.html%20']) {
      const res = await app.request(`/workspace/knowledge/${p}`);
      if (res.status !== 200) continue; // Namen mit Endpunkt loest nicht jedes Dateisystem auf
      expect(res.headers.get('content-security-policy'), p).toBe(WORKSPACE_HTML_CSP);
    }
    for (const p of ['c.HTM', 'd.xhtml']) {
      const res = await app.request(`/workspace/knowledge/${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type'), p).toBe('text/html; charset=utf-8');
      expect(res.headers.get('x-content-type-options'), p).toBe('nosniff');
    }
  });

  it('wendet die Regel auf eine Verknuepfung x.txt -> a.html an', async (ctx) => {
    if (!symlinkOk) ctx.skip();
    const res = await app.request('/workspace/knowledge/x.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(WORKSPACE_HTML_CSP);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('wendet die Regel auf eine Verknuepfung an, auch wenn der Arbeitsordner # oder % im Namen hat', async (ctx) => {
    const sonder = fs.mkdtempSync(path.join(os.tmpdir(), 'ws#50%-'));
    try {
      fs.writeFileSync(path.join(sonder, 'y.html'), '<p>y</p>');
      try {
        fs.symlinkSync(path.join(sonder, 'y.html'), path.join(sonder, 'x.txt'));
      } catch {
        ctx.skip(); // Windows ohne Symlink-Recht
      }
      const sApp = createWorkspaceRoutes((rel) => path.join(sonder, rel));
      const res = await sApp.request('/workspace/x.txt');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe(WORKSPACE_HTML_CSP);
    } finally {
      fs.rmSync(sonder, { recursive: true, force: true });
    }
  });

  it('behandelt eine Textdatei im Arbeitsordner page.html#d nicht als HTML', async () => {
    const eltern = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const sonder = path.join(eltern, 'page.html#d');
    try {
      fs.mkdirSync(sonder);
      fs.writeFileSync(path.join(sonder, 'notes.txt'), 'hi');
    } catch {
      fs.rmSync(eltern, { recursive: true, force: true });
      return; // Dateisystem erlaubt den Namen nicht
    }
    try {
      const sApp = createWorkspaceRoutes((rel) => path.join(sonder, rel));
      const res = await sApp.request('/workspace/notes.txt');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBeNull();
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    } finally {
      fs.rmSync(eltern, { recursive: true, force: true });
    }
  });
});
