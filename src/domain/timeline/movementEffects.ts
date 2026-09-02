import { clamp, pathLength, resolvedMovePath, slicePath } from '../geometry/geometry'
import type { MoveAction, PassAction, QMoveAction, RoleRule, TacticDocumentV1, Vec2 } from '../model/types'
import { actionEndTime } from './durations'

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

function getActorRole(document: TacticDocumentV1, actorId: string) {
  return document.initialScene.players.find((player) => player.id === actorId)?.role
}

export function receiveBoostWindowFor(
  document: TacticDocumentV1,
  playerId: string,
  time: number,
): ReceiveBoostWindow | undefined {
  const role = getActorRole(document, playerId)
  const boost = role ? document.rulesSnapshot.roles[role].receiveBoost : undefined
  if (!boost || boost.duration <= 0) return undefined
  const source = [...document.actions]
    .filter(
      (candidate): candidate is PassAction =>
        candidate.type === 'pass' &&
        candidate.targetPlayerId === playerId &&
        pathLength(candidate.path) <= document.rulesSnapshot.passing.maxDistance &&
        actionEndTime(candidate) <= time &&
        actionEndTime(candidate) + boost.duration > time,
    )
    .sort((left, right) => actionEndTime(right) - actionEndTime(left))[0]
  return source
    ? { sourceActionId: source.id, start: actionEndTime(source), end: actionEndTime(source) + boost.duration, boost }
    : undefined
}

export function movementReceiveBoostWindowFor(
  document: TacticDocumentV1,
  playerId: string,
  actionStart: number,
  time: number,
): ReceiveBoostWindow | undefined {
  const receiverRole = getActorRole(document, playerId)
  const ownBoost = receiverRole ? document.rulesSnapshot.roles[receiverRole].receiveBoost : undefined
  for (const source of [...document.actions]
    .filter(
      (candidate): candidate is PassAction =>
        candidate.type === 'pass' &&
        candidate.targetPlayerId === playerId &&
        pathLength(candidate.path) <= document.rulesSnapshot.passing.maxDistance &&
        actionEndTime(candidate) <= time,
    )
    .sort((left, right) => actionEndTime(right) - actionEndTime(left))) {
    let boost = ownBoost
    if (!boost) {
      const passerRole = getActorRole(document, source.actorId)
      const passerBoost = passerRole ? document.rulesSnapshot.roles[passerRole].receiveBoost : undefined
      if (passerBoost?.transfersOnPass && receiveBoostWindowFor(document, source.actorId, source.startTime)) {
        boost = passerBoost
      }
    }
    if (boost && boost.duration > 0 && actionEndTime(source) + boost.duration > actionStart) {
      return {
        sourceActionId: source.id,
        start: actionEndTime(source),
        end: actionEndTime(source) + boost.duration,
        boost,
      }
    }
  }
  return undefined
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

export function receiveMoveBoost(document: TacticDocumentV1, move: MoveAction): ReceiveMoveBoost | null {
  const window = movementReceiveBoostWindowFor(document, move.actorId, move.startTime, actionEndTime(move))
  if (!window) return null
  return buildMoveBoostEffect(
    move,
    window.sourceActionId,
    window.start,
    window.boost.duration,
    window.boost.netSeparationGain,
  )
}

export function waterQGainAtTime(effect: WaterQMoveBoost | null, ruleDuration: number, time: number): number {
  if (!effect || ruleDuration <= 0 || time <= effect.overlapStart) return 0
  const elapsed = Math.max(0, Math.min(time, effect.overlapEnd) - effect.overlapStart)
  const overlapDuration = effect.overlapEnd - effect.overlapStart
  return overlapDuration <= 0 ? 0 : effect.separationGain * (elapsed / overlapDuration)
}
