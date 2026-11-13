import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { FileViewerSourceContext, type FileViewerSource } from './file-viewer-source'
import { HtmlFileViewer } from './html-file-viewer'

afterEach(cleanup)

const SEITE = '<!doctype html><title>Mein Konzept</title><p>Hallo</p>'

function quelle(size = SEITE.length): FileViewerSource {
  const nie = () => Promise.reject(new Error('nicht erwartet'))
  return {
    url: (path) => `app://workspace/${path.split('/').map(encodeURIComponent).join('/')}`,
    stat: async () => ({ kind: 'file', size, mtimeMs: 0, ctimeMs: 0 }) as unknown as Awaited<ReturnType<FileViewerSource['stat']>>,
    read: async () => ({ data: SEITE }) as unknown as Awaited<ReturnType<FileViewerSource['read']>>,
    write: nie,
    open: nie,
    exportCopy: nie,
    loadSheet: nie,
    findCells: nie,
    subscribe: () => () => {},
    workspace: true,
  }
}

function zeige(path: string, size?: number) {
  return render(
    <FileViewerSourceContext.Provider value={quelle(size)}>
      <HtmlFileViewer path={path} />
    </FileViewerSourceContext.Provider>,
  )
}

it('Wissens-HTML: Rahmen nur mit allow-scripts, Kopfzeile ohne "In neuem Fenster öffnen"', async () => {
  zeige('knowledge/Konzepte/k.html')
  const rahmen = await screen.findByTitle('HTML preview')
  expect(rahmen.getAttribute('sandbox')).toBe('allow-scripts')
  expect(rahmen.getAttribute('src')).toBe('app://workspace/knowledge/Konzepte/k.html')
  expect(await screen.findByText('Mein Konzept')).toBeInTheDocument()
  expect(screen.getByText('Im Graphen zeigen')).toBeInTheDocument()
  expect(screen.queryByText('In neuem Fenster öffnen')).not.toBeInTheDocument()
})

it('Hintergrund-Bericht außerhalb von knowledge/: alte Ansicht wie vorher (R38)', async () => {
  zeige('bg-tasks/x/index.html')
  const rahmen = await screen.findByTitle('HTML preview')
  expect(rahmen.getAttribute('sandbox')).toBe('allow-scripts allow-popups')
  expect(screen.queryByText('Im Graphen zeigen')).not.toBeInTheDocument()
})

it('zu große Wissens-HTML: nur der Größenhinweis, kein "Open in system" (R50); alte Ansicht behält den Knopf', async () => {
  const gross = 6 * 1024 * 1024
  zeige('knowledge/Konzepte/riesig.html', gross)
  expect(await screen.findByText('File too large to preview')).toBeInTheDocument()
  expect(screen.queryByText('Open in system')).not.toBeInTheDocument()
  expect(screen.queryByTitle('HTML preview')).not.toBeInTheDocument()
  cleanup()
  zeige('bg-tasks/x/index.html', gross)
  expect(await screen.findByText('File too large to preview')).toBeInTheDocument()
  expect(screen.getByText('Open in system')).toBeInTheDocument()
})
