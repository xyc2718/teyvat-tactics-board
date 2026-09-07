import { resolveQPath, resolvedMovePath } from '../domain/geometry/geometry'
import type { MoveAction, PlayerState, TacticAction, TacticDocumentV1, Vec2 } from '../domain/model/types'
import { actionEndTime, movementDuration, qDuration } from '../domain/timeline/durations'
import { resolveTimingKeyframe } from '../domain/timeline/timingKeyframes'
import { resolveMoveQCooldownTarget } from '../domain/timeline/moveTiming'
import { documentFreezeWindows, projectFrame, projectPlayerPosition, resolveTimedMoveGeometry } from '../domain/timeline/projectFrame'
import { earliestLegalQStart } from '../domain/rules/qCooldown'

const EPSILON = 1e-6

type LocomotionAction = Extract<TacticAction, { type: 'move' | 'qMove' }>
type ActorSequenceAction = LocomotionAction | (Extract<TacticAction, { type: 'wait' }> & { actorId: string })
type FollowSyncAction = Extract<TacticAction, { type: 'move' | 'qMove' }>

/** Fix the time, not speed: physical geometry and playback share one domain solver. */
export function syncConstrainedMovePath(document: TacticDocumentV1, action: MoveAction): boolean {
  if (!action.timingConstraint || action.targetPlayerId || action.ballTarget) return false
  const geometry = resolveTimedMoveGeometry(document, action)
  const changed = geometry.path.length !== action.path.length || geometry.path.some((point, index) => {
    const previous = action.path[index]
    return !previous || Math.abs(point.x - previous.x) > EPSILON || Math.abs(point.y - previous.y) > EPSILON
  }) || Boolean(geometry.curveControl) !== Boolean(action.curveControl)
    || Boolean(geometry.curveControl && action.curveControl && (
      Math.abs(geometry.curveControl.x - action.curveControl.x) > EPSILON
      || Math.abs(geometry.curveControl.y - action.curveControl.y) > EPSILON
    ))
    || JSON.stringify(geometry.timingRouteBasis) !== JSON.stringify(action.timingRouteBasis)
  if (!changed) return false
  action.path = geometry.path
  if (geometry.curveControl) action.curveControl = geometry.curveControl
  else delete action.curveControl
  if (geometry.timingRouteBasis) action.timingRouteBasis = geometry.timingRouteBasis
  else delete action.timingRouteBasis
  return true
}

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
export function syncFollowMoveTimings(document: TacticDocumentV1): boolean {
  for (let attempt = 0; attempt <= document.actions.length; attempt += 1) {
    let timingChanged = false
    for (const action of document.actions) {
      if (action.type === 'wait' && action.actorId && action.timingConstraint) {
        const event = resolveTimingKeyframe(document, action.timingConstraint.reference)
        if (event && event.time > action.startTime + EPSILON) {
          const duration = event.time - action.startTime
          if (Math.abs(duration - action.duration) > EPSILON) timingChanged = true
          action.duration = duration
        }
        continue
      }
      if (action.type !== 'move' || action.ballTarget) continue
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
      if (action.timingConstraint) {
        const position = projectPlayerPosition({
          ...document,
          actions: document.actions.filter((candidate) => candidate.id !== action.id),
        }, action.actorId, action.startTime)
        const origin = action.path[0]
        if (position && origin) {
          const offset = { x: position.x - origin.x, y: position.y - origin.y }
          if (Math.abs(offset.x) > EPSILON || Math.abs(offset.y) > EPSILON) {
            action.path = action.path.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }))
            if (action.curveControl) action.curveControl = { x: action.curveControl.x + offset.x, y: action.curveControl.y + offset.y }
            timingChanged = true
          }
        }
      }
      if (action.timingConstraint?.kind === 'fixed') {
        if (syncConstrainedMovePath(document, action)) timingChanged = true
        continue
      }
      if (action.timingConstraint?.kind === 'qCooldown') {
        const target = resolveMoveQCooldownTarget(document, action)
        // Reflow may still move source and run; commit finalization owns fallback.
        if (!target) continue
        const nextDuration = target.readyTime - action.startTime
        if (Math.abs(nextDuration - action.duration) > EPSILON) timingChanged = true
        action.duration = nextDuration
        if (syncConstrainedMovePath(document, action)) timingChanged = true
        continue
      }
      if (action.timingConstraint?.kind !== 'keyframe') continue
      const referencedTime = resolveTimingKeyframe(document, action.timingConstraint.reference)?.time ?? null
      if (referencedTime === null || referencedTime <= action.startTime + EPSILON) {
        // Source/chain reflow may be temporarily incomplete; commit-time finalization owns fallback.
        continue
      }
      const nextDuration = Math.max(0, referencedTime - action.startTime)
      if (Math.abs(nextDuration - action.duration) > EPSILON) timingChanged = true
      action.duration = nextDuration
      if (syncConstrainedMovePath(document, action)) timingChanged = true
    }
    if (!timingChanged) return true
  }
  return false
}

/** Latest continuation joint, including pass/receive events and a derived thaw boundary. */
export function latestActorSequenceJoint(document: TacticDocumentV1, actorId: string): number {
  const latestActionJoint = document.actions.reduce((latest, action) => (
    isActorSequenceAction(action, actorId)
      ? Math.max(latest, actionEndTime(action))
      : (action.type === 'pass' || action.type === 'loosePass') && action.actorId === actorId
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
  anchorActionId?: string,
  previousActions?: TacticAction[],
): void {
  if (!actorId || reflowedActors.has(actorId)) return
  reflowedActors.add(actorId)
  const previousTimes = new Map(previousActions?.map((action) => [action.id, action.startTime]))
  const entries = document.actions
    .map((action, index) => ({ action, index }))
    .filter(
      (entry): entry is { action: ActorSequenceAction; index: number } =>
        isActorSequenceAction(entry.action, actorId),
    )
    .sort((left, right) => (previousTimes.get(left.action.id) ?? left.action.startTime)
      - (previousTimes.get(right.action.id) ?? right.action.startTime)
      || Number(right.action.type === 'qMove' && right.action.duration <= EPSILON)
        - Number(left.action.type === 'qMove' && left.action.duration <= EPSILON)
      || left.index - right.index)
  const nonLocomotion = document.actions.filter(
    (action) => !isActorSequenceAction(action, actorId),
  )
  const scheduled: ActorSequenceAction[] = []
  let chainEnd: number | null = null
  let reachedAnchor = !anchorActionId

  for (const { action } of entries) {
    if (!reachedAnchor && action.id !== anchorActionId) {
      scheduled.push(action)
      chainEnd = actionEndTime(action)
      continue
    }
    const requestedStart = action.id === anchorActionId
      ? action.startTime
      : (action.type === 'move' || action.type === 'wait') && action.timingConstraint
        ? Math.max(action.startTime, chainEnd ?? action.startTime)
        : chainEnd ?? action.startTime
    reachedAnchor = true
    const planningDocument: TacticDocumentV1 = {
      ...document,
      actions: [...nonLocomotion, ...scheduled],
    }

    if (action.type === 'wait') {
      if (action.timingConstraint) {
        const event = resolveTimingKeyframe(document, action.timingConstraint.reference)
        action.startTime = requestedStart
        if (event && event.time > requestedStart + EPSILON) action.duration = event.time - requestedStart
        scheduled.push(action)
        chainEnd = actionEndTime(action)
        continue
      }
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
      ? resolveTimingKeyframe(document, action.timingConstraint.reference)?.time ?? null
      : null
    const authoredDuration = action.duration
    const timedActor = action.type === 'move' && action.timingConstraint
      ? document.initialScene.players.find((player) => player.id === actorId) : undefined
    const timedOrigin = timedActor ? projectPlayerPosition(planningDocument, actorId, requestedStart) : undefined
    const plan = timedActor && timedOrigin
      ? { actor: timedActor, origin: timedOrigin, startTime: requestedStart, duration: authoredDuration }
      : action.type === 'qMove'
      ? planSimpleQ(planningDocument, actorId, requestedStart)
      : planSimpleLocomotion(
          planningDocument,
          actorId,
          requestedStart,
          (scheduledActor, plannedStart) => action.timingConstraint?.kind === 'qCooldown'
            ? (resolveMoveQCooldownTarget(document, { ...action, startTime: plannedStart })?.readyTime ?? (plannedStart + authoredDuration)) - plannedStart
            : action.timingConstraint?.kind === 'fixed'
            ? authoredDuration
            : action.ballTarget ? authoredDuration
            : action.timingConstraint?.kind === 'keyframe' && referencedTime !== null
              ? Math.max(0, referencedTime - plannedStart)
              : movementDuration(
                  resolvedMovePath({ ...action, path: [{ ...scheduledActor.position }, ...tail] }),
                  document.rulesSnapshot,
                ),
        )
    if (!plan) continue

    let path = [{ ...plan.origin }, ...tail]
    if (action.type === 'move' && action.timingConstraint) {
      const previousOrigin = action.path[0]
      if (previousOrigin) {
        const offset = { x: plan.origin.x - previousOrigin.x, y: plan.origin.y - previousOrigin.y }
        path = [
          { ...plan.origin },
          ...tail.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })),
        ]
        if (action.curveControl) {
          action.curveControl = {
            x: action.curveControl.x + offset.x,
            y: action.curveControl.y + offset.y,
          }
        }
      }
    }
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
      ? action.timingConstraint?.kind === 'qCooldown'
        ? (resolveMoveQCooldownTarget(document, action)?.readyTime ?? (plan.startTime + authoredDuration)) - plan.startTime
        : action.ballTarget || action.timingConstraint?.kind === 'fixed'
        ? authoredDuration
        : action.timingConstraint?.kind === 'keyframe' && referencedTime !== null
          ? Math.max(0, referencedTime - plan.startTime)
          : movementDuration(resolvedMovePath(action), document.rulesSnapshot)
      : qDuration(plan.actor, document.rulesSnapshot)
    if (action.type === 'move') syncConstrainedMovePath(document, action)
    scheduled.push(action)
    chainEnd = actionEndTime(action)
  }

  const dependents = new Set(document.actions.flatMap((action) => (
    (action.type === 'move' || action.type === 'wait') && action.actorId && (
      (action.type === 'move' && action.targetPlayerId === actorId)
      || (action.timingConstraint?.kind === 'keyframe' && action.timingConstraint.reference.playerId === actorId)
    ) ? [action.actorId] : []
  )))
  for (const dependent of dependents) reflowSimpleLocomotion(document, dependent, reflowedActors)
}
