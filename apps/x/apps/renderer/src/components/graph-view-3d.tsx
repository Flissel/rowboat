import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import SpriteText from 'three-spritetext'
import * as THREE from 'three'
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { GraphEdge, GraphNode } from '@/components/graph-view'
import {
  levelY, loadLevelOrder, moveLevel, resolveLevelOrder, saveLevelOrder, toThreeColor,
} from '@/lib/graph-levels'

// 3D knowledge graph (2026-10-11, EHL Munich). Each top-level folder is a horizontal level (lib/graph-levels.ts):
// a node's height is fixed by its folder, the force layout only places it within its level, so linked notes on
// different levels line up and the graph reads top-down. Repulsion runs Barnes-Hut on an octree (d3-force-3d
// inside 3d-force-graph), O(n log n) instead of the 2D view's O(n²) pairs. The scene renders in WebGL and pauses
// when idle; positions survive hiding the view, so reopening it needs no new layout.

type Node3D = {
  id: string
  label: string
  group: string
  color: string
  radius: number
  x?: number
  y?: number
  z?: number
  fy?: number
  vx?: number
  vz?: number
}

type Link3D = { source: string | Node3D; target: string | Node3D }

type GraphView3DProps = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  error?: string | null
  onSelectNode?: (id: string) => void
}

const LEVEL_GAP = 140
// Spheres a bit smaller than the 2D circles: in 3D the notes of one level share a disc, not the whole canvas.
const NODE_SCALE = 0.6
// Levels with more notes show names only on hover: hundreds of text sprites cost more than the spheres.
const LABEL_LIMIT = 40
const IDLE_PAUSE_MS = 2500
const LINK_COLOR = 'rgba(140, 140, 150, 0.35)'
const DIM_NODE = 'rgba(128, 128, 128, 0.15)'
const DIM_LINK = 'rgba(140, 140, 150, 0.05)'

const idOf = (end: string | Node3D) => (typeof end === 'string' ? end : end.id)
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)

// Keeps notes without links near their level's centre instead of drifting off (x and z only; y is fixed).
function pullToAxis(strength: number) {
  let nodes: Node3D[] = []
  const force = (alpha: number) => {
    for (const node of nodes) {
      node.vx = (node.vx ?? 0) - (node.x ?? 0) * strength * alpha
      node.vz = (node.vz ?? 0) - (node.z ?? 0) * strength * alpha
    }
  }
  force.initialize = (next: Node3D[]) => { nodes = next }
  return force
}

function disposeTree(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}

export function GraphView3D({ nodes, edges, error, onSelectNode }: GraphView3DProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraph3DInstance<Node3D, Link3D> | null>(null)
  const planesRef = useRef<THREE.Group | null>(null)
  const positionsRef = useRef(new Map<string, { x: number; z: number }>())
  const wakeRef = useRef<() => void>(() => {})
  const onEngineStopRef = useRef<() => void>(() => {})
  const drawPlanesRef = useRef<() => void>(() => {})
  const fitSoonRef = useRef<() => void>(() => {})
  const onSelectRef = useRef(onSelectNode)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedLevel, setSelectedLevel] = useState<string | null>(null)
  const [savedOrder, setSavedOrder] = useState<string[] | null>(() => loadLevelOrder())

  const levelOrder = useMemo(() => resolveLevelOrder(savedOrder, nodes), [savedOrder, nodes])
  const levels = useMemo(() => {
    const info = new Map<string, { count: number; color: string }>()
    nodes.forEach((node) => {
      const group = node.group || 'root'
      const entry = info.get(group)
      if (entry) entry.count += 1
      else info.set(group, { count: 1, color: node.color })
    })
    return levelOrder.map((group) => ({ group, ...(info.get(group) ?? { count: 0, color: '#888' }) }))
  }, [levelOrder, nodes])
  const edgeList = useMemo(() => edges.filter((edge) => edge.source !== edge.target), [edges])

  useEffect(() => { onSelectRef.current = onSelectNode }, [onSelectNode])

  // One WebGL scene per mount. Hiding the knowledge section unmounts effects, which frees the GPU context.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // The typings declare the node type on the (unexported) constructor interface, so it is set by a cast.
    const graph = new ForceGraph3D(host, { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<Node3D, Link3D>
    const planes = new THREE.Group()
    let idleTimer = 0
    let engineRunning = true
    let fitted = false

    const wake = () => {
      graph.resumeAnimation()
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => { if (!engineRunning) graph.pauseAnimation() }, IDLE_PAUSE_MS)
    }
    wakeRef.current = () => { engineRunning = true; wake() }
    fitSoonRef.current = () => {
      if (fitted) return
      window.setTimeout(() => { if (!fitted) graph.zoomToFit(0, 40) }, 300)
    }
    onEngineStopRef.current = () => {
      engineRunning = false
      if (!fitted && graph.graphData().nodes.length > 0) {
        fitted = true
        graph.zoomToFit(600, 40)
      }
      wake()
    }

    graph
      .backgroundColor('rgba(0,0,0,0)')
      .showNavInfo(false)
      .numDimensions(3)
      .nodeRelSize(1)
      .nodeVal((node) => (node.radius * NODE_SCALE) ** 3)
      .nodeResolution(12)
      .nodeLabel((node) => `<div style="font-size:12px">${escapeHtml(node.label)}<br><span style="opacity:.6">${escapeHtml(node.group)}</span></div>`)
      .linkColor(() => LINK_COLOR)
      .enableNodeDrag(false)
      .onNodeClick((node) => onSelectRef.current?.(node.id))
      .onNodeHover((node) => {
        host.style.cursor = node ? 'pointer' : ''
        setHoveredNodeId(node?.id ?? null)
      })
      .onEngineStop(() => {
        graph.graphData().nodes.forEach((node) => {
          positionsRef.current.set(node.id, { x: node.x ?? 0, z: node.z ?? 0 })
        })
        drawPlanesRef.current()
        onEngineStopRef.current()
      })
    // Big hubs push harder, so the spheres of one level do not overlap.
    graph.d3Force('charge')?.strength?.((node: Node3D) => -30 - 3 * (node.radius * NODE_SCALE) ** 2)?.distanceMax?.(400)
    graph.d3Force('link')?.distance?.(90)
    // Slightly from above, so the levels read as stacked discs; zoomToFit keeps this direction.
    graph.cameraPosition({ x: 0, y: 350, z: 1100 })
    graph.d3Force('axis', pullToAxis(0.08))
    graph.scene().add(planes)
    graphRef.current = graph
    planesRef.current = planes

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      graph.width(entry.contentRect.width).height(entry.contentRect.height)
      wake()
    })
    observer.observe(host)
    const events = ['pointerdown', 'pointermove', 'wheel'] as const
    events.forEach((name) => host.addEventListener(name, wake, { passive: true }))

    return () => {
      observer.disconnect()
      events.forEach((name) => host.removeEventListener(name, wake))
      window.clearTimeout(idleTimer)
      disposeTree(planes)
      graph._destructor()
      graph.renderer().dispose()
      host.replaceChildren()
      graphRef.current = null
      planesRef.current = null
    }
  }, [])

  // Data and levels: a node's height comes from its folder; known notes start where they were.
  useEffect(() => {
    const graph = graphRef.current
    const planes = planesRef.current
    if (!graph || !planes) return
    const levelIndex = new Map(levels.map((level, index) => [level.group, index]))
    const counts = new Map(levels.map((level) => [level.group, level.count]))
    const heightOf = (group: string) => levelY(levelIndex.get(group) ?? 0, levels.length, LEVEL_GAP)
    const cached = positionsRef.current
    const data = {
      nodes: nodes.map((node): Node3D => {
        const group = node.group || 'root'
        const y = heightOf(group)
        const known = cached.get(node.id)
        return { id: node.id, label: node.label, group, color: node.color, radius: node.radius, y, fy: y, ...known }
      }),
      links: edgeList.map((edge): Link3D => ({ source: edge.source, target: edge.target })),
    }
    const allKnown = data.nodes.every((node) => cached.has(node.id))
    graph
      .warmupTicks(allKnown ? 0 : Math.min(200, 60 + Math.round(nodes.length / 4)))
      .cooldownTicks(allKnown ? 40 : 200)
      .cooldownTime(8000)
      .nodeThreeObjectExtend(true)
      .nodeThreeObject((node) => {
        if ((counts.get(node.group) ?? 0) > LABEL_LIMIT) return new THREE.Object3D()
        const label = new SpriteText(node.label, 4, '#9ca3af')
        label.position.y = node.radius * NODE_SCALE + 5
        return label
      })
      .graphData(data)

    // One disc per level, sized to the notes it holds, with the folder name at its edge; redrawn when the
    // layout settles, since the first positions only exist after the warm-up ticks.
    drawPlanesRef.current = () => {
      disposeTree(planes)
      planes.clear()
      const placed = graph.graphData().nodes
      levels.forEach((level) => {
        const members = placed.filter((node) => node.group === level.group)
        // 90th percentile, so one far-off note without links does not blow up the disc.
        const distances = members.map((node) => Math.hypot(node.x ?? 0, node.z ?? 0)).sort((a, b) => a - b)
        const spread = distances[Math.floor((distances.length - 1) * 0.9)] ?? 0
        const radius = Math.max(70, (spread || Math.sqrt(members.length) * 28) + 30)
        const color = new THREE.Color(toThreeColor(level.color))
        const y = heightOf(level.group)
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(radius, 64),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }),
        )
        disc.rotation.x = -Math.PI / 2
        disc.position.y = y
        const rim = new THREE.Mesh(
          new THREE.RingGeometry(radius - 0.8, radius, 96),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
        )
        rim.rotation.x = -Math.PI / 2
        rim.position.y = y
        const name = new SpriteText(`${level.group === 'root' ? 'knowledge' : level.group} · ${level.count}`, 9, `#${color.getHexString()}`)
        name.position.set(-radius - 10, y + 8, 0)
        planes.add(disc, rim, name)
      })
    }
    drawPlanesRef.current()
    wakeRef.current()
    if (data.nodes.length > 0) fitSoonRef.current()
  }, [nodes, edgeList, levels])

  // Highlight: hovered note and its neighbours, else search hits and their neighbours, else the chosen level.
  const highlight = useMemo(() => {
    if (hoveredNodeId) {
      const set = new Set([hoveredNodeId])
      edgeList.forEach((edge) => {
        if (edge.source === hoveredNodeId) set.add(edge.target)
        if (edge.target === hoveredNodeId) set.add(edge.source)
      })
      return set
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      const set = new Set(nodes.filter((n) => n.label.toLowerCase().includes(query) || n.id.toLowerCase().includes(query)).map((n) => n.id))
      edgeList.forEach((edge) => {
        if (set.has(edge.source)) set.add(edge.target)
        else if (set.has(edge.target)) set.add(edge.source)
      })
      return set
    }
    if (selectedLevel) return new Set(nodes.filter((n) => (n.group || 'root') === selectedLevel).map((n) => n.id))
    return null
  }, [hoveredNodeId, searchQuery, selectedLevel, nodes, edgeList])
  const searchHits = useMemo(() => {
    if (!searchQuery.trim()) return null
    const query = searchQuery.toLowerCase()
    return nodes.filter((n) => n.label.toLowerCase().includes(query) || n.id.toLowerCase().includes(query)).length
  }, [searchQuery, nodes])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    const hoverColor = hoveredNodeId ? nodes.find((n) => n.id === hoveredNodeId)?.color : undefined
    graph
      .nodeColor((node) => (!highlight || highlight.has(node.id) ? node.color : DIM_NODE))
      .linkColor((link) => {
        if (!highlight) return LINK_COLOR
        const source = idOf(link.source)
        const target = idOf(link.target)
        if (hoverColor && (source === hoveredNodeId || target === hoveredNodeId)) return hoverColor
        return highlight.has(source) && highlight.has(target) ? LINK_COLOR : DIM_LINK
      })
    wakeRef.current()
  }, [highlight, hoveredNodeId, nodes])

  const reorder = (group: string, delta: -1 | 1) => {
    const next = moveLevel(levelOrder, group, delta)
    saveLevelOrder(next)
    setSavedOrder(next)
  }

  return (
    <div className="graph-view-3d relative h-full w-full">
      <div ref={hostRef} className="absolute inset-0" />

      {error ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-destructive">{error}</div>
      ) : null}
      {!error && nodes.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No notes found.</div>
      ) : null}

      {levels.length > 0 ? (
        <div
          className="absolute right-3 top-3 z-20 max-h-[70%] overflow-y-auto rounded-md bg-[var(--rowboat-raised)] px-3 py-2 text-xs text-foreground shadow-[var(--rowboat-shadow-soft)]"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-2 text-[13px] text-muted-foreground">Levels, top to bottom</div>
          <div className="grid gap-1">
            {levels.map((level, index) => {
              const isSelected = selectedLevel === level.group
              return (
                <div key={level.group} className="flex items-center gap-1">
                  <button
                    onClick={() => setSelectedLevel(isSelected ? null : level.group)}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-foreground/10 ${isSelected ? 'bg-foreground/15' : ''}`}
                  >
                    <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: level.color }} />
                    <span className="truncate">{level.group === 'root' ? 'knowledge' : level.group}</span>
                    <span className="ml-auto pl-2 text-muted-foreground">{level.count}</span>
                  </button>
                  <button
                    aria-label={`Move ${level.group} up`}
                    disabled={index === 0}
                    onClick={() => reorder(level.group, -1)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-30"
                  >
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    aria-label={`Move ${level.group} down`}
                    disabled={index === levels.length - 1}
                    onClick={() => reorder(level.group, 1)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-30"
                  >
                    <ArrowDown className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2" onPointerDown={(event) => event.stopPropagation()}>
        <div className="relative flex items-center">
          <Search className="absolute left-3 size-4 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search nodes..."
            className="w-64 border-none bg-[var(--rowboat-raised)] pl-9 pr-20 shadow-[var(--rowboat-shadow-soft)]"
          />
          <div className="absolute right-3 flex items-center gap-2">
            {searchHits !== null && <span className="text-xs text-muted-foreground">{searchHits}</span>}
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
