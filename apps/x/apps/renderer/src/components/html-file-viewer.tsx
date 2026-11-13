import { useFileViewerSource } from './file-viewer-source'
import { useEffect, useMemo, useRef, useState } from 'react'
import { konzept } from '@x/shared'
import { LOCAL_RUNTIME } from '@/lib/feature-flags'
import {
  cacheBustedUrl,
  konzeptHinweise,
  linkOpenRequest,
  noteOpenRequest,
  reloadDebounceMs,
  userActivationActive,
  workspaceEventTouches,
} from '@/lib/konzept-flaeche'
import { AlertCircleIcon, ExternalLinkIcon, FileTextIcon, Loader2Icon } from 'lucide-react'

const MAX_SIZE_BYTES = 5 * 1024 * 1024

type ViewerState =
  | { kind: 'loading' }
  | { kind: 'loaded' }
  | { kind: 'empty' }
  | { kind: 'tooLarge'; sizeMB: number }
  | { kind: 'error'; message: string }

interface HtmlFileViewerProps {
  path: string
  /** False while the persistent viewer cache keeps this viewer mounted but hidden. */
  active?: boolean
}

/** Minimum gap between two actions (note/link) that a single click in the page may trigger. */
const ACTION_COOLDOWN_MS = 1000

export function HtmlFileViewer({ path, active = true }: HtmlFileViewerProps) {
  const source = useFileViewerSource()
  const [state, setState] = useState<ViewerState>({ kind: 'loading' })
  const [iframeLoaded, setIframeLoaded] = useState(false)
  // Reload = remount the iframe (new key + cache-busting query). The main process blocks every
  // navigation of a frame that already holds an app://workspace HTML document, so changing src
  // or calling location.reload() on the frame does nothing.
  const [version, setVersion] = useState(0)
  const [stale, setStale] = useState(false)
  const [fileText, setFileText] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const lastPathRef = useRef<string | null>(null)
  const lastActionRef = useRef(0)
  const iframeSrc = useMemo(() => cacheBustedUrl(source.url(path), version), [path, source, version])
  // The web app (2026-10-12) has no protocol to serve a document's folder from,
  // and a sandboxed frame without allow-same-origin isn't controlled by its
  // service worker. So the document goes in as srcdoc, in the same sandbox:
  // HTML and inline styles render, relative files don't, and a script can't
  // reach the page. The page's CSP, which srcdoc inherits, also blocks inline
  // script in production.
  const [srcdoc, setSrcdoc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // A reload of the same file keeps the current view (no spinner flash); a new path starts fresh.
    const isReload = lastPathRef.current === path
    lastPathRef.current = path
    if (!isReload) {
      setState({ kind: 'loading' })
      setIframeLoaded(false)
      setFileText(null)
    }

    ;(async () => {
      try {
        const stat = await source.stat({ path })
        if (cancelled) return
        if (stat.kind !== 'file') {
          setState({ kind: 'error', message: 'Selected path is not a file.' })
          return
        }
        setFileSize(stat.size)
        if (stat.size > MAX_SIZE_BYTES) {
          setState({ kind: 'tooLarge', sizeMB: stat.size / (1024 * 1024) })
          return
        }
        if (stat.size === 0) {
          setState({ kind: 'empty' })
          return
        }
        if (!LOCAL_RUNTIME) {
          const doc = await source.read({ path, encoding: 'utf8' })
          if (cancelled) return
          setSrcdoc(doc.data)
          setFileText(doc.data)
        } else {
          // Title and hints come from the file text, read here once per (re)load -- never from inside the frame.
          try {
            const doc = await source.read({ path, encoding: 'utf8' })
            if (cancelled) return
            setFileText(doc.data)
          } catch {
            if (cancelled) return
            setFileText(null)
          }
        }
        setState({ kind: 'loaded' })
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setState({ kind: 'error', message })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [path, source, version])

  // Changes to this file (workspace watcher, or the agent's write via rowboat:html-touched) are
  // bundled over reloadDebounceMs. A hidden (cached) viewer only marks itself stale and reloads
  // when it is shown again.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        setStale(true)
      }, reloadDebounceMs)
    }
    const onTouched = (e: Event) => {
      const detail = e instanceof CustomEvent ? (e.detail as unknown) : null
      if (typeof detail === 'object' && detail !== null && (detail as { path?: unknown }).path === path) schedule()
    }
    window.addEventListener('rowboat:html-touched', onTouched)
    let stop: (() => void) | undefined
    if (source.subscribe) {
      stop = source.subscribe(schedule)
    } else if (source.workspace && typeof window.ipc?.on === 'function') {
      stop = window.ipc.on('workspace:didChange', (event) => {
        if (workspaceEventTouches(event, path)) schedule()
      })
    }
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('rowboat:html-touched', onTouched)
      stop?.()
    }
  }, [path, source])

  useEffect(() => {
    if (!stale || !active) return
    setStale(false)
    setVersion((v) => v + 1)
  }, [stale, active])

  // Links out of the page arrive as messages (the frame has no allow-popups, so scripts cannot open
  // anything themselves). One listener per visible viewer; accepted only from this frame and only
  // inside a real click (transient user activation). A hidden viewer has no listener at all.
  useEffect(() => {
    if (!active || !LOCAL_RUNTIME) return
    const onMessage = (e: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || e.source !== frameWindow) return
      const note = noteOpenRequest(e.data)
      const link = note ? null : linkOpenRequest(e.data)
      if (!note && !link) return
      if (!userActivationActive(navigator)) return
      const now = Date.now()
      if (now - lastActionRef.current < ACTION_COOLDOWN_MS) return
      lastActionRef.current = now
      if (note) {
        window.dispatchEvent(new CustomEvent('rowboat:open-note', { detail: { path: note } }))
      } else if (link) {
        // Same path the rest of the renderer uses: the main window-open handler sends it to the system browser.
        window.open(link, '_blank', 'noopener,noreferrer')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [active])

  const title = useMemo(() => {
    const name = path.split('/').pop() ?? path
    return (fileText ? konzept.htmlTitle(fileText) : null) || name
  }, [fileText, path])
  const hinweise = useMemo(() => (fileText ? konzeptHinweise(fileText, fileSize) : []), [fileText, fileSize])
  const canShowInGraph = source.workspace && konzept.isKnowledgeHtmlPath(path)

  if (state.kind === 'error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <AlertCircleIcon className="size-6 text-destructive" />
        <p className="text-sm font-medium text-foreground">Could not load preview</p>
        <p className="max-w-md text-xs">{state.message}</p>
        <p className="text-xs opacity-60">{path}</p>
      </div>
    )
  }

  if (state.kind === 'empty') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileTextIcon className="size-6" />
        <p className="text-sm">This file is empty</p>
      </div>
    )
  }

  if (state.kind === 'tooLarge') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <FileTextIcon className="size-6" />
        <p className="text-sm font-medium text-foreground">File too large to preview</p>
        <p className="text-xs">
          {state.sizeMB.toFixed(1)} MB — preview limit is {(MAX_SIZE_BYTES / (1024 * 1024)).toFixed(0)} MB.
        </p>
        <button
          type="button"
          onClick={() => {
            void source.open({ path })
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
        >
          <ExternalLinkIcon className="size-3.5" />
          Open in system
        </button>
      </div>
    )
  }

  // Serve via the `app://workspace/<rel-path>` protocol so the iframe has a
  // proper base URL — relative `<link>`, `<img>`, `<script>` references next
  // to the file resolve correctly (the path-traversal guard in
  // resolveWorkspacePath already gates the protocol handler).
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
        {canShowInGraph && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('rowboat:show-in-graph', { detail: { path } }))}
            className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
          >
            Im Graphen zeigen
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void source.open({ path })
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
        >
          <ExternalLinkIcon className="size-3.5" />
          In neuem Fenster öffnen
        </button>
      </div>
      {hinweise.length > 0 && (
        <ul className="shrink-0 space-y-0.5 border-b border-border bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {hinweise.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}
      <div className="relative min-h-0 flex-1">
        {state.kind === 'loaded' && (
          <iframe
            key={`${path}#${version}`}
            ref={iframeRef}
            {...(LOCAL_RUNTIME ? { src: iframeSrc } : { srcDoc: srcdoc ?? '' })}
            // No `allow-popups` and no `allow-same-origin`: the doc stays origin-isolated and a
            // script cannot open a window (Electron would send it to the system browser).
            // Notes and web links reach the viewer as postMessage and open only after a real click.
            sandbox="allow-scripts"
            className="h-full w-full border-0 bg-white"
            title="HTML preview"
            onLoad={() => setIframeLoaded(true)}
          />
        )}
        {(state.kind === 'loading' || !iframeLoaded) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
            <Loader2Icon className="size-6 animate-spin" />
            <p className="text-sm">Rendering preview…</p>
          </div>
        )}
      </div>
    </div>
  )
}
