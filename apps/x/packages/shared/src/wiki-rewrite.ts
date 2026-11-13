// [[…]]-Verweise nachziehen, wenn eine Notiz (.md) oder ein HTML-Konzept unter knowledge/ umbenannt wird.
// Reine Funktionen; Kern und Renderer benutzen dieselbe Logik.
import { decodeEntities, htmlUmschreibBereiche, isHtmlPath, isKnowledgeHtmlPath } from './konzept.js'

const WIKI_LINK_REGEX = /\[\[([^[\]]+)\]\]/g
const KNOWLEDGE_PREFIX = 'knowledge/'
const MARKDOWN_EXTENSION = '.md'
const HTML_EXTENSION_REGEX = /\.(html?|xhtml)$/i

export type RewriteOptions = {
  /** Verweise nur mit dem Dateinamen (ohne Ordner) gelten als Verweis auf die Datei selbst. */
  allowBareSelfNameMatch?: boolean
  /** Gibt es unter knowledge/ eine Notiz mit diesem Pfad (klein geschrieben, ohne Präfix und ohne `.md`)? Standard: nein. */
  mdExists?: (wikiStemLower: string) => boolean
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/')
}

/** Notiz (.md) oder HTML-Konzept unter knowledge/. */
export function isRewritableKnowledgePath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath).replace(/^\/+/, '')
  const lower = normalized.toLowerCase()
  if (lower.startsWith(KNOWLEDGE_PREFIX) && lower.endsWith(MARKDOWN_EXTENSION)) return true
  return isKnowledgeHtmlPath(normalized)
}

export function stripKnowledgePrefix(relPath: string): string {
  const normalized = normalizeRelPath(relPath).replace(/^\/+/, '')
  if (!normalized.toLowerCase().startsWith(KNOWLEDGE_PREFIX)) return normalized
  return normalized.slice(KNOWLEDGE_PREFIX.length)
}

function stripMarkdownExtension(wikiPath: string): string {
  return wikiPath.toLowerCase().endsWith(MARKDOWN_EXTENSION) ? wikiPath.slice(0, -MARKDOWN_EXTENSION.length) : wikiPath
}

function stripAnyExtension(wikiPath: string): string {
  return isHtmlPath(wikiPath) ? wikiPath.replace(HTML_EXTENSION_REGEX, '') : stripMarkdownExtension(wikiPath)
}

function lastSegment(p: string): string {
  return p.split('/').pop() ?? p
}

function splitWikiPathPrefix(rawPath: string): { pathWithoutPrefix: string; hadKnowledgePrefix: boolean } {
  let normalized = rawPath.trim().replace(/^\/+/, '').replace(/^\.\//, '')
  const hadKnowledgePrefix = /^knowledge\//i.test(normalized)
  if (hadKnowledgePrefix) normalized = normalized.slice(KNOWLEDGE_PREFIX.length)
  return { pathWithoutPrefix: normalized, hadKnowledgePrefix }
}

type Codec = { decode: (s: string) => string | null; encode: (s: string) => string }

const IDENTITY: Codec = { decode: (s) => s, encode: (s) => s }

/** Im Datenblock stehen Namen als JSON-Zeichenketten: `"` und `\` müssen maskiert bleiben. */
const JSON_CODEC: Codec = {
  decode: (s) => {
    try {
      const v: unknown = JSON.parse(`"${s}"`)
      return typeof v === 'string' ? v : null
    } catch {
      return null
    }
  },
  encode: (s) => JSON.stringify(s).slice(1, -1).replace(/</g, '\\u003c'),
}

const TEXT_CODEC: Codec = {
  decode: (s) => decodeEntities(s),
  encode: (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}

function makeRewriter(fromWikiPath: string, toWikiPath: string, opts: RewriteOptions | undefined) {
  const mdExists = opts?.mdExists ?? (() => false)
  const fromIsHtml = isHtmlPath(fromWikiPath)
  const fromLower = fromWikiPath.toLowerCase()
  const fromStem = stripAnyExtension(fromLower)
  const fromBaseLower = lastSegment(fromLower)
  const fromBaseStem = lastSegment(fromStem)
  const fromHasNote = mdExists(fromStem)

  const toIsHtml = isHtmlPath(toWikiPath)
  const toStem = stripAnyExtension(toWikiPath)
  const toBase = lastSegment(toWikiPath)
  const toBaseStem = lastSegment(toStem)
  // Ohne Endung nur, wenn der Verweis dann noch auf diese Datei zeigt (kein gleichnamiges .md daneben).
  const toStemResolves = !toIsHtml || !mdExists(toStem.toLowerCase())

  const matches = (pathWithoutPrefix: string, bare: boolean): boolean => {
    const lower = pathWithoutPrefix.toLowerCase()
    const explicitHtml = isHtmlPath(lower)
    const explicitMd = lower.endsWith(MARKDOWN_EXTENSION)
    if (!fromIsHtml) {
      if (explicitHtml) return false
      return stripMarkdownExtension(lower) === (bare ? fromBaseStem : fromStem)
    }
    if (explicitHtml) return lower === (bare ? fromBaseLower : fromLower)
    if (explicitMd) return false
    // Ohne Endung zeigt der Verweis nur dann auf das Konzept, wenn es keine gleichnamige Notiz gibt.
    return lower === (bare ? fromBaseStem : fromStem) && !fromHasNote
  }

  return (inner: string): string | null => {
    const pipeIndex = inner.indexOf('|')
    const pathAndAnchor = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner
    const aliasSuffix = pipeIndex >= 0 ? inner.slice(pipeIndex) : ''

    const hashIndex = pathAndAnchor.indexOf('#')
    const pathPart = hashIndex >= 0 ? pathAndAnchor.slice(0, hashIndex) : pathAndAnchor
    const anchorSuffix = hashIndex >= 0 ? pathAndAnchor.slice(hashIndex) : ''

    const leadingWhitespace = pathPart.match(/^\s*/)?.[0] ?? ''
    const trailingWhitespace = pathPart.match(/\s*$/)?.[0] ?? ''
    const rawPath = pathPart.trim()
    if (!rawPath) return null

    const { pathWithoutPrefix, hadKnowledgePrefix } = splitWikiPathPrefix(rawPath)
    if (!pathWithoutPrefix) return null

    const matchesFullPath = matches(pathWithoutPrefix, false)
    const matchesBareSelfName = Boolean(
      opts?.allowBareSelfNameMatch && !pathWithoutPrefix.includes('/') && matches(pathWithoutPrefix, true),
    )
    if (!matchesFullPath && !matchesBareSelfName) return null

    const explicitExtension = rawPath.toLowerCase().endsWith(MARKDOWN_EXTENSION) || isHtmlPath(rawPath)
    const withExtension = matchesBareSelfName && !matchesFullPath ? toBase : toWikiPath
    const withoutExtension = matchesBareSelfName && !matchesFullPath ? toBaseStem : toStem
    const rewrittenPath = explicitExtension || !toStemResolves ? withExtension : withoutExtension
    const finalPath = hadKnowledgePrefix ? `${KNOWLEDGE_PREFIX}${rewrittenPath}` : rewrittenPath

    return `${leadingWhitespace}${finalPath}${trailingWhitespace}${anchorSuffix}${aliasSuffix}`
  }
}

function rewriteLinks(text: string, rewriteInner: (inner: string) => string | null, codec: Codec): string {
  return text.replace(WIKI_LINK_REGEX, (fullMatch, innerRaw: string) => {
    const inner = codec.decode(innerRaw)
    if (inner === null) return fullMatch
    const rewritten = rewriteInner(inner)
    return rewritten === null ? fullMatch : `[[${codec.encode(rewritten)}]]`
  })
}

/** Verweise in Markdown. Pfade ohne `knowledge/`-Präfix. */
export function rewriteWikiLinksInMarkdown(
  markdown: string,
  fromWikiPath: string,
  toWikiPath: string,
  opts?: RewriteOptions,
): string {
  return rewriteLinks(markdown, makeRewriter(fromWikiPath, toWikiPath, opts), IDENTITY)
}

/**
 * Verweise in einer HTML-Datei: im Datenblock (JSON-sicher maskiert) und im sichtbaren Text.
 * Tags, andere script-Blöcke, style und Kommentare bleiben unberührt (`a[[0]]` im Skript ist Code).
 */
export function rewriteWikiLinksInHtml(
  html: string,
  fromWikiPath: string,
  toWikiPath: string,
  opts?: RewriteOptions,
): string {
  if (!html.includes('[[')) return html
  const rewriteInner = makeRewriter(fromWikiPath, toWikiPath, opts)
  let out = ''
  let pos = 0
  for (const b of htmlUmschreibBereiche(html)) {
    out += html.slice(pos, b.start)
    out += rewriteLinks(html.slice(b.start, b.end), rewriteInner, b.art === 'json' ? JSON_CODEC : TEXT_CODEC)
    pos = b.end
  }
  return out + html.slice(pos)
}

/** Je nach Dateiendung der Datei, in der die Verweise stehen. */
export function rewriteWikiLinksInFile(
  filePath: string,
  content: string,
  fromWikiPath: string,
  toWikiPath: string,
  opts?: RewriteOptions,
): string {
  return isHtmlPath(filePath)
    ? rewriteWikiLinksInHtml(content, fromWikiPath, toWikiPath, opts)
    : rewriteWikiLinksInMarkdown(content, fromWikiPath, toWikiPath, opts)
}
