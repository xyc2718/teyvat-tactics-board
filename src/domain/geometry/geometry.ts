import type { MoveAction, Vec2 } from '../model/types'

const EPSILON = 1e-6

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function clampPoint(point: Vec2, width: number, height: number): Vec2 {
  return {
    x: clamp(point.x, 0, width),
    y: clamp(point.y, 0, height),
  }
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function pathLength(path: Vec2[]): number {
  return path.slice(1).reduce((total, point, index) => {
    const previous = path[index]
    return previous ? total + distance(previous, point) : total
  }, 0)
}

/** Samples a quadratic Bezier into a stable polyline for projection and rules. */
export function quadraticPath(start: Vec2, control: Vec2, end: Vec2, segments = 24): Vec2[] {
  const count = Math.max(2, Math.floor(segments))
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count
    const inverse = 1 - t
    return {
      x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
      y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
    }
  })
}

export function resolvedMovePath(action: MoveAction): Vec2[] {
  const start = action.path[0]
  const end = action.path.at(-1)
  if (!start || !end) return action.path.map((point) => ({ ...point }))
  return action.curveControl
    ? quadraticPath(start, action.curveControl, end)
    : [{ ...start }, { ...end }]
}

export function pointAlongPath(path: Vec2[], progress: number): Vec2 {
  if (path.length === 0) return { x: 0, y: 0 }
  const first = path[0]
  if (!first || path.length === 1) return first ?? { x: 0, y: 0 }

  const total = pathLength(path)
  if (total <= EPSILON) return { ...first }
  let remaining = clamp(progress, 0, 1) * total

  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1]
    const end = path[index]
    if (!start || !end) continue
    const segment = distance(start, end)
    if (remaining <= segment || index === path.length - 1) {
      const ratio = segment <= EPSILON ? 0 : remaining / segment
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      }
    }
    remaining -= segment
  }

  return { ...(path[path.length - 1] ?? first) }
}

export function truncatePath(path: Vec2[], maxLength: number): Vec2[] {
  if (path.length < 2 || pathLength(path) <= maxLength) return path.map((point) => ({ ...point }))
  const result: Vec2[] = [{ ...(path[0] ?? { x: 0, y: 0 }) }]
  let remaining = maxLength

  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1]
    const end = path[index]
    if (!start || !end) continue
    const segment = distance(start, end)
    if (segment <= remaining) {
      result.push({ ...end })
      remaining -= segment
      continue
    }
    const ratio = segment <= EPSILON ? 0 : remaining / segment
    result.push({
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    })
    break
  }

  return result
}

/**
 * Resolves an authored Q path against its distance rule. Variable-distance Q
 * keeps the authored shape and is only truncated. Fixed-distance Q uses the
 * click as a direction and extends to the configured distance, stopping only
 * when the field boundary is reached.
 */
export function resolveQPath(
  path: Vec2[],
  maxDistance: number,
  fixedDistance: boolean,
  fieldWidth: number,
  fieldHeight: number,
): Vec2[] {
  if (!fixedDistance) return truncatePath(path, maxDistance)
  const origin = path[0]
  const directionPoint = path.at(-1)
  if (!origin || !directionPoint) return path.map((point) => ({ ...point }))
  const authoredDistance = distance(origin, directionPoint)
  if (authoredDistance <= EPSILON) return path.map((point) => ({ ...point }))

  const unitX = (directionPoint.x - origin.x) / authoredDistance
  const unitY = (directionPoint.y - origin.y) / authoredDistance
  let availableDistance = maxDistance
  if (unitX > EPSILON) availableDistance = Math.min(availableDistance, (fieldWidth - origin.x) / unitX)
  if (unitX < -EPSILON) availableDistance = Math.min(availableDistance, (0 - origin.x) / unitX)
  if (unitY > EPSILON) availableDistance = Math.min(availableDistance, (fieldHeight - origin.y) / unitY)
  if (unitY < -EPSILON) availableDistance = Math.min(availableDistance, (0 - origin.y) / unitY)

  const resolvedDistance = Math.max(0, availableDistance)
  return [
    { ...origin },
    {
      x: origin.x + unitX * resolvedDistance,
      y: origin.y + unitY * resolvedDistance,
    },
  ]
}

export function angleToVector(degrees: number): Vec2 {
  const radians = (degrees * Math.PI) / 180
  return { x: Math.cos(radians), y: Math.sin(radians) }
}

export function oppositeFacingOffset(position: Vec2, facing: number, amount: number): Vec2 {
  const vector = angleToVector(facing)
  return { x: position.x - vector.x * amount, y: position.y - vector.y * amount }
}

export function distanceToSegment(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const squared = dx * dx + dy * dy
  if (squared <= EPSILON) return distance(point, start)
  const ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / squared, 0, 1)
  return distance(point, { x: start.x + ratio * dx, y: start.y + ratio * dy })
}

export interface ClosestPathPoint {
  point: Vec2
  distance: number
  pathDistance: number
  progress: number
}

/** Returns the earliest closest point on a polyline, measured along the full path. */
export function closestPointOnPath(point: Vec2, path: Vec2[]): ClosestPathPoint | null {
  const first = path[0]
  if (!first) return null
  const total = pathLength(path)
  if (path.length === 1 || total <= EPSILON) {
    return { point: { ...first }, distance: distance(point, first), pathDistance: 0, progress: 0 }
  }

  let best: ClosestPathPoint | null = null
  let traversed = 0
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1]
    const end = path[index]
    if (!start || !end) continue
    const dx = end.x - start.x
    const dy = end.y - start.y
    const squared = dx * dx + dy * dy
    const segmentLength = Math.sqrt(squared)
    const ratio = squared <= EPSILON
      ? 0
      : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / squared, 0, 1)
    const closest = { x: start.x + ratio * dx, y: start.y + ratio * dy }
    const candidateDistance = distance(point, closest)
    const candidatePathDistance = traversed + ratio * segmentLength
    if (!best || candidateDistance < best.distance - EPSILON) {
      best = {
        point: closest,
        distance: candidateDistance,
        pathDistance: candidatePathDistance,
        progress: candidatePathDistance / total,
      }
    }
    traversed += segmentLength
  }
  return best
}

/** Keeps original intermediate vertices while slicing a polyline by normalized distance. */
export function slicePath(path: Vec2[], rawStart: number, rawEnd: number): Vec2[] {
  const total = pathLength(path)
  if (path.length < 2 || total <= EPSILON) return path.map((point) => ({ ...point }))
  const startProgress = clamp(rawStart, 0, 1)
  const endProgress = clamp(rawEnd, startProgress, 1)
  const startDistance = startProgress * total
  const endDistance = endProgress * total
  const result = [pointAlongPath(path, startProgress)]
  let traversed = 0
  for (let index = 1; index < path.length; index += 1) {
    const segmentStart = path[index - 1]
    const segmentEnd = path[index]
    if (!segmentStart || !segmentEnd) continue
    traversed += distance(segmentStart, segmentEnd)
    if (traversed > startDistance + EPSILON && traversed < endDistance - EPSILON) {
      result.push({ ...segmentEnd })
    }
  }
  result.push(pointAlongPath(path, endProgress))
  return result
}

export function pathIntersectsCircle(path: Vec2[], center: Vec2, radius: number): boolean {
  if (path.length === 1) return distance(path[0] ?? center, center) <= radius
  return path.slice(1).some((end, index) => {
    const start = path[index]
    return start ? distanceToSegment(center, start, end) <= radius : false
  })
}

export function goalCenter(teamAttacking: 'blue' | 'red', fieldWidth: number, fieldHeight: number): Vec2 {
  return { x: teamAttacking === 'blue' ? fieldWidth : 0, y: fieldHeight / 2 }
}

export type ShootZone = 'inner' | 'outer' | 'outside'

export function getShootZone(
  position: Vec2,
  team: 'blue' | 'red',
  width: number,
  height: number,
  smallRadius: number,
  largeRadius: number,
): ShootZone {
  const goal = goalCenter(team, width, height)
  const range = distance(position, goal)
  if (range <= smallRadius) return 'inner'
  if (range <= largeRadius) return 'outer'
  return 'outside'
}

export function normalizeAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  return ((degrees % 360) + 360) % 360
}

export function directionAngle(from: Vec2, to: Vec2, fallback = 0): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) <= EPSILON && Math.abs(dy) <= EPSILON) return normalizeAngle(fallback)
  return normalizeAngle(Math.atan2(dy, dx) * (180 / Math.PI))
}

export function isFacingAwayFrom(from: Vec2, target: Vec2, facing: number): boolean {
  const desired = Math.atan2(target.y - from.y, target.x - from.x) * (180 / Math.PI)
  const delta = Math.abs((((normalizeAngle(facing) - normalizeAngle(desired)) + 540) % 360) - 180)
  return delta > 100
}
