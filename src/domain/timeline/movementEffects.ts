import { clamp, pathLength, resolvedMovePath, slicePath } from '../geometry/geometry'
import type { MoveAction, PassAction, QMoveAction, ReceiveAction, RoleRule, TacticDocumentV1, Vec2 } from '../model/types'
import { actionEndTime } from './durations'
import { passIsReceived } from '../model/passFlight'
import { ballActionIsEffective, ballPossessionHistory } from './ballPossession'

export interface MoveBoostEffect {
  sourceActionId: string
  overlapStart: number
  overlapEnd: number
  separationGain: number
  startProgress: number
  endProgress: number
  path: Vec2[]
}

export type WaterQMoveBoost = MoveBoostEffect
export type ReceiveMoveBoost = MoveBoostEffect

type ReceiveBoostRule = NonNullable<RoleRule['receiveBoost']>

export interface ReceiveBoostWindow {
  sourceActionId: string
  start: number
  end: number
  boost: ReceiveBoostRule
}

/** Chronological, refreshed Q boost windows for physical timed movement and
 * event identity. An overlapping later Q replaces only the remaining window. */
export function movementQBoostWindowsFor(
  document: TacticDocumentV1, playerId: string, start: number, end: number,
): Array<Omit<ReceiveBoostWindow, 'boost'> & { boost: NonNullable<RoleRule['afterQBoost']> }> {
  const role = getActorRole(document, playerId)
  const boost = role ? document.rulesSnapshot.roles[role].afterQBoost : undefined
  if (!boost || boost.duration <= 0) return []
  const sources = document.actions.filter((action): action is QMoveAction => action.type === 'qMove'
    && action.actorId === playerId && actionEndTime(action) < end && actionEndTime(action) + boost.duration > start)
    .sort((a, b) => actionEndTime(a) - actionEndTime(b))
  return sources.map((source, index) => ({ sourceActionId: source.id, start: actionEndTime(source),
    end: Math.min(actionEndTime(source) + boost.duration, sources[index + 1] ? actionEndTime(sources[index + 1]!) : Number.POSITIVE_INFINITY), boost }))
    .filter((window) => window.end > Math.max(start, window.start))
}

function getActorRole(document: TacticDocumentV1, actorId: string) {
  return document.initialScene.players.find((player) => player.id === actorId)?.role
}

export function receiveBoostWindowFor(
  document: TacticDocumentV1,
  playerId: string,
  time: number,
  seen: ReadonlySet<string> = new Set(),
): ReceiveBoostWindow | undefined {
  const role = getActorRole(document, playerId)
  const boost = role ? document.rulesSnapshot.roles[role].receiveBoost : undefined
  if (!boost || boost.duration <= 0) return undefined
  const invalid = ballPossessionHistory(document).invalidActionIds
  const source = [...document.actions]
    .filter(
      (candidate): candidate is PassAction =>
        candidate.type === 'pass' &&
        !invalid.has(candidate.id) &&
        candidate.targetPlayerId === playerId &&
        passIsReceived(candidate, document.rulesSnapshot) &&
        actionEndTime(candidate) <= time &&
        actionEndTime(candidate) + boost.duration > time,
    )
    .sort((left, right) => actionEndTime(right) - actionEndTime(left))[0]
  const normal = source
    ? { sourceActionId: source.id, start: actionEndTime(source), end: actionEndTime(source) + boost.duration, boost }
    : undefined
  const pickup = document.actions.filter((action): action is ReceiveAction => action.type === 'receive'
    && !!action.pickupActionId && action.actorId === playerId && action.startTime <= time
    && action.startTime + boost.duration > time && !seen.has(action.id))
    .sort((a, b) => b.startTime - a.startTime)
    .find((action) => pickupReceiveBoost(document, action, seen))
  return pickup && (!normal || pickup.startTime > normal.start)
    ? { sourceActionId: pickup.id, start: pickup.startTime, end: pickup.startTime + boost.duration, boost }
    : normal
}

/** Eligibility is recomputed from launch history; ground waiting never expires the mark. */
export function looseBallBoostSource(document: TacticDocumentV1, sourceActionId: string | null, seen: ReadonlySet<string> = new Set()): string | undefined {
  const source = document.actions.find((action) => action.id === sourceActionId)
  if (source?.type !== 'loosePass' || seen.has(source.id) || !ballActionIsEffective(document, source.id)) return undefined
  const actor = document.initialScene.players.find((player) => player.id === source.actorId)
  if (actor?.role !== 'ice' || !document.rulesSnapshot.roles.ice.receiveBoost?.transfersOnPass) return undefined
  return receiveBoostWindowFor(document, actor.id, source.startTime, new Set([...seen, source.id])) ? source.id : undefined
}

export function pickupReceiveBoost(document: TacticDocumentV1, receive: ReceiveAction, seen: ReadonlySet<string> = new Set()): ReceiveBoostRule | undefined {
  if (!receive.pickupActionId || receive.ballSourceActionId == null || seen.has(receive.id)
    || !ballActionIsEffective(document, receive.id)) return undefined
  const source = document.actions.find((action) => action.id === receive.ballSourceActionId)
  if (source?.type !== 'loosePass') return undefined
  const passer = document.initialScene.players.find((player) => player.id === source.actorId)
  const receiver = document.initialScene.players.find((player) => player.id === receive.actorId)
  if (passer?.team !== receiver?.team) return undefined
  return looseBallBoostSource(document, source.id, new Set([...seen, receive.id])) ? document.rulesSnapshot.roles.ice.receiveBoost : undefined
}

/** Preserve already-earned movement when a new reception refreshes the boost.
 * Each newer qualifying catch replaces only the remaining active interval. */
export function movementReceiveBoostWindowsFor(
  document: TacticDocumentV1,
  playerId: string,
  actionStart: number,
  time: number,
): ReceiveBoostWindow[] {
  const receiverRole = getActorRole(document, playerId)
  const ownBoost = receiverRole ? document.rulesSnapshot.roles[receiverRole].receiveBoost : undefined
  const windows: ReceiveBoostWindow[] = []
  const invalid = ballPossessionHistory(document).invalidActionIds
  for (const source of [...document.actions]
    .filter(
      (candidate): candidate is PassAction =>
        candidate.type === 'pass' &&
        !invalid.has(candidate.id) &&
        candidate.targetPlayerId === playerId &&
        passIsReceived(candidate, document.rulesSnapshot) &&
        actionEndTime(candidate) <= time,
    )
    .sort((left, right) => actionEndTime(left) - actionEndTime(right))) {
    let boost = ownBoost
    if (!boost) {
      const passerRole = getActorRole(document, source.actorId)
      const passerBoost = passerRole ? document.rulesSnapshot.roles[passerRole].receiveBoost : undefined
      if (passerBoost?.transfersOnPass && receiveBoostWindowFor(document, source.actorId, source.startTime)) {
        boost = passerBoost
      }
    }
    if (boost && boost.duration > 0 && actionEndTime(source) + boost.duration > actionStart) {
      const start = actionEndTime(source)
      // Preserve the existing stable first-source choice at equal catch times.
      if (windows.at(-1)?.start === start) continue
      const previous = windows.at(-1)
      if (previous) previous.end = Math.min(previous.end, start)
      windows.push({
        sourceActionId: source.id,
        start,
        end: start + boost.duration,
        boost,
      })
    }
  }
  for (const receive of document.actions) {
    if (receive.type !== 'receive' || receive.actorId !== playerId || !receive.pickupActionId || receive.startTime > time) continue
    const boost = pickupReceiveBoost(document, receive)
    if (boost && boost.duration > 0 && receive.startTime + boost.duration > actionStart) {
      windows.push({ sourceActionId: receive.id, start: receive.startTime, end: receive.startTime + boost.duration, boost })
    }
  }
  windows.sort((a, b) => a.start - b.start || a.sourceActionId.localeCompare(b.sourceActionId))
  for (let index = 0; index < windows.length - 1; index += 1) windows[index]!.end = Math.min(windows[index]!.end, windows[index + 1]!.start)
  return windows.filter((window) => window.end > Math.max(actionStart, window.start))
}

function buildMoveBoostEffect(
  move: MoveAction,
  sourceActionId: string,
  boostStart: number,
  boostDuration: number,
  netSeparationGain: number,
): MoveBoostEffect | null {
  if (boostDuration <= 0 || move.duration <= 0) return null
  const moveEnd = actionEndTime(move)
  const overlapStart = Math.max(move.startTime, boostStart)
  const overlapEnd = Math.min(moveEnd, boostStart + boostDuration)
  if (overlapEnd <= overlapStart) return null
  const route = resolvedMovePath(move)
  const routeLength = pathLength(route)
  if (routeLength <= 0) return null
  const separationGain = ((overlapEnd - overlapStart) / boostDuration) * netSeparationGain
  const startProgress = clamp((overlapStart - move.startTime) / move.duration, 0, 1)
  const baseEndProgress = clamp((overlapEnd - move.startTime) / move.duration, 0, 1)
  const endProgress = clamp(baseEndProgress + separationGain / routeLength, startProgress, 1)
  return {
    sourceActionId,
    overlapStart,
    overlapEnd,
    separationGain,
    startProgress,
    endProgress,
    path: slicePath(route, startProgress, endProgress),
  }
}

export function waterQMoveBoost(document: TacticDocumentV1, move: MoveAction): WaterQMoveBoost | null {
  const actor = document.initialScene.players.find((player) => player.id === move.actorId)
  const rule = actor?.role === 'water' ? document.rulesSnapshot.roles.water.afterQBoost : undefined
  if (!rule || rule.duration <= 0 || move.duration <= 0) return null
  const moveEnd = actionEndTime(move)
  const source = [...document.actions]
    .filter((candidate): candidate is QMoveAction => {
      if (candidate.type !== 'qMove' || candidate.actorId !== move.actorId) return false
      const boostStart = actionEndTime(candidate)
      return boostStart < moveEnd && boostStart + rule.duration > move.startTime
    })
    .sort((left, right) => actionEndTime(right) - actionEndTime(left))[0]
  if (!source) return null

  const boostStart = actionEndTime(source)
  return buildMoveBoostEffect(move, source.id, boostStart, rule.duration, rule.netSeparationGain)
}

export function receiveMoveBoosts(document: TacticDocumentV1, move: MoveAction): ReceiveMoveBoost[] {
  const windows = movementReceiveBoostWindowsFor(document, move.actorId, move.startTime, actionEndTime(move))
  const route = resolvedMovePath(move)
  const length = pathLength(route)
  if (length <= 0) return []
  let previousGain = 0
  return windows.flatMap((window) => {
    const duration = window.end - window.start
    const effect = buildMoveBoostEffect(
      move,
      window.sourceActionId,
      window.start,
      duration,
      window.boost.netSeparationGain * duration / window.boost.duration,
    )
    if (!effect) return []
    effect.startProgress = clamp(effect.startProgress + previousGain / length, 0, 1)
    effect.endProgress = clamp(effect.endProgress + previousGain / length, effect.startProgress, 1)
    effect.path = slicePath(route, effect.startProgress, effect.endProgress)
    previousGain += effect.separationGain
    return [effect]
  })
}

export function waterQGainAtTime(effect: WaterQMoveBoost | null, ruleDuration: number, time: number): number {
  if (!effect || ruleDuration <= 0 || time <= effect.overlapStart) return 0
  const elapsed = Math.max(0, Math.min(time, effect.overlapEnd) - effect.overlapStart)
  const overlapDuration = effect.overlapEnd - effect.overlapStart
  return overlapDuration <= 0 ? 0 : effect.separationGain * (elapsed / overlapDuration)
}
