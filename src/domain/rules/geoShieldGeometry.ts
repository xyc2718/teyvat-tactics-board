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

/** Extreme legal run origins in the intersection of a run disk and the field. */
function runOrigins(position: Vec2, target: Vec2, runDistance: number, field: FieldSize): Vec2[] {
  if (runDistance <= EPSILON) return [position]
  const result = [position]
  const gap = distance(position, target)
  if (gap > EPSILON) {
    const farthest = interpolate(target, position, 1 + runDistance / gap)
    if (inside(farthest, field)) result.push(farthest)
  }
  for (const [start, end] of edges(field)) {
    if (distance(position, start) <= runDistance + EPSILON) result.push(start)
    for (const ratio of circleSegmentCuts(position, runDistance, start, end)) {
      result.push(interpolate(start, end, ratio))
    }
  }
  return result
}

function landing(origin: Vec2, target: Vec2, qDistance: number, field: FieldSize): Vec2 {
  return resolveQPath([origin, target], qDistance, true, field.width, field.height).at(-1) ?? origin
}

/**
 * A clipped Q may end anywhere on a field edge. On each edge, minimize
 * max(0, |P-B|-availableDistance) + max(0, distance(B, segment)-radius).
 * This convex, piecewise smooth function has minima at circle/capsule cuts,
 * projections, or the reflected shortest path. No angular/time search is used.
 */
function boundaryResidual(
  position: Vec2, start: Vec2, end: Vec2, radius: number,
  qDistance: number, runDistance: number, field: FieldSize,
): number {
  let best = Infinity
  const availableDistance = qDistance + runDistance
  for (const [edgeStart, edgeEnd] of edges(field)) {
    const candidates: Vec2[] = [edgeStart, edgeEnd]
    const edgeLength = distance(edgeStart, edgeEnd)
    const ux = (edgeEnd.x - edgeStart.x) / edgeLength
    const uy = (edgeEnd.y - edgeStart.y) / edgeLength
    const normal = (point: Vec2) => (point.x - edgeStart.x) * -uy + (point.y - edgeStart.y) * ux
    for (const point of [position, start, end]) candidates.push(closestOnSegment(point, edgeStart, edgeEnd))
    for (const [center, circleRadius] of [[position, availableDistance], [start, radius], [end, radius]] as const) {
      for (const ratio of circleSegmentCuts(center, circleRadius, edgeStart, edgeEnd)) {
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

    const signed = normal(position)
    const reflected = { x: position.x + 2 * signed * uy, y: position.y - 2 * signed * ux }
    for (const target of [start, end, closestOnSegment(reflected, start, end)]) {
      const denominator = normal(target) - normal(reflected)
      if (Math.abs(denominator) > EPSILON) {
        const candidate = interpolate(reflected, target, -normal(reflected) / denominator)
        candidates.push(closestOnSegment(candidate, edgeStart, edgeEnd))
      }
    }

    for (const boundary of candidates) {
      const gap = distance(position, boundary)
      const preRun = Math.max(0, gap - qDistance)
      const origin = gap <= EPSILON ? position : interpolate(position, boundary, preRun / gap)
      // The full Q must really reach this edge; never shorten an interior Q.
      const actualLanding = landing(origin, boundary, qDistance, field)
      if (distance(actualLanding, boundary) > 1e-6) continue
      const residual = Math.max(0, preRun - runDistance)
        + Math.max(0, distanceToSegment(boundary, start, end) - radius)
      best = Math.min(best, residual)
    }
  }
  return best
}

/** Remaining running after the earliest available fixed Q, in grid units. */
export function fixedQResidual(
  position: Vec2, start: Vec2, end: Vec2, radius: number,
  qDistance: number, runDistance: number, field: FieldSize,
): number {
  const nearest = closestOnSegment(position, start, end)
  const minimum = distance(position, nearest)
  if (minimum > qDistance + radius) {
    // Run and Q point toward the target, wholly inside the convex field.
    return Math.max(0, minimum - radius - qDistance - runDistance)
  }
  const maximum = Math.max(distance(position, start), distance(position, end))
  if (maximum + radius >= qDistance - EPSILON) return 0

  // Every target shield center is too near for a full blink. Running away
  // during cooldown can fix the overshoot; a field edge may clip the blink.
  let best = boundaryResidual(position, start, end, radius, qDistance, runDistance, field)
  for (const target of [start, end]) {
    for (const origin of runOrigins(position, target, runDistance, field)) {
      const gap = distance(origin, target)
      // If this extreme goes past the annulus, a prefix of the same legal
      // straight run reaches the annulus while Q is still cooling down.
      if (gap >= qDistance - radius) return 0
      const actualLanding = landing(origin, target, qDistance, field)
      best = Math.min(best, Math.max(0, distanceToSegment(actualLanding, start, end) - radius))
    }
  }
  return best
}
