import { compilePath } from '../geometry/compiledPath'
import { clamp, pathLength, resolvedMovePath } from '../geometry/geometry'
import type { MoveAction, Vec2 } from '../model/types'

export interface TimedMoveRateWindow {
  start: number
  end: number
  rate: number
  kind: 'q' | 'receive' | 'slow'
  sourceActionId: string
}

export interface TimedMoveSample { time: number; traveled: number }
export interface TimedMoveTrace {
  path: Vec2[]
  traveled: number
  budgetDistance: number
  windows: TimedMoveRateWindow[]
  samples: TimedMoveSample[]
  intervals: Array<{ startTime: number; endTime: number; startDistance: number; endDistance: number; multiplier: number; slowed: boolean }>
}

export interface TimedMoveContext {
  start: number
  end: number
  baseSpeed: number
  windows: TimedMoveRateWindow[]
  cuts: number[]
  multiplierAt?: (position: Vec2, time: number) => number
}

interface TimedInterval { from: number; to: number; speed: number; slowed: boolean }
// Contexts are immutable synchronous solve sessions, not editable documents.
// Compile effect cuts once across geometry trials: O(E log E + S), not S×E
// on each trial. Weak ownership expires with the operation/projection trace.
const intervalCache = new WeakMap<TimedMoveContext, TimedInterval[]>()

function timedIntervals(context: TimedMoveContext): TimedInterval[] {
  const cached = intervalCache.get(context)
  if (cached) return cached
  const { start, end, windows } = context
  const cuts = new Set([start, Math.max(start, end)])
  for (const time of [...context.cuts, ...windows.flatMap((window) => [window.start, window.end])]) {
    if (time > start && time < end) cuts.add(time)
  }
  if (context.multiplierAt) {
    const count = Math.min(2048, Math.max(1, Math.ceil((end - start) / 0.025)))
    for (let index = 1; index < count; index += 1) cuts.add(start + (end - start) * index / count)
  }
  const times = [...cuts].sort((a, b) => a - b)
  const events = windows.flatMap((window) => [
    { time: window.start, rate: window.rate, slow: Number(window.kind === 'slow') },
    { time: window.end, rate: -window.rate, slow: -Number(window.kind === 'slow') },
  ]).sort((a, b) => a.time - b.time)
  let eventIndex = 0
  let rate = context.baseSpeed
  let slowCount = 0
  const result: TimedInterval[] = []
  for (let index = 1; index < times.length; index += 1) {
    const from = times[index - 1]!
    const to = times[index]!
    while (eventIndex < events.length && events[eventIndex]!.time <= (from + to) / 2) {
      rate += events[eventIndex]!.rate
      slowCount += events[eventIndex]!.slow
      eventIndex += 1
    }
    result.push({ from, to, speed: Math.max(0, rate), slowed: slowCount > 0 })
  }
  intervalCache.set(context, result)
  return result
}

/** Exact event cuts for time-only effects; a bounded action-anchored grid for
 * spatial effects. One full trace is shared by all subsequent time queries. */
export function integrateTimedMove(path: Vec2[], context: TimedMoveContext): TimedMoveTrace {
  const compiled = compilePath(path)
  const { start, windows } = context
  const samples: TimedMoveSample[] = [{ time: start, traveled: 0 }]
  const intervals: TimedMoveTrace['intervals'] = []
  let budgetDistance = 0
  for (const { from, to, speed, slowed } of timedIntervals(context)) {
    const middle = (from + to) / 2
    const budget = speed * (to - from)
    const startDistance = Math.min(compiled.length, budgetDistance)
    const probe = compiled.pointAtDistance(budgetDistance + budget / 2)
    const multiplier = clamp(context.multiplierAt?.(probe, middle) ?? 1, 0, 1)
    budgetDistance += budget * multiplier
    const endDistance = Math.min(compiled.length, budgetDistance)
    samples.push({ time: to, traveled: budgetDistance })
    intervals.push({ startTime: from, endTime: to, startDistance, endDistance, multiplier, slowed })
  }
  return { path: path.map((point) => ({ ...point })), traveled: Math.min(compiled.length, budgetDistance), budgetDistance, windows, samples, intervals }
}

export function timedMoveDistanceAt(trace: TimedMoveTrace, time: number): number {
  if (time <= trace.samples[0]!.time) return 0
  const last = trace.samples.at(-1)!
  if (time >= last.time) return trace.traveled
  let low = 0
  let high = trace.samples.length - 1
  while (high - low > 1) {
    const middle = (low + high) >>> 1
    if (trace.samples[middle]!.time <= time) low = middle
    else high = middle
  }
  const before = trace.samples[low]!
  const after = trace.samples[high]!
  return Math.min(trace.traveled, before.traveled + (after.traveled - before.traveled) * (time - before.time) / (after.time - before.time))
}

export interface TimedMoveGeometry {
  path: Vec2[]
  curveControl?: Vec2
  timingRouteBasis?: { endOffset: Vec2; controlOffset?: Vec2; pathOffsets?: Vec2[] }
}

/** Geometry is compact authored shape; samples are never persisted. */
export function solveTimedMoveGeometry(
  action: MoveAction,
  context: TimedMoveContext,
  field: { width: number; height: number },
): TimedMoveGeometry {
  const origin = action.path[0] ?? { x: 0, y: 0 }
  const end = action.path.at(-1) ?? origin
  const length = pathLength(resolvedMovePath(action))
  const normalizer = Math.max(length, ...action.path.slice(1).map((point) => Math.hypot(point.x - origin.x, point.y - origin.y)),
    action.curveControl ? Math.hypot(action.curveControl.x - origin.x, action.curveControl.y - origin.y) : 0)
  const offset = (point: Vec2): Vec2 => ({ x: (point.x - origin.x) / normalizer, y: (point.y - origin.y) / normalizer })
  const basis = normalizer > 1e-8
    ? { endOffset: offset(end), ...(action.path.length > 2 ? { pathOffsets: action.path.slice(1).map(offset) } : {}),
      ...(action.curveControl ? { controlOffset: offset(action.curveControl) } : {}) }
    : action.timingRouteBasis ?? { endOffset: { x: 1, y: 0 } }
  const geometryAt = (scale: number): TimedMoveGeometry => {
    const point = (delta: Vec2) => ({ x: origin.x + delta.x * scale, y: origin.y + delta.y * scale })
    return { path: [{ ...origin }, ...(basis.pathOffsets ?? [basis.endOffset]).map(point)], ...(basis.controlOffset ? { curveControl: point(basis.controlOffset) } : {}) }
  }
  const unitLength = pathLength(resolvedMovePath({ ...action, ...geometryAt(1) }))
  let maximumScale = Number.POSITIVE_INFINITY
  for (const delta of [...(basis.pathOffsets ?? [basis.endOffset]), ...(basis.controlOffset ? [basis.controlOffset] : [])]) {
    if (delta.x > 1e-10) maximumScale = Math.min(maximumScale, (field.width - origin.x) / delta.x)
    if (delta.x < -1e-10) maximumScale = Math.min(maximumScale, -origin.x / delta.x)
    if (delta.y > 1e-10) maximumScale = Math.min(maximumScale, (field.height - origin.y) / delta.y)
    if (delta.y < -1e-10) maximumScale = Math.min(maximumScale, -origin.y / delta.y)
  }
  // Ignore spatial reduction to obtain a guaranteed upper distance bound.
  const upperBudget = integrateTimedMove([{ ...origin }, { x: origin.x + 1, y: origin.y }], { ...context, multiplierAt: undefined }).budgetDistance
  let upper = Math.max(0, Math.min(maximumScale, upperBudget / Math.max(unitLength, 1e-8)))
  let lower = 0
  if (context.multiplierAt && upper > 1e-8) {
    const upperGeometry = geometryAt(upper)
    const upperTrace = integrateTimedMove(resolvedMovePath({ ...action, ...upperGeometry }), context)
    if (upperTrace.budgetDistance + 1e-7 < upper * unitLength) {
      // Fixed, bounded bisection: sampled zone crossings need not converge by
      // naive repeated scaling. Keep the reachable side of the bracket.
      for (let iteration = 0; iteration < 26 && (upper - lower) * unitLength > 2e-7; iteration += 1) {
        const middle = (lower + upper) / 2
        const geometry = geometryAt(middle)
        const trace = integrateTimedMove(resolvedMovePath({ ...action, ...geometry }), context)
        if (trace.budgetDistance >= middle * unitLength) lower = middle
        else upper = middle
      }
      upper = lower
    }
  }
  const result = geometryAt(upper)
  for (const point of [...result.path, ...(result.curveControl ? [result.curveControl] : [])]) {
    point.x = clamp(point.x, 0, field.width)
    point.y = clamp(point.y, 0, field.height)
  }
  if (upper * unitLength <= 1e-8) result.timingRouteBasis = basis
  return result
}
