// EHL addition (Flissel/rowboat ehl-schema-graph): 3D brain graph. Every note sits on the sphere shell of its
// level around the company note in the centre; parent edges hold subtrees together, relations are drawn in
// orange, body links stay faint. Spec: Flissel/ehl-munich-2026 docs/superpowers/specs/2026-10-12-brain-graph-hierarchy-design.md
import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-3d'
import { forceRadial } from 'd3-force-3d'
import { shellRadius, toGraph3d, type Graph3dLink, type Graph3dNode } from '@/lib/graph-hierarchy'
import type { GraphEdge, GraphNode } from './graph-view'

type Props = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  onSelectNode?: (id: string) => void
}

const LINK_RGB: Record<Graph3dLink['kind'], string> = {
  parent: '200, 200, 210',
  relation: '255, 170, 60',
  link: '150, 150, 150',
}

export function GraphView3D({ nodes, edges, onSelectNode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraphMethods<NodeObject<Graph3dNode>, LinkObject<Graph3dNode, Graph3dLink>>>(undefined)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const data = useMemo(() => toGraph3d(nodes, edges), [nodes, edges])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    graph.d3Force('shells', forceRadial<Graph3dNode>((node) => shellRadius(node.level)).strength(0.9))
    graph.d3Force('charge')?.strength?.(-25)
    graph.d3ReheatSimulation()
  }, [data])

  return (
    <div ref={containerRef} className="absolute inset-0">
      <ForceGraph3D<Graph3dNode, Graph3dLink>
        ref={graphRef}
        graphData={data}
        width={size.width}
        height={size.height}
        backgroundColor="rgba(0,0,0,0)"
        nodeLabel={(node) => node.name}
        nodeColor={(node) => node.color}
        nodeVal={(node) => node.val}
        nodeOpacity={0.95}
        linkColor={(link) => `rgba(${LINK_RGB[link.kind]}, ${link.opacity})`}
        linkWidth={(link) => link.width}
        linkLabel={(link) => link.relation ?? ''}
        onNodeClick={(node) => {
          if (typeof node.id === 'string') onSelectNode?.(node.id)
        }}
        cooldownTicks={200}
        onEngineStop={() => graphRef.current?.zoomToFit(600, 40)}
      />
    </div>
  )
}
