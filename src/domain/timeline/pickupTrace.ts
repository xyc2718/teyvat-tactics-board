import { clamp } from '../geometry/geometry'
import type { PickupTracePoint, Vec2 } from '../model/types'

export function pickupTracePosition(trace: readonly PickupTracePoint[], time: number): Vec2 {
  if (!trace.length) return { x: 0, y: 0 }
  if (time <= trace[0]!.time) return { ...trace[0]!.position }
  if (time >= trace.at(-1)!.time) return { ...trace.at(-1)!.position }
  let low = 0
  let high = trace.length - 1
  while (high - low > 1) {
    const middle = (low + high) >>> 1
    if (trace[middle]!.time <= time) low = middle
    else high = middle
  }
  const start = trace[low]!
  const end = trace[high]!
  const fraction = clamp((time - start.time) / (end.time - start.time), 0, 1)
  return { x: start.position.x + (end.position.x - start.position.x) * fraction, y: start.position.y + (end.position.y - start.position.y) * fraction }
}
