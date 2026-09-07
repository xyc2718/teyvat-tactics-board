import type { MoveAction, QMoveAction, TacticDocumentV1 } from '../model/types'

const EPSILON = 1e-6

export interface MoveQCooldownTarget {
  sourceActionId: string
  readyTime: number
}

function cooldownTarget(
  document: TacticDocumentV1,
  move: MoveAction,
  source: QMoveAction | undefined,
): MoveQCooldownTarget | null {
  if (move.targetPlayerId || move.ballTarget || !source || source.actorId !== move.actorId
    || source.startTime > move.startTime) return null
  const actor = document.initialScene.players.find((player) => player.id === move.actorId)
  if (!actor) return null
  const readyTime = source.startTime + document.rulesSnapshot.roles[actor.role].q.cooldown
  return Number.isFinite(readyTime) && readyTime > move.startTime + EPSILON
    ? { sourceActionId: source.id, readyTime }
    : null
}

/** Select once from the runner's past Q casts; instant Q precedes a same-time run. */
export function findMoveQCooldownTarget(document: TacticDocumentV1, move: MoveAction): MoveQCooldownTarget | null {
  let latest: QMoveAction | undefined
  for (const action of document.actions) {
    if (action.type !== 'qMove' || action.actorId !== move.actorId || action.startTime > move.startTime) continue
    if (!latest || action.startTime > latest.startTime
      || action.startTime === latest.startTime && action.id < latest.id) latest = action
  }
  return cooldownTarget(document, move, latest)
}

/** Resolve the saved identity only, without projection, thaw calculation or source reselection. */
export function resolveMoveQCooldownTarget(document: TacticDocumentV1, move: MoveAction): MoveQCooldownTarget | null {
  if (move.timingConstraint?.kind !== 'qCooldown') return null
  const sourceId = move.timingConstraint.sourceActionId
  const source = document.actions.find((action): action is QMoveAction => action.id === sourceId && action.type === 'qMove')
  return cooldownTarget(document, move, source)
}
