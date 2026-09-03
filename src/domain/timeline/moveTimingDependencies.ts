import type { TacticAction, TacticDocumentV1 } from '../model/types'
import { actionEndTime } from './durations'

function isSequenceAction(action: TacticAction): action is Extract<TacticAction, { type: 'move' | 'qMove' | 'wait' }> & { actorId: string } {
  return (action.type === 'move' || action.type === 'qMove' || action.type === 'wait') && Boolean(action.actorId)
}

function previousSequenceActionId(document: TacticDocumentV1, action: TacticAction): string | null {
  if (!isSequenceAction(action)) return null
  const ordered = document.actions
    .map((candidate, index) => ({ candidate, index }))
    .filter((entry) => isSequenceAction(entry.candidate) && entry.candidate.actorId === action.actorId)
    .sort((left, right) => (
      left.candidate.startTime - right.candidate.startTime
      || actionEndTime(left.candidate) - actionEndTime(right.candidate)
      || left.index - right.index
    ))
  const actionIndex = ordered.findIndex((entry) => entry.candidate.id === action.id)
  return actionIndex > 0 ? ordered[actionIndex - 1]?.candidate.id ?? null : null
}

function timingDependencyActionIds(document: TacticDocumentV1, action: TacticAction): string[] {
  const dependencies: string[] = []
  const previousId = previousSequenceActionId(document, action)
  if (previousId) dependencies.push(previousId)
  if (action.type === 'move') {
    if (action.targetPlayerId && action.syncActionId) dependencies.push(action.syncActionId)
    if (action.timingConstraint?.kind === 'keyframe') dependencies.push(action.timingConstraint.reference.actionId)
  }
  return dependencies
}

/** True when adding `moveActionId -> referencedActionId` closes a timing-dependency cycle. */
export function moveTimingWouldCycle(
  document: TacticDocumentV1,
  moveActionId: string,
  referencedActionId: string,
): boolean {
  const visited = new Set<string>()
  const pending = [referencedActionId]
  while (pending.length > 0) {
    const currentId = pending.pop()
    if (!currentId) continue
    if (currentId === moveActionId) return true
    if (visited.has(currentId)) continue
    visited.add(currentId)
    const current = document.actions.find((action) => action.id === currentId)
    if (current) pending.push(...timingDependencyActionIds(document, current))
  }
  return false
}
