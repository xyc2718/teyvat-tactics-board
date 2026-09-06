import { describe, expect, it } from 'vitest'
import { compilePath } from './compiledPath'
import { pointAlongPath } from './geometry'

describe('compiled arc-length path', () => {
  it('matches distance lookup across corners, duplicate vertices and bounds', () => {
    const path = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }]
    const route = compilePath(path)
    expect(route.length).toBe(7)
    for (const distance of [-1, 0, 1, 3, 3.1, 5, 7, 8]) {
      expect(route.pointAtDistance(distance)).toEqual(pointAlongPath(path, Math.max(0, Math.min(1, distance / 7))))
    }
  })

  it('owns both its source and returned points and handles degenerate paths', () => {
    const path = [{ x: 1, y: 2 }, { x: 4, y: 2 }]
    const route = compilePath(path)
    path[0]!.x = 999
    route.pointAtDistance(0).x = 999
    route.pointAtDistance(3).y = 999
    expect(route.pointAtDistance(0)).toEqual({ x: 1, y: 2 })
    expect(route.pointAtDistance(3)).toEqual({ x: 4, y: 2 })
    expect(compilePath([]).pointAtDistance(1)).toEqual({ x: 0, y: 0 })
    expect(compilePath([{ x: 2, y: 2 }]).length).toBe(0)
  })
})
