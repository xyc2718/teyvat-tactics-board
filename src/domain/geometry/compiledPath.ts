import { clamp, distance } from './geometry'
import type { Vec2 } from '../model/types'

/** An owned arc-length snapshot: O(N) compilation, O(log N) point lookup. */
export function compilePath(path: readonly Vec2[]) {
  const points = path.map((point) => ({ ...point }))
  const cumulative = [0]
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1]! + distance(points[index - 1]!, points[index]!))
  }
  const length = cumulative.at(-1) ?? 0
  return {
    length,
    pointAtDistance(rawDistance: number): Vec2 {
      const first = points[0] ?? { x: 0, y: 0 }
      if (length <= 1e-6 || rawDistance <= 0) return { ...first }
      const target = clamp(rawDistance, 0, length)
      if (target >= length) return { ...(points.at(-1) ?? first) }
      let low = 1
      let high = points.length - 1
      while (low < high) {
        const middle = (low + high) >>> 1
        if (cumulative[middle]! < target) low = middle + 1
        else high = middle
      }
      const start = points[low - 1]!
      const end = points[low]!
      const segmentLength = cumulative[low]! - cumulative[low - 1]!
      const progress = segmentLength <= 1e-6 ? 0 : (target - cumulative[low - 1]!) / segmentLength
      return {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
      }
    },
  }
}
