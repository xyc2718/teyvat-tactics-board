import type { TacticDocumentV1 } from '../model/types'
import { actionEndTime } from './durations'

const EPSILON = 1e-6

function stableTime(time: number): number {
  return Number(Math.max(0, time).toFixed(6))
}

/** All editable joints. Continuous in-between time is reserved for playback. */
export function timelineJointTimes(document: TacticDocumentV1): number[] {
  const cooldownReadyTimes = document.actions.flatMap((action) => {
    if (action.type !== 'qMove' && action.type !== 'eZone') return []
    const actor = document.initialScene.players.find((player) => player.id === action.actorId)
    if (!actor) return []
    const role = document.rulesSnapshot.roles[actor.role]
    return action.type === 'qMove'
      ? [action.startTime + role.q.cooldown]
      : [action.startTime + (role.e?.cooldown ?? 0)]
  })
  const candidates = [
    0,
    ...document.stepMarkers.map((step) => step.time),
    ...document.actions.flatMap((action) => [action.startTime, actionEndTime(action)]),
    ...cooldownReadyTimes,
  ]
    .filter((time) => Number.isFinite(time) && time >= 0)
    .map(stableTime)
    .sort((left, right) => left - right)

  return candidates.filter((time, index) => index === 0 || Math.abs(time - (candidates[index - 1] ?? time)) > EPSILON)
}

export function nearestTimelineJoint(document: TacticDocumentV1, rawTime: number): number {
  const time = Number.isFinite(rawTime) ? Math.max(0, rawTime) : 0
  const joints = timelineJointTimes(document)
  return joints.reduce((nearest, joint) => (
    Math.abs(joint - time) < Math.abs(nearest - time) ? joint : nearest
  ), joints[0] ?? 0)
}

export function timelineDuration(document: TacticDocumentV1): number {
  return timelineJointTimes(document).at(-1) ?? 0
}
