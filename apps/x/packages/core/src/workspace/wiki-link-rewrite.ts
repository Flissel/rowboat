import fs from 'node:fs/promises';
import path from 'node:path';

import { wikiRewrite } from '@x/shared';

const { isRewritableKnowledgePath, rewriteWikiLinksInFile, stripKnowledgePrefix } = wikiRewrite;

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

async function collectKnowledgeLinkFiles(workspaceRoot: string): Promise<string[]> {
  const knowledgeRoot = path.join(workspaceRoot, 'knowledge');
  try {
    const stat = await fs.lstat(knowledgeRoot);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const linkFiles: string[] = [];
  const pendingDirectories: string[] = [knowledgeRoot];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) continue;

    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = normalizeRelPath(path.relative(workspaceRoot, absolutePath));
      if (!isRewritableKnowledgePath(relativePath)) continue;
      linkFiles.push(relativePath);
    }
  }

  return linkFiles;
}

export async function rewriteWikiLinksForRenamedKnowledgeFile(
  workspaceRoot: string,
  fromRelPath: string,
  toRelPath: string
): Promise<number> {
  const normalizedFrom = normalizeRelPath(fromRelPath);
  const normalizedTo = normalizeRelPath(toRelPath);

  if (!isRewritableKnowledgePath(normalizedFrom) || !isRewritableKnowledgePath(normalizedTo)) {
    return 0;
  }

  const fromWikiPath = stripKnowledgePrefix(normalizedFrom);
  const toWikiPath = stripKnowledgePrefix(normalizedTo);
  if (fromWikiPath.toLowerCase() === toWikiPath.toLowerCase()) return 0;

  const linkFiles = await collectKnowledgeLinkFiles(workspaceRoot);
  let rewrittenFiles = 0;

  // Notizen nach dem Umbenennen (ohne Präfix, ohne .md, klein): entscheidet, ob ein Verweis ohne Endung noch ein Konzept meint.
  const noteStems = new Set<string>();
  for (const relativePath of linkFiles) {
    if (relativePath.toLowerCase().endsWith('.md')) {
      noteStems.add(stripKnowledgePrefix(relativePath).slice(0, -3).toLowerCase());
    }
  }
  const mdExists = (stem: string) => noteStems.has(stem);

  const normalizedToLower = normalizedTo.toLowerCase();
  for (const relativePath of linkFiles) {
    const absolutePath = path.join(workspaceRoot, ...relativePath.split('/'));
    try {
      const content = await fs.readFile(absolutePath, 'utf8');
      if (!content.includes('[[')) continue;

      const isRenamedFile = normalizeRelPath(relativePath).toLowerCase() === normalizedToLower;
      const rewritten = rewriteWikiLinksInFile(relativePath, content, fromWikiPath, toWikiPath, {
        allowBareSelfNameMatch: isRenamedFile,
        mdExists,
      });
      if (rewritten === content) continue;

      await fs.writeFile(absolutePath, rewritten, 'utf8');
      rewrittenFiles += 1;
    } catch (error) {
      console.error('Failed to rewrite wiki links in file:', relativePath, error);
    }
  }

  return rewrittenFiles;
}
