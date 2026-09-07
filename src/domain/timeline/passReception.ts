import { distance } from '../geometry/geometry'
import { MAX_PASS_PATH_POINTS } from '../model/passFlight'
import type { PassAction, TacticDocumentV1, Vec2 } from '../model/types'
import { actionEndTime, passDuration, passMaxDuration, passTravelDistance } from './durations'
import { createPlayerPositionReader, documentFreezeWindows, projectFrameAtKeyframe } from './projectFrame'
import { ballCausalRanks } from './ballCausalOrder'

const SOLVER_SAMPLES = 256
const CONTACT_ITERATIONS = 32
const DISTANCE_EPSILON = 1e-9
const EVENT_TIME_EPSILON = 1e-9

export interface PassReceptionResolution {
  path: Vec2[]
  duration: number
  arrivalTime: number
  received: boolean
  receiverPosition?: Vec2
}

function withoutFuturePassEffects(document: TacticDocumentV1, pass: PassAction): TacticDocumentV1 {
  const ranks = ballCausalRanks(document.actions)
  const passIndex = document.actions.findIndex((action) => action.id === pass.id)
  const excludedIds = new Set(document.actions.flatMap((action, index) => (
    action.type === 'pass' && (
      action.id === pass.id
      || action.startTime > pass.startTime
      || (action.startTime === pass.startTime && ((ranks.get(action.id) ?? 0) > (ranks.get(pass.id) ?? 0)
        || (ranks.get(action.id) ?? 0) === (ranks.get(pass.id) ?? 0) && (passIndex < 0 || index > passIndex)))
    ) ? [action.id] : []
  )))
  excludedIds.add(pass.id)
  let changed = true
  while (changed) {
    changed = false
    for (const action of document.actions) {
      const parent = action.type === 'pass' || action.type === 'loosePass'
        ? action.originReception?.sourceActionId ?? action.originPickupActionId
        : action.type === 'receive' ? action.sourceActionId ?? action.pickupActionId
          : action.type === 'move' || action.type === 'qMove' ? action.ballTarget?.sourceActionId : undefined
      if (parent && excludedIds.has(parent) && !excludedIds.has(action.id)) {
        excludedIds.add(action.id)
        changed = true
      }
    }
  }
  return {
    ...document,
    actions: document.actions.filter((action) => !excludedIds.has(action.id)
      && !(action.type === 'receive' && action.sourceActionId && excludedIds.has(action.sourceActionId))),
  }
}

interface FlightInterval {
  end: number
  jumpAtEnd: boolean
}

/** Keep target jumps exact. Additional smooth-event cuts share a fixed budget
 * with the regular grid, so even the maximum-size imported tactic stays bounded. */
function flightIntervals(document: TacticDocumentV1, playerId: string, start: number, duration: number): FlightInterval[] {
  const jumps = new Set<number>()
  const smooth = new Set<number>()
  const add = (set: Set<number>, time: number) => {
    if (time > start && time <= start + duration) set.add(time - start)
  }
  for (const action of document.actions) {
    // A loose flight never moves a player. Its receipt/pickup has its own
    // boundary; an unrelated outgoing timestamp must not change this solve.
    if (action.type === 'loosePass') continue
    // Authored moves/waits can have detached initial positions too, so their
    // starts receive the same left/right treatment as instantaneous Q.
    if ((action.type === 'move' || action.type === 'qMove' || action.type === 'wait') && action.actorId === playerId) {
      add(jumps, action.startTime)
    } else add(smooth, action.startTime)
    add(smooth, actionEndTime(action))
  }
  for (const window of documentFreezeWindows(document, playerId)) {
    add(jumps, window.startsAt)
    add(smooth, window.endsAt)
  }
  for (let sample = 1; sample < SOLVER_SAMPLES; sample += 1) smooth.add(duration * sample / SOLVER_SAMPLES)
  for (const time of jumps) smooth.delete(time)
  smooth.delete(duration)

  const remaining = Math.max(0, MAX_PASS_PATH_POINTS - 2 - jumps.size)
  const candidates = [...smooth].sort((left, right) => left - right)
  const selected = candidates.length <= remaining
    ? candidates
    : Array.from({ length: remaining }, (_, index) => candidates[Math.floor(index * candidates.length / remaining)]!)
  return [...new Set([...jumps, ...selected, duration])]
    .sort((left, right) => left - right)
    .map((end) => ({ end, jumpAtEnd: jumps.has(end) }))
}

function advance(origin: Vec2, target: Vec2, length: number): Vec2 {
  const range = distance(origin, target)
  if (range <= DISTANCE_EPSILON) return { ...origin }
  return {
    x: origin.x + (target.x - origin.x) * length / range,
    y: origin.y + (target.y - origin.y) * length / range,
  }
}

function interpolate(start: Vec2, end: Vec2, progress: number): Vec2 {
  return { x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress }
}

/** Lossless for straight sections; turns/reversals remain explicit. Reducing
 * stationary and collinear passes to two vertices also keeps their legacy
 * serialization compact without applying a visual simplification tolerance. */
function compactStraightSections(path: Vec2[]): Vec2[] {
  const result: Vec2[] = []
  for (const point of path) {
    const before = result.at(-2)
    const last = result.at(-1)
    if (before && last) {
      const a = { x: last.x - before.x, y: last.y - before.y }
      const b = { x: point.x - last.x, y: point.y - last.y }
      const scale = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)
      if (a.x * b.x + a.y * b.y >= 0 && Math.abs(a.x * b.y - a.y * b.x) <= 1e-12 * scale) result.pop()
    }
    result.push({ ...point })
  }
  return result
}

/**
 * Find contact only within the current integration interval. Away from contact
 * the ball uses midpoint pursuit (current relative heading), never a future
 * destination. The final subinterval is refined against the real target, not a
 * gameplay catch radius or a snap to an out-of-range endpoint.
 */
function contactInInterval(
  ball: Vec2,
  start: number,
  end: number,
  targetStart: Vec2,
  targetEnd: Vec2,
  targetAt: (elapsed: number) => Vec2,
  traveledAt: (elapsed: number) => number,
): { elapsed: number; target: Vec2 } | null {
  const alreadyTraveled = traveledAt(start)
  const gap = (elapsed: number, target: Vec2) => distance(ball, target) - (traveledAt(elapsed) - alreadyTraveled)
  if (distance(ball, targetStart) <= DISTANCE_EPSILON) return { elapsed: start, target: targetStart }

  let high = end
  if (gap(end, targetEnd) > DISTANCE_EPSILON) {
    // For a linear target segment, |r+vt| minus the concave distance curve is
    // convex. Its minimum detects a target crossing and leaving the ball's
    // local reach within one step, including a late slower-ball encounter.
    const interval = end - start
    const middleDistance = traveledAt((start + end) / 2)
    const endDistance = traveledAt(end)
    const velocity = { x: (targetEnd.x - targetStart.x) / interval, y: (targetEnd.y - targetStart.y) / interval }
    const initialSpeed = (-3 * alreadyTraveled + 4 * middleDistance - endDistance) / interval
    const finalSpeed = (alreadyTraveled - 4 * middleDistance + 3 * endDistance) / interval
    const derivative = (progress: number) => {
      const target = interpolate(targetStart, targetEnd, progress)
      const range = distance(ball, target)
      const targetRadialSpeed = range <= DISTANCE_EPSILON ? 0
        : ((target.x - ball.x) * velocity.x + (target.y - ball.y) * velocity.y) / range
      return targetRadialSpeed - (initialSpeed + (finalSpeed - initialSpeed) * progress)
    }
    // The usual case (ball faster than the runner) needs no inner search and
    // no additional receiver projection; the smallest gap is at the end.
    if (derivative(1) <= 0 || derivative(0) >= 0) return null
    let left = 0
    let right = 1
    for (let index = 0; index < 20; index += 1) {
      const middle = (left + right) / 2
      if (derivative(middle) < 0) left = middle
      else right = middle
    }
    high = start + (end - start) * (left + right) / 2
    if (gap(high, targetAt(high)) > DISTANCE_EPSILON) return null
  }

  let low = start
  for (let iteration = 0; iteration < CONTACT_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2
    if (gap(middle, targetAt(middle)) > 0) low = middle
    else high = middle
  }
  const target = targetAt(high)
  return Math.abs(gap(high, target)) <= DISTANCE_EPSILON * 4 ? { elapsed: high, target } : null
}

/**
 * Deterministic homing integration performed at document normalization only.
 * Every step consumes its exact scalar distance increment, preserving the
 * cumulative range limit even when the receiver turns or teleports. Excluding
 * this and later pass/receive effects prevents a catch boost from changing its
 * own cause; earlier independent receptions and all authored movement remain.
 */
export function solvePassReception(document: TacticDocumentV1, pass: PassAction): PassReceptionResolution {
  const projectionDocument = withoutFuturePassEffects(document, pass)
  const startFrame = projectFrameAtKeyframe(projectionDocument, pass.startTime, pass.originKeyframe ?? null)
  const origin = startFrame.players.find((player) => player.id === pass.actorId)?.position ?? pass.path[0]
  if (!origin || !pass.targetPlayerId) {
    const path = origin
      ? [{ ...origin }, ...pass.path.slice(1).map((point) => ({ ...point }))]
      : pass.path.map((point) => ({ ...point }))
    const duration = passDuration(path, document.rulesSnapshot)
    return { path, duration, arrivalTime: pass.startTime + duration, received: false }
  }

  const readPosition = createPlayerPositionReader(projectionDocument, pass.targetPlayerId)
  const maxDuration = passMaxDuration(document.rulesSnapshot)
  const initialTarget = readPosition(pass.startTime) ?? pass.path.at(-1) ?? origin
  const targetAt = (elapsed: number) => readPosition(pass.startTime + elapsed) ?? initialTarget
  const traveledAt = (elapsed: number) => passTravelDistance(elapsed, document.rulesSnapshot)
  const path: Vec2[] = [{ ...origin }]
  let ball = { ...origin }
  let elapsed = 0
  let currentTarget = initialTarget

  const caught = (contact: { elapsed: number; target: Vec2 }): PassReceptionResolution => ({
    path: compactStraightSections([...path, contact.target]),
    duration: contact.elapsed,
    arrivalTime: pass.startTime + contact.elapsed,
    received: true,
    receiverPosition: { ...contact.target },
  })

  for (const interval of flightIntervals(projectionDocument, pass.targetPlayerId, pass.startTime, maxDuration)) {
    // Read the left limit to avoid dragging the receiver through a Q jump.
    // This query offset is numerical only and never stored as gameplay time.
    const leftLimit = interval.jumpAtEnd
      ? Math.max(elapsed, interval.end - Math.min(EVENT_TIME_EPSILON, (interval.end - elapsed) / 2))
      : interval.end
    const nextTarget = targetAt(leftLimit)
    const withinInterval = (time: number) => time >= leftLimit ? nextTarget : targetAt(time)
    const contact = contactInInterval(ball, elapsed, interval.end, currentTarget, nextTarget, withinInterval, traveledAt)
    if (contact && (!interval.jumpAtEnd || contact.elapsed < leftLimit)) return caught(contact)

    const midpoint = (elapsed + interval.end) / 2
    const midpointBall = advance(ball, currentTarget, traveledAt(midpoint) - traveledAt(elapsed))
    const midpointTarget = withinInterval(midpoint)
    const headingTarget = {
      x: ball.x + midpointTarget.x - midpointBall.x,
      y: ball.y + midpointTarget.y - midpointBall.y,
    }
    ball = advance(ball, headingTarget, traveledAt(interval.end) - traveledAt(elapsed))
    path.push({ ...ball })
    elapsed = interval.end
    currentTarget = interval.jumpAtEnd ? targetAt(elapsed) : nextTarget
    if (distance(ball, currentTarget) <= DISTANCE_EPSILON) {
      // Landing on the ball is a catch; passing through it during a jump is not.
      return { path: compactStraightSections(path), duration: elapsed, arrivalTime: pass.startTime + elapsed, received: true, receiverPosition: { ...currentTarget } }
    }
  }

  return {
    path: compactStraightSections(path),
    duration: maxDuration,
    arrivalTime: pass.startTime + maxDuration,
    received: false,
    receiverPosition: { ...currentTarget },
  }
}
