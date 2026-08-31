import { truncatePath } from '../domain/geometry/geometry'
import type { PlayerState, TacticAction, TacticDocumentV1, Vec2 } from '../domain/model/types'
import { actionEndTime, movementDuration, qDuration } from '../domain/timeline/durations'
import { projectFrame } from '../domain/timeline/projectFrame'
import { earliestLegalQStart } from '../domain/rules/qCooldown'

const EPSILON = 1e-6

type LocomotionAction = Extract<TacticAction, { type: 'move' | 'qMove' }>

export interface LocomotionPlan {
  startTime: number
  origin: Vec2
  actor: PlayerState
  duration: number
}

/**
 * Finds the first interval at or after requestedStart that does not collide
 * with this player's authored locomotion. Instant Q actions occupy their
 * timestamp for ordering, but add no artificial rule time.
 */
export function planSimpleLocomotion(
  document: TacticDocumentV1,
  actorId: string,
  requestedStart: number,
  durationAt: (actor: PlayerState) => number,
  normalizeStart: (candidate: number) => number = (candidate) => candidate,
): LocomotionPlan | null {
  const locomotion = document.actions
    .filter(
      (action): action is LocomotionAction =>
        (action.type === 'move' || action.type === 'qMove') && action.actorId === actorId,
    )
    .sort((left, right) => left.startTime - right.startTime || actionEndTime(left) - actionEndTime(right))

  let startTime = Math.max(0, requestedStart)
  for (let attempt = 0; attempt <= document.actions.length * 2 + 3; attempt += 1) {
    startTime = Math.max(startTime, normalizeStart(startTime))
    const actor = projectFrame(document, startTime).players.find((player) => player.id === actorId)
    if (!actor) return null
    const duration = Math.max(0, durationAt(actor))
    const proposedEnd = startTime + duration
    const conflict = locomotion.find((action) => {
      const existingEnd = actionEndTime(action)
      if (duration <= EPSILON) {
        return action.duration > EPSILON
          && action.startTime <= startTime + EPSILON
          && existingEnd > startTime + EPSILON
      }
      if (action.duration <= EPSILON) {
        return action.startTime > startTime + EPSILON && action.startTime < proposedEnd - EPSILON
      }
      return startTime < existingEnd - EPSILON && action.startTime < proposedEnd - EPSILON
    })

    if (!conflict) {
      return {
        startTime,
        origin: { ...actor.position },
        actor,
        duration,
      }
    }

    startTime = conflict.duration <= EPSILON ? conflict.startTime : actionEndTime(conflict)
  }

  return null
}

export function planSimpleQ(
  document: TacticDocumentV1,
  actorId: string,
  requestedStart: number,
): LocomotionPlan | null {
  return planSimpleLocomotion(
    document,
    actorId,
    requestedStart,
    (actor) => qDuration(actor, document.rulesSnapshot),
    (candidate) => earliestLegalQStart(document, actorId, candidate),
  )
}

/**
 * Restores the simple-mode invariant after a role or rule edit changes a
 * locomotion duration. Authored endpoints/control points stay intact while
 * starts and projected origins are moved forward only when required.
 */
export function reflowSimpleLocomotion(document: TacticDocumentV1, actorId: string): void {
  const entries = document.actions
    .map((action, index) => ({ action, index }))
    .filter(
      (entry): entry is { action: LocomotionAction; index: number } =>
        (entry.action.type === 'move' || entry.action.type === 'qMove')
        && entry.action.actorId === actorId,
    )
    .sort((left, right) => left.action.startTime - right.action.startTime || left.index - right.index)
  const nonLocomotion = document.actions.filter(
    (action) => !((action.type === 'move' || action.type === 'qMove') && action.actorId === actorId),
  )
  const scheduled: LocomotionAction[] = []

  for (const { action } of entries) {
    const tail = action.path.slice(1).map((point) => ({ ...point }))
    if (tail.length === 0) continue
    const planningDocument: TacticDocumentV1 = {
      ...document,
      actions: [...nonLocomotion, ...scheduled],
    }
    const plan = action.type === 'qMove'
      ? planSimpleQ(planningDocument, actorId, action.startTime)
      : planSimpleLocomotion(
          planningDocument,
          actorId,
          action.startTime,
          (scheduledActor) => movementDuration([{ ...scheduledActor.position }, ...tail], document.rulesSnapshot),
        )
    if (!plan) continue

    let path = [{ ...plan.origin }, ...tail]
    if (action.type === 'qMove') {
      path = truncatePath(path, document.rulesSnapshot.roles[plan.actor.role].q.maxDistance)
    }
    action.path = path
    action.startTime = plan.startTime
    action.duration = action.type === 'move'
      ? movementDuration(path, document.rulesSnapshot)
      : qDuration(plan.actor, document.rulesSnapshot)
    scheduled.push(action)
  }
}
