import { clamp, distance, distanceToSegment, resolveQPath } from '../geometry/geometry'
import type { Vec2 } from '../model/types'

const EPSILON = 1e-9

interface FieldSize { width: number; height: number }

export function closestOnSegment(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const square = dx * dx + dy * dy
  const ratio = square === 0 ? 0 : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / square, 0, 1)
  return { x: start.x + dx * ratio, y: start.y + dy * ratio }
}

/** Exact cuts, including a repeated root for a tangent, on a finite segment. */
export function circleSegmentCuts(center: Vec2, radius: number, start: Vec2, end: Vec2): number[] {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const a = dx * dx + dy * dy
  if (a === 0) return []
  const ox = start.x - center.x
  const oy = start.y - center.y
  const b = 2 * (ox * dx + oy * dy)
  const c = ox * ox + oy * oy - radius * radius
  const discriminant = b * b - 4 * a * c
  if (discriminant < -EPSILON) return []
  const root = Math.sqrt(Math.max(0, discriminant))
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter((ratio) => ratio >= -EPSILON && ratio <= 1 + EPSILON)
    .map((ratio) => clamp(ratio, 0, 1))
}

function interpolate(start: Vec2, end: Vec2, ratio: number): Vec2 {
  return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }
}

function edges(field: FieldSize): [Vec2, Vec2][] {
  const { width, height } = field
  return [
    [{ x: 0, y: 0 }, { x: width, y: 0 }],
    [{ x: width, y: 0 }, { x: width, y: height }],
    [{ x: width, y: height }, { x: 0, y: height }],
    [{ x: 0, y: height }, { x: 0, y: 0 }],
  ]
}

function inside(point: Vec2, field: FieldSize): boolean {
  return point.x >= -EPSILON && point.x <= field.width + EPSILON
    && point.y >= -EPSILON && point.y <= field.height + EPSILON
}

/** Nearest legal launch outside a target's fixed-Q overshoot disk. */
function runOutsideDisk(position: Vec2, target: Vec2, radius: number, field: FieldSize): number {
  const candidates: Vec2[] = []
  const gap = distance(position, target)
  if (gap > EPSILON) {
    candidates.push(interpolate(target, position, radius / gap))
  } else {
    candidates.push(
      { x: target.x + radius, y: target.y }, { x: target.x - radius, y: target.y },
      { x: target.x, y: target.y + radius }, { x: target.x, y: target.y - radius },
    )
  }
  for (const [start, end] of edges(field)) {
    candidates.push(start)
    for (const ratio of circleSegmentCuts(target, radius, start, end)) {
      candidates.push(interpolate(start, end, ratio))
    }
  }
  let best = Infinity
  for (const origin of candidates) {
    if (inside(origin, field) && distance(origin, target) >= radius - EPSILON) {
      best = Math.min(best, distance(position, origin))
    }
  }
  return best
}

function landing(origin: Vec2, target: Vec2, qDistance: number, field: FieldSize): Vec2 {
  return resolveQPath([origin, target], qDistance, true, field.width, field.height).at(-1) ?? origin
}

/**
 * A field-clipped Q is useful only if that boundary landing already covers
 * the route. Find the nearest point in each edge/capsule intersection, then
 * the running required BEFORE Q to reach it. No post-Q return run is allowed.
 */
function boundaryPreRun(
  position: Vec2, start: Vec2, end: Vec2, radius: number,
  qDistance: number, field: FieldSize,
): number {
  let best = Infinity
  for (const [edgeStart, edgeEnd] of edges(field)) {
    const candidates: Vec2[] = [edgeStart, edgeEnd]
    for (const point of [position, start, end]) candidates.push(closestOnSegment(point, edgeStart, edgeEnd))
    for (const center of [start, end]) {
      for (const ratio of circleSegmentCuts(center, radius, edgeStart, edgeEnd)) {
        candidates.push(interpolate(edgeStart, edgeEnd, ratio))
      }
    }

    const segmentLength = distance(start, end)
    if (segmentLength > EPSILON) {
      const nx = -(end.y - start.y) / segmentLength
      const ny = (end.x - start.x) / segmentLength
      const initial = (edgeStart.x - start.x) * nx + (edgeStart.y - start.y) * ny
      const change = (edgeEnd.x - edgeStart.x) * nx + (edgeEnd.y - edgeStart.y) * ny
      if (Math.abs(change) > EPSILON) {
        for (const offset of [-radius, radius]) {
          const ratio = (offset - initial) / change
          if (ratio >= 0 && ratio <= 1) candidates.push(interpolate(edgeStart, edgeEnd, ratio))
        }
      }
    }

    for (const boundary of candidates) {
      if (distanceToSegment(boundary, start, end) > radius + EPSILON) continue
      const gap = distance(position, boundary)
      const preRun = Math.max(0, gap - qDistance)
      const origin = gap <= EPSILON ? position : interpolate(position, boundary, preRun / gap)
      // The full Q must really reach this edge; never shorten an interior Q.
      const actualLanding = landing(origin, boundary, qDistance, field)
      if (distance(actualLanding, boundary) > 1e-6) continue
      best = Math.min(best, preRun)
    }
  }
  return best
}

/** Minimum legal running BEFORE a full/clipped Q whose landing covers the route. */
export function fixedQPreRunDistance(
  position: Vec2, start: Vec2, end: Vec2, radius: number,
  qDistance: number, field: FieldSize,
): number {
  const nearest = closestOnSegment(position, start, end)
  const minimum = distance(position, nearest)
  if (minimum > qDistance + radius) {
    // Run and Q point toward the target, wholly inside the convex field.
    return minimum - radius - qDistance
  }
  const maximum = Math.max(distance(position, start), distance(position, end))
  if (maximum + radius >= qDistance - EPSILON) return 0

  // All route points are too near. First run to a legal launch position,
  // or use a genuinely covering boundary landing. Crossing the capsule on
  // the way to an overshooting landing never counts as a shield block.
  return Math.min(
    boundaryPreRun(position, start, end, radius, qDistance, field),
    runOutsideDisk(position, start, qDistance - radius, field),
    runOutsideDisk(position, end, qDistance - radius, field),
  )
}
