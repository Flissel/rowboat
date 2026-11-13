import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let workDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-vh-test-'));
  workDir = path.join(tmpDir, 'workspace');
  process.env.ROWBOAT_WORKDIR = workDir;
  vi.resetModules();
});
afterEach(async () => {
  delete process.env.ROWBOAT_WORKDIR;
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** config.ts startet initRepo() beim Import selbst; hier warten, bis der erste Snapshot im Verlauf steht. */
async function importAfterSnapshot(probe: string) {
  const vh = await import('./version_history.js');
  for (let i = 0; i < 100 && (await vh.getFileHistory(probe)).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return vh;
}

describe('version history', () => {
  it('nimmt HTML-Konzepte in den Versionsverlauf (auch .htm, auch unter Kanal), andere Dateien nicht', async () => {
    const k = path.join(workDir, 'knowledge');
    await fs.mkdir(path.join(k, 'Konzepte'), { recursive: true });
    await fs.mkdir(path.join(k, 'Kanal'), { recursive: true });
    await fs.writeFile(path.join(k, 'Konzepte', 'k.html'), '<p>1</p>');
    await fs.writeFile(path.join(k, 'Konzepte', 'm.htm'), '<p>m</p>');
    await fs.writeFile(path.join(k, 'Kanal', 'q.html'), '<p>q</p>');
    await fs.writeFile(path.join(k, 'n.md'), '# n');
    await fs.writeFile(path.join(k, 'x.txt'), 'x');
    const vh = await importAfterSnapshot('n.md');
    await fs.writeFile(path.join(k, 'Konzepte', 'k.html'), '<p>zwei, laenger</p>');
    await vh.commitAll('t', 'a');
    expect(await vh.getFileHistory('Konzepte/k.html')).toHaveLength(2);
    expect(await vh.getFileHistory('Konzepte/m.htm')).toHaveLength(1);
    expect(await vh.getFileHistory('Kanal/q.html')).toHaveLength(1);
    expect(await vh.getFileHistory('n.md')).toHaveLength(1);
    expect(await vh.getFileHistory('x.txt')).toHaveLength(0);
  });

  it('neues HTML nach dem ersten Snapshot kommt per commitAll in den Verlauf', async () => {
    const k = path.join(workDir, 'knowledge');
    await fs.mkdir(k, { recursive: true });
    await fs.writeFile(path.join(k, 'n.md'), '# n');
    const vh = await importAfterSnapshot('n.md');
    await fs.writeFile(path.join(k, 'neu.html'), '<p>neu</p>');
    await vh.commitAll('t', 'a');
    const history = await vh.getFileHistory('neu.html');
    expect(history).toHaveLength(1);
    expect(await vh.getFileAtCommit('neu.html', history[0]!.oid)).toBe('<p>neu</p>');
  });
});
