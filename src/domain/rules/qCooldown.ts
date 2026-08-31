import type { QMoveAction, TacticDocumentV1 } from '../model/types'

const EPSILON = 1e-6

export interface QCooldownConflict {
  actionId: string
  actionStartTime: number
  actualGap: number
  requiredGap: number
  remaining: number
}

export type QCooldownValidation =
  | { valid: true; cooldown: number }
  | { valid: false; cooldown: number; conflict: QCooldownConflict }

export interface QCooldownSequenceConflict {
  earlier: QMoveAction
  later: QMoveAction
  requiredGap: number
  remaining: number
}

function actorCooldown(document: TacticDocumentV1, actorId: string): number {
  const role = document.initialScene.players.find((player) => player.id === actorId)?.role
  return role ? Math.max(0, document.rulesSnapshot.roles[role].q.cooldown) : 0
}

function actorQActions(document: TacticDocumentV1, actorId: string, ignoreActionId?: string): QMoveAction[] {
  return document.actions
    .filter(
      (action): action is QMoveAction =>
        action.type === 'qMove' && action.actorId === actorId && action.id !== ignoreActionId,
    )
    .sort((left, right) => left.startTime - right.startTime)
}

/** Validates the absolute start-to-start cooldown gap against every same-actor Q. */
export function validateQStart(
  document: TacticDocumentV1,
  actorId: string,
  proposedStart: number,
  ignoreActionId?: string,
): QCooldownValidation {
  const cooldown = actorCooldown(document, actorId)
  if (cooldown <= EPSILON) return { valid: true, cooldown }
  const conflicts = actorQActions(document, actorId, ignoreActionId)
    .map((action) => {
      const actualGap = Math.abs(Math.max(0, proposedStart) - action.startTime)
      return {
        actionId: action.id,
        actionStartTime: action.startTime,
        actualGap,
        requiredGap: cooldown,
        remaining: Math.max(0, cooldown - actualGap),
      }
    })
    .filter((conflict) => conflict.remaining > EPSILON)
    .sort((left, right) => right.remaining - left.remaining || left.actionStartTime - right.actionStartTime)
  const conflict = conflicts[0]
  return conflict ? { valid: false, cooldown, conflict } : { valid: true, cooldown }
}

/** Finds the first legal time at or after requestedStart without moving existing Q actions. */
export function earliestLegalQStart(
  document: TacticDocumentV1,
  actorId: string,
  requestedStart: number,
  ignoreActionId?: string,
): number {
  const cooldown = actorCooldown(document, actorId)
  let candidate = Math.max(0, requestedStart)
  if (cooldown <= EPSILON) return candidate
  const actions = actorQActions(document, actorId, ignoreActionId)
  for (let attempt = 0; attempt <= actions.length; attempt += 1) {
    const conflict = actions.find((action) => Math.abs(candidate - action.startTime) < cooldown - EPSILON)
    if (!conflict) return candidate
    candidate = conflict.startTime + cooldown
  }
  return candidate
}

export function qCooldownConflictNotice(validation: Extract<QCooldownValidation, { valid: false }>): string {
  const { conflict } = validation
  return `Q 冷却未完成：与 ${conflict.actionStartTime.toFixed(2)} 秒的同一球员 Q 需间隔 ${conflict.requiredGap.toFixed(2)} 秒，还差 ${cooldownRemainingText(conflict.remaining)} 秒。`
}

/** Avoids presenting a real sub-centisecond conflict as a misleading 0.00 seconds. */
export function cooldownRemainingText(remaining: number): string {
  return remaining < 0.01 ? '不足 0.01' : remaining.toFixed(2)
}

/** Reports each legacy/imported later Q that starts before the preceding Q cooldown completes. */
export function qCooldownSequenceConflicts(
  document: TacticDocumentV1,
  actorId: string,
): QCooldownSequenceConflict[] {
  const cooldown = actorCooldown(document, actorId)
  const actions = actorQActions(document, actorId)
  const conflicts: QCooldownSequenceConflict[] = []
  for (let index = 1; index < actions.length; index += 1) {
    const earlier = actions[index - 1]
    const later = actions[index]
    if (!earlier || !later) continue
    const remaining = cooldown - (later.startTime - earlier.startTime)
    if (remaining > EPSILON) conflicts.push({ earlier, later, requiredGap: cooldown, remaining })
  }
  return conflicts
}
