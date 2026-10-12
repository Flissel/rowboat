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

export type ForceParams = { ringSpacing: number; ringStrength: number; angleStrength: number }
export const DEFAULT_FORCES: ForceParams = { ringSpacing: 140, ringStrength: 0.02, angleStrength: 0.015 }
export type LevelNode = { id: string; level?: number; parentId?: string }
type Point = { x: number; y: number }

/** Extra force per node with a level: toward its ring (radius level × spacing around 0,0) and, along the
 * ring, toward its parent's angle. Nodes without a level get no entry. */
export function hierarchyForces(
  nodes: LevelNode[],
  positions: Map<string, Point>,
  params: ForceParams = DEFAULT_FORCES,
): Map<string, Point> {
  const forces = new Map<string, Point>()
  for (const node of nodes) {
    if (node.level === undefined) continue
    const pos = positions.get(node.id)
    if (!pos) continue
    const force = { x: 0, y: 0 }
    const radius = Math.hypot(pos.x, pos.y)
    const target = node.level * params.ringSpacing
    if (radius > 1e-6) {
      const pull = (target - radius) * params.ringStrength
      force.x += (pos.x / radius) * pull
      force.y += (pos.y / radius) * pull
    } else if (target > 0) {
      force.x += target * params.ringStrength
    }
    const parent = node.parentId ? positions.get(node.parentId) : undefined
    if (parent && radius > 1e-6 && Math.hypot(parent.x, parent.y) > 1e-6) {
      const own = Math.atan2(pos.y, pos.x)
      const wanted = Math.atan2(parent.y, parent.x)
      const delta = Math.atan2(Math.sin(wanted - own), Math.cos(wanted - own))
      const push = delta * radius * params.angleStrength
      force.x += -Math.sin(own) * push
      force.y += Math.cos(own) * push
    }
    forces.set(node.id, force)
  }
  return forces
}

/** Start positions: every node with a level on its ring, each subtree inside its parent's angular sector
 * (sector size ∝ subtree size). Roots share the full circle. Cycles are cut. */
export function initialHierarchyPositions(
  nodes: LevelNode[],
  ringSpacing: number = DEFAULT_FORCES.ringSpacing,
): Map<string, Point> {
  const leveled = nodes.filter((n) => n.level !== undefined).sort((a, b) => a.id.localeCompare(b.id))
  const byId = new Map(leveled.map((n) => [n.id, n]))
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const node of leveled) {
    if (node.parentId && byId.has(node.parentId)) {
      const list = children.get(node.parentId) ?? []
      list.push(node.id)
      children.set(node.parentId, list)
    } else {
      roots.push(node.id)
    }
  }
  const sizes = new Map<string, number>()
  const sizeOf = (id: string, seen: Set<string>): number => {
    const known = sizes.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 1
    seen.add(id)
    const size = 1 + (children.get(id) ?? []).reduce((sum, child) => sum + sizeOf(child, seen), 0)
    sizes.set(id, size)
    return size
  }
  const out = new Map<string, Point>()
  const place = (ids: string[], start: number, span: number) => {
    const fresh = ids.filter((id) => !out.has(id))
    const total = fresh.reduce((sum, id) => sum + sizeOf(id, new Set()), 0)
    let angle = start
    for (const id of fresh) {
      const share = (span * sizeOf(id, new Set())) / total
      const mid = angle + share / 2
      const radius = (byId.get(id)?.level ?? 0) * ringSpacing
      out.set(id, { x: radius * Math.cos(mid), y: radius * Math.sin(mid) })
      place(children.get(id) ?? [], angle, share)
      angle += share
    }
  }
  place(roots, 0, Math.PI * 2)
  for (const node of leveled) {
    if (!out.has(node.id)) place([node.id], 0, Math.PI * 2)
  }
  return out
}

export type EdgeKind = 'parent' | 'relation' | 'link'
export type HierarchyEdge = { source: string; target: string; kind: EdgeKind; relation?: string }
export type NodeInfo = { level?: number; parentId?: string; domain?: string }

const RANK: Record<EdgeKind, number> = { link: 0, relation: 1, parent: 2 }

/** Typed edges (one per unordered pair, strongest kind wins) and hierarchy info per node. */
export function buildHierarchyGraph(
  contents: { path: string; data: string }[],
  nodeSet: Set<string>,
  toNodeId: (wikiTarget: string) => string | null,
): { edges: HierarchyEdge[]; info: Map<string, NodeInfo> } {
  const edges = new Map<string, HierarchyEdge>()
  const info = new Map<string, NodeInfo>()
  const add = (source: string, rawTarget: string, kind: EdgeKind, relation?: string) => {
    const target = toNodeId(rawTarget)
    if (!target || target === source || !nodeSet.has(target)) return
    const key = source < target ? `${source}|${target}` : `${target}|${source}`
    const existing = edges.get(key)
    if (existing && RANK[existing.kind] >= RANK[kind]) return
    edges.set(key, relation ? { source, target, kind, relation } : { source, target, kind })
  }
  for (const { path, data } of contents) {
    const hierarchy = parseHierarchy(data)
    const parentId = hierarchy.parent ? toNodeId(hierarchy.parent) : null
    info.set(path, {
      level: hierarchy.level,
      parentId: parentId && nodeSet.has(parentId) ? parentId : undefined,
      domain: hierarchy.domain,
    })
    if (hierarchy.parent) add(path, hierarchy.parent, 'parent')
    for (const relation of hierarchy.relations) add(path, relation.target, 'relation', relation.name)
    for (const match of data.matchAll(LINK)) add(path, match[1], 'link')
  }
  return { edges: Array.from(edges.values()), info }
}
