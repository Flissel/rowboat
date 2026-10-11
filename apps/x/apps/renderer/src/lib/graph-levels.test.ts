import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultLevelOrder, levelY, loadLevelOrder, moveLevel, resolveLevelOrder, saveLevelOrder, toThreeColor,
} from './graph-levels'

const notes = (counts: Record<string, number>) =>
  Object.entries(counts).flatMap(([group, n]) => Array.from({ length: n }, () => ({ group })))

describe('3D graph levels from the folder structure', () => {
  afterEach(() => window.localStorage.clear())

  it('puts the folder with the fewest notes on top, like Brands above Models above Components', () => {
    expect(defaultLevelOrder(notes({ Components: 56, Brands: 1, Requirements: 21, Models: 4 })))
      .toEqual(['Brands', 'Models', 'Requirements', 'Components'])
  })

  it('breaks ties by name and treats notes outside a folder as root', () => {
    expect(defaultLevelOrder([{ group: 'Topics' }, { group: 'People' }, { group: '' }, { group: '' }]))
      .toEqual(['People', 'Topics', 'root'])
  })

  it('keeps a saved order, drops vanished folders and appends new ones in the default order', () => {
    const nodes = notes({ Brands: 1, Models: 4, Components: 9, People: 2 })
    expect(resolveLevelOrder(['Components', 'Gone', 'Brands', 'Components'], nodes))
      .toEqual(['Components', 'Brands', 'People', 'Models'])
    expect(resolveLevelOrder(null, nodes)).toEqual(['Brands', 'People', 'Models', 'Components'])
  })

  it('moves a level up or down and leaves the ends and unknown folders alone', () => {
    const order = ['Brands', 'Models', 'Components']
    expect(moveLevel(order, 'Components', -1)).toEqual(['Brands', 'Components', 'Models'])
    expect(moveLevel(order, 'Brands', 1)).toEqual(['Models', 'Brands', 'Components'])
    expect(moveLevel(order, 'Brands', -1)).toEqual(order)
    expect(moveLevel(order, 'Components', 1)).toEqual(order)
    expect(moveLevel(order, 'Nope', 1)).toEqual(order)
    expect(order).toEqual(['Brands', 'Models', 'Components'])
  })

  it('stacks the levels top down around y = 0', () => {
    expect([0, 1, 2].map((i) => levelY(i, 3, 100))).toEqual([100, 0, -100])
    expect(levelY(0, 1, 100)).toBe(0)
  })

  it('turns the space form of hsl() into the comma form three.js understands', () => {
    expect(toThreeColor('hsl(210 50% 40%)')).toBe('hsl(210, 50%, 40%)')
    expect(toThreeColor('hsl(12.5 80% 61.5%)')).toBe('hsl(12.5, 80%, 61.5%)')
    expect(toThreeColor('#ff8800')).toBe('#ff8800')
  })

  it('round-trips the order through storage and ignores garbage', () => {
    saveLevelOrder(['Brands', 'Models'])
    expect(loadLevelOrder()).toEqual(['Brands', 'Models'])
    window.localStorage.setItem('rowboat.graph3d.levelOrder', '{"not":"a list"}')
    expect(loadLevelOrder()).toBeNull()
    window.localStorage.setItem('rowboat.graph3d.levelOrder', 'not json')
    expect(loadLevelOrder()).toBeNull()
  })
})
