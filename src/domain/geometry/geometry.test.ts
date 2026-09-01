import { describe, expect, it } from 'vitest'
import { directionAngle, distance, getShootZone, normalizeAngle, pathLength, pointAlongPath, resolveQPath, truncatePath } from './geometry'

describe('geometry', () => {
  it('measures and samples multi-segment paths in logical grid units', () => {
    const path = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }]
    expect(pathLength(path)).toBe(7)
    expect(pointAlongPath(path, 0.5)).toEqual({ x: 3, y: 0.5 })
    expect(distance(path[0]!, path[2]!)).toBe(5)
  })

  it('truncates a turnable Q path without changing its start', () => {
    const path = truncatePath([{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 4 }], 2.5)
    expect(path[0]).toEqual({ x: 1, y: 1 })
    expect(pathLength(path)).toBeCloseTo(2.5)
    expect(path.at(-1)).toEqual({ x: 3, y: 1.5 })
  })

  it('uses a short fire-Q click as direction while keeping the configured distance', () => {
    const path = resolveQPath([{ x: 5, y: 7 }, { x: 5.2, y: 7 }], 2.3, true, 20, 14)
    expect(path).toEqual([{ x: 5, y: 7 }, { x: 7.3, y: 7 }])
    expect(pathLength(path)).toBeCloseTo(2.3)
  })

  it('clips a fixed Q at the field boundary without changing its direction', () => {
    const path = resolveQPath([{ x: 19, y: 13 }, { x: 20, y: 14 }], 2.3, true, 20, 14)
    expect(path.at(-1)).toEqual({ x: 20, y: 14 })
    expect(pathLength(path)).toBeCloseTo(Math.SQRT2)
  })

  it('classifies small, large and outside shooting zones for both teams', () => {
    expect(getShootZone({ x: 17, y: 5 }, 'blue', 20, 10, 4, 7)).toBe('inner')
    expect(getShootZone({ x: 14, y: 5 }, 'blue', 20, 10, 4, 7)).toBe('outer')
    expect(getShootZone({ x: 10, y: 5 }, 'blue', 20, 10, 4, 7)).toBe('outside')
    expect(getShootZone({ x: 3, y: 5 }, 'red', 20, 10, 4, 7)).toBe('inner')
  })

  it('normalizes numeric and pointer-derived facing across zero degrees', () => {
    expect(normalizeAngle(360)).toBe(0)
    expect(normalizeAngle(-90)).toBe(270)
    expect(normalizeAngle(721)).toBe(1)
    expect(normalizeAngle(Number.NaN)).toBe(0)
    expect(directionAngle({ x: 5, y: 5 }, { x: 6, y: 5 })).toBe(0)
    expect(directionAngle({ x: 5, y: 5 }, { x: 5, y: 6 })).toBe(90)
    expect(directionAngle({ x: 5, y: 5 }, { x: 4, y: 5 })).toBe(180)
    expect(directionAngle({ x: 5, y: 5 }, { x: 5, y: 4 })).toBe(270)
    expect(directionAngle({ x: 5, y: 5 }, { x: 6, y: 4.99 })).toBeGreaterThan(359)
    expect(directionAngle({ x: 5, y: 5 }, { x: 5, y: 5 }, 270)).toBe(270)
  })
})
