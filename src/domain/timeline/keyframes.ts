import type { TacticDocumentV1 } from '../model/types'
import { actionEndTime } from './durations'
import { documentFreezeWindows } from './projectFrame'

const EPSILON = 1e-6

function coalesceTimelineJoints(candidates: number[]): number[] {
  const joints: number[] = []
  for (const time of candidates) {
    const previous = joints.at(-1)
    if (
      previous === undefined
      || time - previous > EPSILON
      // Time zero is the protected opening frame and must remain navigable
      // even if an imported action starts within the coalescing tolerance.
      || (previous === 0 && time > 0)
    ) {
      joints.push(time)
      continue
    }

    // Keep the latest authoritative boundary for effectively simultaneous
    // events. Rounding down here can leave a pass infinitesimally in flight at
    // its catch marker, preventing the receiver from passing immediately.
    joints[joints.length - 1] = time
  }
  return joints
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
    ...documentFreezeWindows(document).flatMap((window) => [window.startsAt, window.endsAt]),
  ]
    .filter((time) => Number.isFinite(time) && time >= 0)
    .sort((left, right) => left - right)

  return coalesceTimelineJoints(candidates)
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
