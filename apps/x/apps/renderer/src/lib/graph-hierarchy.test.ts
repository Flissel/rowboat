import { describe, expect, it } from 'vitest'
import { DEFAULT_FORCES, hierarchyForces, initialHierarchyPositions, parseHierarchy } from './graph-hierarchy'

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

describe('hierarchyForces', () => {
  const ring = DEFAULT_FORCES.ringSpacing

  it('pulls a node outside its ring inward and a node inside outward', () => {
    const nodes = [{ id: 'out', level: 1 }, { id: 'in', level: 2 }]
    const positions = new Map([['out', { x: ring * 2, y: 0 }], ['in', { x: ring, y: 0 }]])
    const forces = hierarchyForces(nodes, positions)
    expect(forces.get('out')!.x).toBeLessThan(0)
    expect(forces.get('in')!.x).toBeGreaterThan(0)
  })

  it('pulls level 0 to the centre', () => {
    const forces = hierarchyForces([{ id: 'c', level: 0 }], new Map([['c', { x: 30, y: -40 }]]))
    expect(forces.get('c')!.x).toBeLessThan(0)
    expect(forces.get('c')!.y).toBeGreaterThan(0)
  })

  it('pulls a child tangentially toward its parent angle', () => {
    const nodes = [{ id: 'p', level: 1 }, { id: 'c', level: 2, parentId: 'p' }]
    const positions = new Map([['p', { x: 0, y: ring }], ['c', { x: ring * 2, y: 0 }]])
    const force = hierarchyForces(nodes, positions).get('c')!
    expect(force.y).toBeGreaterThan(0)
  })

  it('gives no force to a node without a level', () => {
    const forces = hierarchyForces([{ id: 'x' }], new Map([['x', { x: 10, y: 10 }]]))
    expect(forces.has('x')).toBe(false)
  })
})

describe('initialHierarchyPositions', () => {
  const ring = DEFAULT_FORCES.ringSpacing

  it('puts every node on its ring and children in their parent sector', () => {
    const nodes = [
      { id: 'company', level: 0 },
      { id: 'd1', level: 1, parentId: 'company' },
      { id: 'd2', level: 1, parentId: 'company' },
      { id: 'a1', level: 2, parentId: 'd1' },
      { id: 'a2', level: 2, parentId: 'd2' },
    ]
    const pos = initialHierarchyPositions(nodes)
    expect(Math.hypot(pos.get('company')!.x, pos.get('company')!.y)).toBe(0)
    for (const id of ['d1', 'd2']) expect(Math.hypot(pos.get(id)!.x, pos.get(id)!.y)).toBeCloseTo(ring)
    for (const id of ['a1', 'a2']) expect(Math.hypot(pos.get(id)!.x, pos.get(id)!.y)).toBeCloseTo(ring * 2)
    const angle = (id: string) => Math.atan2(pos.get(id)!.y, pos.get(id)!.x)
    expect(angle('a1')).toBeCloseTo(angle('d1'))
    expect(angle('a2')).toBeCloseTo(angle('d2'))
  })

  it('skips nodes without a level', () => {
    expect(initialHierarchyPositions([{ id: 'x' }]).size).toBe(0)
  })

  it('initial positions survive a parent cycle', () => {
    const nodes = [{ id: 'a', level: 3, parentId: 'b' }, { id: 'b', level: 3, parentId: 'a' }]
    expect(initialHierarchyPositions(nodes).size).toBe(2)
  })
})
