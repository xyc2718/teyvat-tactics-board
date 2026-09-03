import { resolveQPath, resolvedMovePath } from '../domain/geometry/geometry'
import type { PlayerState, TacticAction, TacticDocumentV1, Vec2 } from '../domain/model/types'
import { actionEndTime, movementDuration, qDuration } from '../domain/timeline/durations'
import { resolveMoveKeyframeTime } from '../domain/timeline/playerKeyframes'
import { documentFreezeWindows, projectFrame } from '../domain/timeline/projectFrame'
import { earliestLegalQStart } from '../domain/rules/qCooldown'

const EPSILON = 1e-6

type LocomotionAction = Extract<TacticAction, { type: 'move' | 'qMove' }>
type ActorSequenceAction = LocomotionAction | (Extract<TacticAction, { type: 'wait' }> & { actorId: string })
type FollowSyncAction = Extract<TacticAction, { type: 'move' | 'qMove' }>

function isActorSequenceAction(action: TacticAction, actorId: string): action is ActorSequenceAction {
  return (action.type === 'move' || action.type === 'qMove' || action.type === 'wait')
    && action.actorId === actorId
}

export interface LocomotionPlan {
  startTime: number
  origin: Vec2
  actor: PlayerState
  duration: number
}

export interface FollowLocomotionPlan extends LocomotionPlan {
  targetPlayerId: string
  syncActionId: string
  syncEndTime: number
}

export function findFollowSyncAction(
  document: TacticDocumentV1,
  targetPlayerId: string,
  startTime: number,
  preferredActionId?: string,
): FollowSyncAction | null {
  const candidates = document.actions
    .filter((action): action is FollowSyncAction => (
      (action.type === 'move' || action.type === 'qMove')
      && action.actorId === targetPlayerId
      && action.duration > EPSILON
      && actionEndTime(action) > startTime + EPSILON
    ))
    .sort((left, right) => {
      const leftActive = left.startTime <= startTime + EPSILON ? 0 : 1
      const rightActive = right.startTime <= startTime + EPSILON ? 0 : 1
      return leftActive - rightActive || left.startTime - right.startTime || actionEndTime(left) - actionEndTime(right)
    })
  return candidates.find((action) => action.id === preferredActionId) ?? candidates[0] ?? null
}

export function wouldCreateFollowCycle(
  document: TacticDocumentV1,
  actorId: string,
  syncActionId: string,
): boolean {
  const seen = new Set<string>()
  let current = document.actions.find((action) => action.id === syncActionId)
  while (current?.type === 'move' && current.targetPlayerId && current.syncActionId) {
    if (current.targetPlayerId === actorId || seen.has(current.id)) return true
    seen.add(current.id)
    const nextActionId = current.syncActionId
    current = document.actions.find((action) => action.id === nextActionId)
  }
  return false
}

export function planFollowLocomotion(
  document: TacticDocumentV1,
  actorId: string,
  targetPlayerId: string,
  requestedStart: number,
  preferredActionId?: string,
): FollowLocomotionPlan | null {
  let candidateStart = Math.max(0, requestedStart)
  for (let attempt = 0; attempt < document.actions.length + 3; attempt += 1) {
    const syncAction = findFollowSyncAction(document, targetPlayerId, candidateStart, preferredActionId)
    if (!syncAction || wouldCreateFollowCycle(document, actorId, syncAction.id)) return null
    const syncEndTime = actionEndTime(syncAction)
    const plan = planSimpleLocomotion(
      document,
      actorId,
      candidateStart,
      () => Math.max(0, syncEndTime - candidateStart),
    )
    if (!plan || syncEndTime <= plan.startTime + EPSILON) return null
    if (Math.abs(plan.startTime - candidateStart) > EPSILON) {
      candidateStart = plan.startTime
      continue
    }
    return { ...plan, targetPlayerId, syncActionId: syncAction.id, syncEndTime }
  }
  return null
}

/** Keeps all derived move timings attached to their referenced joints. */
export function syncFollowMoveTimings(document: TacticDocumentV1): void {
  for (let attempt = 0; attempt <= document.actions.length; attempt += 1) {
    let timingChanged = false
    for (const action of document.actions) {
      if (action.type !== 'move') continue
      if (action.targetPlayerId && action.syncActionId) {
        const syncAction = document.actions.find(
          (candidate): candidate is FollowSyncAction => (
            candidate.id === action.syncActionId
            && (candidate.type === 'move' || candidate.type === 'qMove')
            && candidate.actorId === action.targetPlayerId
          ),
        )
        if (!syncAction) continue
        const nextDuration = Math.max(0, actionEndTime(syncAction) - action.startTime)
        if (Math.abs(nextDuration - action.duration) > EPSILON) timingChanged = true
        action.duration = nextDuration
        const actor = document.initialScene.players.find((player) => player.id === action.actorId)
        if (actor) action.followGap = document.rulesSnapshot.roles[actor.role].attackRadius
        const projectionDocument: TacticDocumentV1 = {
          ...document,
          actions: document.actions.filter((candidate) => candidate.id !== action.id),
        }
        const projectedActor = projectFrame(projectionDocument, action.startTime).players.find(
          (player) => player.id === action.actorId,
        )
        const projectedTarget = projectFrame(projectionDocument, actionEndTime(syncAction)).players.find(
          (player) => player.id === action.targetPlayerId,
        )
        if (projectedActor && projectedTarget) {
          action.path = [{ ...projectedActor.position }, { ...projectedTarget.position }]
        }
        delete action.curveControl
        delete action.timingConstraint
        continue
      }
      if (action.timingConstraint?.kind !== 'keyframe') continue
      const referencedTime = resolveMoveKeyframeTime(document, action.timingConstraint.reference)
      if (referencedTime === null || referencedTime <= action.startTime + EPSILON) {
        delete action.timingConstraint
        action.duration = movementDuration(resolvedMovePath(action), document.rulesSnapshot)
        timingChanged = true
        continue
      }
      const nextDuration = Math.max(0, referencedTime - action.startTime)
      if (Math.abs(nextDuration - action.duration) > EPSILON) timingChanged = true
      action.duration = nextDuration
    }
    if (!timingChanged) break
  }
}

/** Latest continuation joint, including pass/receive events and a derived thaw boundary. */
export function latestActorSequenceJoint(document: TacticDocumentV1, actorId: string): number {
  const latestActionJoint = document.actions.reduce((latest, action) => (
    isActorSequenceAction(action, actorId)
      ? Math.max(latest, actionEndTime(action))
      : action.type === 'pass' && action.actorId === actorId
        ? Math.max(latest, action.startTime)
        : action.type === 'receive' && action.actorId === actorId
          ? Math.max(latest, action.startTime)
      : latest
  ), 0)
  return documentFreezeWindows(document, actorId).reduce(
    (latest, window) => Math.max(latest, window.endsAt),
    latestActionJoint,
  )
}

/**
 * Finds the first interval at or after requestedStart that does not collide
 * with this player's authored locomotion or derived freeze windows. Instant Q
 * actions occupy their timestamp for ordering, but add no artificial rule time.
 */
export function planSimpleLocomotion(
  document: TacticDocumentV1,
  actorId: string,
  requestedStart: number,
  durationAt: (actor: PlayerState, startTime: number) => number,
  normalizeStart: (candidate: number) => number = (candidate) => candidate,
): LocomotionPlan | null {
  const locomotion = document.actions
    .filter((action): action is ActorSequenceAction => isActorSequenceAction(action, actorId))
    .sort((left, right) => left.startTime - right.startTime || actionEndTime(left) - actionEndTime(right))
  const freezeWindows = documentFreezeWindows(document, actorId)

  let startTime = Math.max(0, requestedStart)
  for (let attempt = 0; attempt <= document.actions.length * 2 + freezeWindows.length * 2 + 3; attempt += 1) {
    startTime = Math.max(startTime, normalizeStart(startTime))
    const actor = projectFrame(document, startTime).players.find((player) => player.id === actorId)
    if (!actor) return null
    const duration = Math.max(0, durationAt(actor, startTime))
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

    if (conflict) {
      startTime = conflict.duration <= EPSILON ? conflict.startTime : actionEndTime(conflict)
      continue
    }

    const freezeConflict = freezeWindows.find((window) => {
      if (duration <= EPSILON) {
        return window.startsAt <= startTime + EPSILON && window.endsAt > startTime + EPSILON
      }
      return startTime < window.endsAt - EPSILON && window.startsAt < proposedEnd - EPSILON
    })
    if (freezeConflict) {
      startTime = freezeConflict.endsAt
      continue
    }

    return {
      startTime,
      origin: { ...actor.position },
      actor,
      duration,
    }
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

export function planSimpleWait(
  document: TacticDocumentV1,
  actorId: string,
  requestedStart: number,
  duration: number,
): LocomotionPlan | null {
  return planSimpleLocomotion(document, actorId, requestedStart, () => Math.max(0, duration))
}

/**
 * Restores the simple-mode invariant after a role or rule edit changes a
 * locomotion duration. Authored endpoints/control points stay intact while
 * starts and projected origins are moved forward only when required.
 */
export function reflowSimpleLocomotion(
  document: TacticDocumentV1,
  actorId: string,
  reflowedActors: Set<string> = new Set(),
): void {
  if (!actorId || reflowedActors.has(actorId)) return
  reflowedActors.add(actorId)
  const entries = document.actions
    .map((action, index) => ({ action, index }))
    .filter(
      (entry): entry is { action: ActorSequenceAction; index: number } =>
        isActorSequenceAction(entry.action, actorId),
    )
    .sort((left, right) => left.action.startTime - right.action.startTime || left.index - right.index)
  const nonLocomotion = document.actions.filter(
    (action) => !isActorSequenceAction(action, actorId),
  )
  const scheduled: ActorSequenceAction[] = []
  let chainEnd: number | null = null

  for (const { action } of entries) {
    const requestedStart = chainEnd ?? action.startTime
    const planningDocument: TacticDocumentV1 = {
      ...document,
      actions: [...nonLocomotion, ...scheduled],
    }

    if (action.type === 'wait') {
      const plan = planSimpleWait(planningDocument, actorId, requestedStart, action.duration)
      if (!plan) continue
      action.startTime = plan.startTime
      action.duration = Math.max(0, action.duration)
      scheduled.push(action)
      chainEnd = actionEndTime(action)
      continue
    }

    if (action.type === 'move' && action.targetPlayerId && action.syncActionId) {
      const plan = planFollowLocomotion(
        planningDocument,
        actorId,
        action.targetPlayerId,
        requestedStart,
        action.syncActionId,
      )
      if (!plan) continue
      const target = projectFrame(planningDocument, plan.syncEndTime).players.find(
        (player) => player.id === action.targetPlayerId,
      )
      if (!target) continue
      action.path = [{ ...plan.origin }, { ...target.position }]
      action.startTime = plan.startTime
      action.duration = plan.syncEndTime - plan.startTime
      action.syncActionId = plan.syncActionId
      action.followGap = document.rulesSnapshot.roles[plan.actor.role].attackRadius
      delete action.curveControl
      scheduled.push(action)
      chainEnd = actionEndTime(action)
      continue
    }

    const tail = action.path.slice(1).map((point) => ({ ...point }))
    if (tail.length === 0) continue
    const referencedTime = action.type === 'move' && action.timingConstraint?.kind === 'keyframe'
      ? resolveMoveKeyframeTime(document, action.timingConstraint.reference)
      : null
    const authoredDuration = action.duration
    const plan = action.type === 'qMove'
      ? planSimpleQ(planningDocument, actorId, requestedStart)
      : planSimpleLocomotion(
          planningDocument,
          actorId,
          requestedStart,
          (scheduledActor, plannedStart) => action.timingConstraint?.kind === 'fixed'
            ? authoredDuration
            : action.timingConstraint?.kind === 'keyframe' && referencedTime !== null
              ? Math.max(0, referencedTime - plannedStart)
              : movementDuration(
                  resolvedMovePath({ ...action, path: [{ ...scheduledActor.position }, ...tail] }),
                  document.rulesSnapshot,
                ),
        )
    if (!plan) continue

    let path = [{ ...plan.origin }, ...tail]
    if (action.type === 'qMove') {
      const q = document.rulesSnapshot.roles[plan.actor.role].q
      path = resolveQPath(
        path,
        q.maxDistance,
        q.fixedDistance,
        document.rulesSnapshot.field.width,
        document.rulesSnapshot.field.height,
      )
    }
    action.path = path
    action.startTime = plan.startTime
    action.duration = action.type === 'move'
      ? action.timingConstraint?.kind === 'fixed'
        ? authoredDuration
        : action.timingConstraint?.kind === 'keyframe' && referencedTime !== null
          ? Math.max(0, referencedTime - plan.startTime)
          : movementDuration(resolvedMovePath(action), document.rulesSnapshot)
      : qDuration(plan.actor, document.rulesSnapshot)
    scheduled.push(action)
    chainEnd = actionEndTime(action)
  }

  const dependents = new Set(document.actions.flatMap((action) => (
    action.type === 'move' && (
      action.targetPlayerId === actorId
      || (action.timingConstraint?.kind === 'keyframe' && action.timingConstraint.reference.playerId === actorId)
    ) ? [action.actorId] : []
  )))
  for (const dependent of dependents) reflowSimpleLocomotion(document, dependent, reflowedActors)
}
