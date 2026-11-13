import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rewriteWikiLinksForRenamedKnowledgeFile } from './wiki-link-rewrite.js';

let root: string;

async function write(rel: string, content: string) {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}
const read = (rel: string) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
const konzept = (bezuege: string, rest = '') =>
  `<html><body>${rest}<script type="application/json" id="rowboat-konzept">{"art":"konzept","bezuege":${bezuege}}</script></body></html>`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-wikirewrite-test-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('rewriteWikiLinksForRenamedKnowledgeFile mit HTML-Konzepten', () => {
  it('zieht Verweise im Datenblock eines Konzepts nach, wenn eine Notiz umbenannt wird', async () => {
    await write('knowledge/Marke/Marke.md', '# Marke');
    await write('knowledge/Konzepte/k.html', konzept('["[[Marke/Marke]]"]'));
    await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/Marke/Marke.md', 'knowledge/Marke/Leitbild.md');
    expect(await read('knowledge/Konzepte/k.html')).toContain('"[[Marke/Leitbild]]"');
  });

  it('bleibt gültiges JSON, wenn der neue Name Anführungszeichen enthält, und lässt Skriptcode in Ruhe', async () => {
    const html = konzept(
      '["[[Marke/Marke]]"]',
      '<p>[[Marke/Marke]]</p><script>var a = b[[Marke/Marke]]</script><style>x[[Marke/Marke]]{}</style><!-- [[Marke/Marke]] -->',
    );
    await write('knowledge/Konzepte/k.html', html);
    const count = await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/Marke/Marke.md', 'knowledge/Marke/Neu "Ä".md');
    expect(count).toBe(1);
    const neu = await read('knowledge/Konzepte/k.html');
    expect(neu).toContain('<p>[[Marke/Neu "Ä"]]</p>');
    expect(neu).toContain('var a = b[[Marke/Marke]]</script><style>x[[Marke/Marke]]{}</style><!-- [[Marke/Marke]] -->');
    const block = /<script type="application\/json" id="rowboat-konzept">([\s\S]*?)<\/script>/.exec(neu)![1];
    expect(JSON.parse(block).bezuege).toEqual(['[[Marke/Neu "Ä"]]']);
  });

  it('zieht Verweise in Notizen nach, wenn ein Konzept umbenannt wird', async () => {
    await write('knowledge/Konzepte/Neu Ä.html', konzept('[]'));
    await write('knowledge/Notiz.md', '[[Konzepte/k.html|das Konzept]] und [[Konzepte/K.HTML]]');
    await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/Konzepte/k.html', 'knowledge/Konzepte/Neu Ä.html');
    expect(await read('knowledge/Notiz.md')).toBe('[[Konzepte/Neu Ä.html|das Konzept]] und [[Konzepte/Neu Ä.html]]');
  });

  it('Verweis ohne Endung auf ein Konzept bleibt ohne Endung, wenn er eindeutig bleibt', async () => {
    await write('knowledge/Konzepte/neu.html', konzept('[]'));
    await write('knowledge/Notiz.md', '[[Konzepte/k]]');
    await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/Konzepte/k.html', 'knowledge/Konzepte/neu.html');
    expect(await read('knowledge/Notiz.md')).toBe('[[Konzepte/neu]]');
  });

  it('Verweis ohne Endung bekommt die Endung, wenn eine gleichnamige Notiz am Ziel steht', async () => {
    await write('knowledge/Konzepte/neu.html', konzept('[]'));
    await write('knowledge/Konzepte/neu.md', 'Notiz');
    await write('knowledge/Notiz.md', '[[Konzepte/k]]');
    await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/Konzepte/k.html', 'knowledge/Konzepte/neu.html');
    expect(await read('knowledge/Notiz.md')).toBe('[[Konzepte/neu.html]]');
  });

  it('Verweis ohne Endung, der wegen einer Notiz gleichen Namens auf die Notiz zeigt, bleibt', async () => {
    await write('knowledge/Konzepte/k.md', 'Notiz');
    await write('knowledge/Konzepte/neu.html', konzept('[]'));
    await write('knowledge/Notiz.md', '[[Konzepte/k]] [[Konzepte/k.html]]');
    await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/Konzepte/k.html', 'knowledge/Konzepte/neu.html');
    expect(await read('knowledge/Notiz.md')).toBe('[[Konzepte/k]] [[Konzepte/neu.html]]');
  });

  it('Konzepte verweisen aufeinander (.htm bleibt .htm)', async () => {
    await write('knowledge/z.htm', '<p>[[b.html|B]]</p>');
    await write('knowledge/c.html', '<p>[[a.htm]]</p>');
    await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/a.htm', 'knowledge/z.htm');
    expect(await read('knowledge/c.html')).toBe('<p>[[z.htm]]</p>');
  });

  it('ein Konzept, das sich selbst nennt, wird beim Umbenennen nachgezogen', async () => {
    await write('knowledge/Konzepte/n.html', '<p>[[Konzepte/k.html]] [[k.html]]</p>');
    await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/Konzepte/k.html', 'knowledge/Konzepte/n.html');
    expect(await read('knowledge/Konzepte/n.html')).toBe('<p>[[Konzepte/n.html]] [[n.html]]</p>');
  });

  it('fasst Dateien ausserhalb von knowledge/ und andere Endungen nicht an', async () => {
    await write('knowledge/a.md', '[[b]]');
    await write('knowledge/x.txt', '[[b]]');
    await write('other/y.html', '<p>[[b]]</p>');
    expect(await rewriteWikiLinksForRenamedKnowledgeFile(root, 'other/y.html', 'other/z.html')).toBe(0);
    await rewriteWikiLinksForRenamedKnowledgeFile(root, 'knowledge/b.md', 'knowledge/c.md');
    expect(await read('knowledge/x.txt')).toBe('[[b]]');
    expect(await read('other/y.html')).toBe('<p>[[b]]</p>');
    expect(await read('knowledge/a.md')).toBe('[[c]]');
  });
});
