import { lazy, Suspense, useState, type ComponentProps } from 'react'
import { GraphView } from '@/components/graph-view'

// 2D/3D switch for the knowledge graph (2026-10-11, EHL Munich). The 3D view loads on first use, so three.js
// stays out of the main bundle for everyone who never opens it. The choice is kept per browser profile.
const GraphView3D = lazy(() => import('@/components/graph-view-3d').then((m) => ({ default: m.GraphView3D })))

type Mode = '2d' | '3d'
const MODE_KEY = 'rowboat.graph.mode'

function loadMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === '3d' ? '3d' : '2d'
  } catch {
    return '2d'
  }
}

export function KnowledgeGraph(props: ComponentProps<typeof GraphView>) {
  const [mode, setMode] = useState<Mode>(loadMode)
  const choose = (next: Mode) => {
    setMode(next)
    try {
      window.localStorage.setItem(MODE_KEY, next)
    } catch {
      // Storage blocked: the choice lasts for this session only.
    }
  }

  return (
    <div className="relative h-full w-full">
      {mode === '3d' ? (
        <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading 3D view…</div>}>
          <GraphView3D nodes={props.nodes} edges={props.edges} error={props.error} onSelectNode={props.onSelectNode} />
        </Suspense>
      ) : (
        <GraphView {...props} />
      )}
      <div
        className="absolute left-3 top-3 z-30 inline-flex overflow-hidden rounded-md bg-[var(--rowboat-raised)] text-xs shadow-[var(--rowboat-shadow-soft)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {(['2d', '3d'] as const).map((option) => (
          <button
            key={option}
            aria-pressed={mode === option}
            onClick={() => choose(option)}
            className={`px-2.5 py-1 transition-colors hover:bg-foreground/10 ${mode === option ? 'bg-foreground/15 text-foreground' : 'text-muted-foreground'}`}
          >
            {option.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  )
}
