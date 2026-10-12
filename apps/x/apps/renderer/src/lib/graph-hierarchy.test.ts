import { describe, expect, it } from 'vitest'
import { parseHierarchy } from './graph-hierarchy'

const note = (front: string, body = '# Title\n') => `---\n${front}\n---\n${body}`

describe('parseHierarchy', () => {
  it('reads level, parent and domain', () => {
    const h = parseHierarchy(note('id: deal-x\nlevel: 3\ndomain: sales\nparent: "[[Areas/Pipeline]]"'))
    expect(h).toEqual({ level: 3, parent: 'Areas/Pipeline', domain: 'sales', relations: [] })
  })

  it('accepts an unquoted parent and a quoted domain', () => {
    const h = parseHierarchy(note('parent: [[Areas/Pipeline]]\ndomain: "sales"'))
    expect(h.parent).toBe('Areas/Pipeline')
    expect(h.domain).toBe('sales')
  })

  it('strips alias and heading', () => {
    const h = parseHierarchy(note('parent: "[[Brands/BMW|BMW]]"\nabout: ["[[Models/5er G60#Sales]]"]'))
    expect(h.parent).toBe('Brands/BMW')
    expect(h.relations).toEqual([{ name: 'about', target: 'Models/5er G60' }])
  })

  it('turns link lists into relations and ignores other keys', () => {
    const h = parseHierarchy(note(
      'customer: ["[[Organizations/Acme]]", "[[Organizations/Beta]]"]\nowner: ["[[People/Felix Baumann]]"]\n' +
      'status: active\nsource: sales-claw\nwhen: 2026-10-20'))
    expect(h.relations).toEqual([
      { name: 'customer', target: 'Organizations/Acme' },
      { name: 'customer', target: 'Organizations/Beta' },
      { name: 'owner', target: 'People/Felix Baumann' },
    ])
  })

  it('relation to an attachment', () => {
    const h = parseHierarchy(note('evidence: ["[[Data/BMW Dataset.xlsx|data]]"]'))
    expect(h.relations).toEqual([{ name: 'evidence', target: 'Data/BMW Dataset.xlsx' }])
  })

  it('accepts CRLF and a BOM', () => {
    const h = parseHierarchy('\ufeff---\r\nlevel: 2\r\nparent: "[[Domains/Market & sales]]"\r\n---\r\n# A\r\n')
    expect(h.level).toBe(2)
    expect(h.parent).toBe('Domains/Market & sales')
  })

  it('a note without front matter has no hierarchy', () => {
    expect(parseHierarchy('# Just a note with [[Topics/Comfort]]\n')).toEqual({ relations: [] })
  })

  it('ignores a non-numeric level and links in the body', () => {
    const h = parseHierarchy(note('level: three', 'See [[Topics/Comfort]].\n'))
    expect(h).toEqual({ relations: [] })
  })
})
