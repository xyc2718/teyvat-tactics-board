import { clamp, pathLength, resolvedMovePath, slicePath } from '../geometry/geometry'
import type { MoveAction, QMoveAction, TacticDocumentV1, Vec2 } from '../model/types'
import { actionEndTime } from './durations'

export interface WaterQMoveBoost {
  sourceActionId: string
  overlapStart: number
  overlapEnd: number
  separationGain: number
  startProgress: number
  endProgress: number
  path: Vec2[]
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
  const overlapStart = Math.max(move.startTime, boostStart)
  const overlapEnd = Math.min(moveEnd, boostStart + rule.duration)
  if (overlapEnd <= overlapStart) return null
  const route = resolvedMovePath(move)
  const routeLength = pathLength(route)
  if (routeLength <= 0) return null
  const separationGain = ((overlapEnd - overlapStart) / rule.duration) * rule.netSeparationGain
  const startProgress = clamp((overlapStart - move.startTime) / move.duration, 0, 1)
  const baseEndProgress = clamp((overlapEnd - move.startTime) / move.duration, 0, 1)
  const endProgress = clamp(baseEndProgress + separationGain / routeLength, startProgress, 1)
  return {
    sourceActionId: source.id,
    overlapStart,
    overlapEnd,
    separationGain,
    startProgress,
    endProgress,
    path: slicePath(route, startProgress, endProgress),
  }
}

export function waterQGainAtTime(effect: WaterQMoveBoost | null, ruleDuration: number, time: number): number {
  if (!effect || ruleDuration <= 0 || time <= effect.overlapStart) return 0
  const elapsed = Math.max(0, Math.min(time, effect.overlapEnd) - effect.overlapStart)
  const overlapDuration = effect.overlapEnd - effect.overlapStart
  return overlapDuration <= 0 ? 0 : effect.separationGain * (elapsed / overlapDuration)
}
