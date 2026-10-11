// Levels of the 3D knowledge graph (2026-10-11, EHL Munich): the file system decides where a note sits.
// Every top-level folder of the knowledge vault is one horizontal level. The default order puts the folder with
// the fewest notes on top, so a vault that keeps one folder per note type (Brands, Models, Components, ...)
// reads top-down like its hierarchy without the app knowing any folder names. The user can reorder the levels;
// the order is kept per browser profile.

export type LevelNode = { group: string }

const STORAGE_KEY = 'rowboat.graph3d.levelOrder'

const groupOf = (node: LevelNode) => node.group || 'root'

/** Folders ordered top to bottom: fewest notes first, ties by name. */
export function defaultLevelOrder(nodes: readonly LevelNode[]): string[] {
  const counts = new Map<string, number>()
  nodes.forEach((node) => counts.set(groupOf(node), (counts.get(groupOf(node)) ?? 0) + 1))
  return Array.from(counts.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([group]) => group)
}

/** The saved order for the folders that still exist, then new folders in the default order. */
export function resolveLevelOrder(saved: readonly string[] | null | undefined, nodes: readonly LevelNode[]): string[] {
  const present = defaultLevelOrder(nodes)
  const presentSet = new Set(present)
  const kept = Array.from(new Set((saved ?? []).filter((group) => presentSet.has(group))))
  const keptSet = new Set(kept)
  return [...kept, ...present.filter((group) => !keptSet.has(group))]
}

/** Moves a folder one level up (-1) or down (+1); unchanged at the ends or for an unknown folder. */
export function moveLevel(order: readonly string[], group: string, delta: -1 | 1): string[] {
  const from = order.indexOf(group)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return [...order]
  const next = [...order]
  next[from] = next[to]
  next[to] = group
  return next
}

/** Height of a level: the top level highest, the stack centred on y = 0. */
export function levelY(index: number, levelCount: number, gap: number): number {
  return ((levelCount - 1) / 2 - index) * gap
}

/** three.js parses only the comma form of hsl(); the graph builder in App.tsx writes `hsl(210 50% 40%)`. */
export function toThreeColor(css: string): string {
  const match = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(css.trim())
  return match ? `hsl(${match[1]}, ${match[2]}%, ${match[3]}%)` : css
}

export function loadLevelOrder(): string[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const value: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
  } catch {
    return null
  }
}

export function saveLevelOrder(order: readonly string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Storage blocked or full: the order then lasts for this session only.
  }
}
