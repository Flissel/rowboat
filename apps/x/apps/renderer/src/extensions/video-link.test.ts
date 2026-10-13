import { describe, expect, it, vi } from 'vitest'

// markdown-editor pulls in embed-block, whose react-tweet import loads a .css file Node cannot parse.
// Same stub as src/components/spaces/checkbox-toggle.test.tsx.
vi.mock('react-tweet', () => ({ Tweet: () => null }))

import { blockToMarkdown } from '@/components/markdown-editor'
import { VideoLinkExtension } from './video-link'

describe('video links', () => {
  it('is a block node named videoLink', () => {
    expect(VideoLinkExtension.name).toBe('videoLink')
  })

  it('survives saving as a markdown link', () => {
    expect(blockToMarkdown({ type: 'videoLink', attrs: { src: 'http://localhost:8977/demo.mp4', title: 'Demo' } }))
      .toBe('[Demo](http://localhost:8977/demo.mp4)')
  })

  it('gets a default title when it has none', () => {
    expect(blockToMarkdown({ type: 'videoLink', attrs: { src: 'http://x/a.webm', title: '' } }))
      .toBe('[▶ Video abspielen](http://x/a.webm)')
  })
})
