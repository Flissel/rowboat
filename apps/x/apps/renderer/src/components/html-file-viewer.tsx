import { useFileViewerSource } from './file-viewer-source'
import { LegacyHtmlFileViewer } from './html-file-viewer-legacy'
import { useEffect, useMemo, useRef, useState } from 'react'
import { konzept } from '@x/shared'
import { LOCAL_RUNTIME } from '@/lib/feature-flags'
import {
  cacheBustedUrl,
  canConfirm,
  confirmDelayMs,
  konzeptHinweise,
  linkOpenRequest,
  nextPendingRequest,
  noteOpenRequest,
  reloadDebounceMs,
  workspaceEventTouches,
  type PendingRequest,
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

/**
 * The Flaeche (header, hints, reload, message bridge, confirmation strip) applies only to HTML under
 * knowledge/ in the desktop app. Everything else (web build, Spaces documents, local previews,
 * background-task reports) keeps the view as it was before: LegacyHtmlFileViewer, untouched.
 */
export function HtmlFileViewer({ path, active = true }: HtmlFileViewerProps) {
  const source = useFileViewerSource()
  if (!LOCAL_RUNTIME || !source.workspace || !konzept.isKnowledgeHtmlPath(path)) return <LegacyHtmlFileViewer path={path} />
  return <FlaecheViewer path={path} active={active} />
}

function FlaecheViewer({ path, active }: { path: string; active: boolean }) {
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
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [, setTick] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const lastPathRef = useRef<string | null>(null)
  const iframeSrc = useMemo(() => cacheBustedUrl(source.url(path), version), [path, source, version])

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
        // Title and hints come from the file text, read here once per (re)load -- never from inside the frame.
        // (The read API has no length limit, so a reload re-reads up to 5 MB.)
        try {
          const doc = await source.read({ path, encoding: 'utf8' })
          if (cancelled) return
          setFileText(doc.data)
        } catch {
          if (cancelled) return
          setFileText(null)
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
    } else if (typeof window.ipc?.on === 'function') {
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
    setPending((p) => nextPendingRequest(p, { type: 'reset' }))
    setVersion((v) => v + 1)
  }, [stale, active])

  // A hidden viewer shows no confirmation strip and has no listener (below).
  useEffect(() => {
    if (!active) setPending((p) => nextPendingRequest(p, { type: 'reset' }))
  }, [active])

  // Requests from the page arrive as messages (the frame has no allow-popups, so scripts cannot open
  // anything themselves). One listener per visible viewer, only from this frame's own window. Neither
  // a web link nor a note opens on a message: both only show the confirmation strip, and only a click
  // on its "Öffnen" button opens them. No activation, focus or timing heuristics.
  useEffect(() => {
    if (!active) return
    let gone = false
    const onMessage = (e: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || e.source !== frameWindow) return
      const link = linkOpenRequest(e.data)
      if (link) {
        setPending((p) => nextPendingRequest(p, { type: 'request', kind: 'link', value: link, now: Date.now() }))
        return
      }
      const note = noteOpenRequest(e.data)
      if (!note) return
      source
        .stat({ path: note })
        .then((st) => {
          if (gone || st.kind !== 'file') return
          setPending((p) => nextPendingRequest(p, { type: 'request', kind: 'note', value: note, now: Date.now() }))
        })
        .catch(() => {})
    }
    window.addEventListener('message', onMessage)
    return () => {
      gone = true
      window.removeEventListener('message', onMessage)
    }
  }, [active, source])

  // Re-render once the lock of "Öffnen" is over.
  const pendingAt = pending?.at
  useEffect(() => {
    if (pendingAt === undefined) return
    const timer = setTimeout(() => setTick((n) => n + 1), confirmDelayMs + 20)
    return () => clearTimeout(timer)
  }, [pendingAt])

  const title = useMemo(() => {
    const name = path.split('/').pop() ?? path
    return (fileText ? konzept.htmlTitle(fileText) : null) || name
  }, [fileText, path])
  const hinweise = useMemo(() => (fileText ? konzeptHinweise(fileText, fileSize) : []), [fileText, fileSize])
  const pendingHost = useMemo(() => {
    if (pending?.kind !== 'link') return ''
    try {
      return new URL(pending.value).host
    } catch {
      return ''
    }
  }, [pending])

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
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('rowboat:show-in-graph', { detail: { path } }))}
          className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
        >
          Im Graphen zeigen
        </button>
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
        {pending && (
          // Overlay on top of the frame (never in the flow): the page content does not move when the
          // strip appears or changes. Keyed by the request so no focus carries over; nothing here
          // takes focus by itself, and "Öffnen" is locked for confirmDelayMs.
          <div
            key={pending.at}
            className="absolute inset-x-0 top-0 z-10 flex items-start gap-3 border-b border-border bg-muted px-3 py-2 text-xs text-foreground shadow-md"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{pending.kind === 'link' ? 'Link öffnen?' : 'Notiz öffnen?'}</p>
              {pending.kind === 'link' && pendingHost && <p className="break-all text-sm font-semibold">{pendingHost}</p>}
              <p className="max-h-24 overflow-y-auto break-all text-muted-foreground">{pending.value}</p>
            </div>
            <button
              type="button"
              disabled={!canConfirm(pending, Date.now())}
              onClick={() => {
                if (!canConfirm(pending, Date.now())) return
                const { kind, value } = pending
                setPending((p) => nextPendingRequest(p, { type: 'open' }))
                if (kind === 'link') {
                  // Same path the rest of the renderer uses: the main window-open handler sends it to the system browser.
                  window.open(value, '_blank', 'noopener,noreferrer')
                } else {
                  window.dispatchEvent(new CustomEvent('rowboat:open-note', { detail: { path: value } }))
                }
              }}
              className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 font-medium hover:bg-accent disabled:opacity-50"
            >
              Öffnen
            </button>
            <button
              type="button"
              onClick={() => setPending((p) => nextPendingRequest(p, { type: 'cancel' }))}
              className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 font-medium hover:bg-accent"
            >
              Abbrechen
            </button>
          </div>
        )}
        {state.kind === 'loaded' && (
          <iframe
            key={`${path}#${version}`}
            ref={iframeRef}
            src={iframeSrc}
            // No `allow-popups` and no `allow-same-origin`: the doc stays origin-isolated and a
            // script cannot open a window (Electron would send it to the system browser).
            // Web links and notes ask for confirmation in the viewer.
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
