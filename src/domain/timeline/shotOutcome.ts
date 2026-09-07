import { distance, getShootZone } from '../geometry/geometry'
import type { ShootAction, TacticDocumentV1, Vec2 } from '../model/types'
import { actionEndTime } from './durations'

/** Shared shot rules; callers own position projection and its exclusion context. */
export function shotOutcome(
  document: TacticDocumentV1,
  shot: ShootAction,
  positionAt: (playerId: string, time: number) => Vec2 | undefined,
) {
  const rules = document.rulesSnapshot
  const actor = document.initialScene.players.find((player) => player.id === shot.actorId)
  const origin = positionAt(shot.actorId, shot.startTime)
  const zone = actor && origin ? getShootZone(origin, actor.team, rules.field.width, rules.field.height,
    rules.field.smallPenaltyRadius, rules.field.largePenaltyRadius) : 'outside'
  const interrupted = rules.shooting.interruptedByAttack && document.actions.some((action) => {
    if (action.type !== 'attack' || action.targetId !== shot.actorId
      || action.startTime < shot.startTime || action.startTime >= actionEndTime(shot)) return false
    const attacker = document.initialScene.players.find((player) => player.id === action.actorId)
    const from = positionAt(action.actorId, action.startTime)
    const target = positionAt(action.targetId, action.startTime)
    if (!attacker || !from || !target) return false
    const rule = rules.roles[attacker.role]
    const gap = distance(from, target)
    return gap >= (rule.attackInnerRadius ?? 0) && gap <= rule.attackRadius
  })
  return { interrupted, canComplete: !interrupted && zone !== 'outside' }
}
