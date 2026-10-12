// EHL addition (Flissel/rowboat ehl-schema-graph): hierarchical brain graph. Reads the vault schema's flat
// front matter (level, parent, domain, typed relations) and lays notes out on one ring per level.
// Spec: Flissel/ehl-munich-2026 docs/superpowers/specs/2026-10-12-brain-graph-hierarchy-design.md
import { splitFrontmatter } from './frontmatter'

export type Relation = { name: string; target: string }
export type Hierarchy = { level?: number; parent?: string; domain?: string; relations: Relation[] }

const LINK = /\[\[([^[\]]+)\]\]/g
const KEY_LINE = /^([A-Za-z_]\w*):\s*(.*)$/

export function linkTarget(raw: string): string {
  return raw.split('|')[0].split('#')[0].trim()
}

function linksIn(value: string): string[] {
  return Array.from(value.matchAll(LINK), (m) => linkTarget(m[1])).filter((t) => t.length > 0)
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').trim()
}

export function parseHierarchy(content: string): Hierarchy {
  const text = content.replace(/^\ufeff/, '').replace(/\r\n/g, '\n')
  const { raw } = splitFrontmatter(text)
  const result: Hierarchy = { relations: [] }
  if (!raw) return result
  for (const line of raw.split('\n')) {
    const match = line.match(KEY_LINE)
    if (!match) continue
    const [, key, value] = match
    if (key === 'level') {
      const level = Number(unquote(value))
      if (Number.isInteger(level)) result.level = level
    } else if (key === 'domain') {
      const domain = unquote(value)
      if (domain) result.domain = domain
    } else if (key === 'parent') {
      const [target] = linksIn(value)
      if (target) result.parent = target
    } else {
      for (const target of linksIn(value)) result.relations.push({ name: key, target })
    }
  }
  return result
}
