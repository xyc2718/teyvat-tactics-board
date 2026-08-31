import type { TacticDocumentV1 } from '../model/types'

export interface StepActionOwnership {
  stepId: string
  startTime: number
  endTime: number
  actionIds: string[]
  count: number
}

/**
 * Assigns actions to a step by their start time only. A long-running action
 * that crosses the next marker remains owned by the step where it started.
 */
export function getStepActionOwnership(
  document: TacticDocumentV1,
  stepId: string,
): StepActionOwnership | null {
  const sortedSteps = document.stepMarkers
    .map((step, originalIndex) => ({ step, originalIndex }))
    .sort((left, right) => left.step.time - right.step.time || left.originalIndex - right.originalIndex)
  const index = sortedSteps.findIndex(({ step }) => step.id === stepId)
  const current = sortedSteps[index]?.step
  if (!current) return null
  const endTime = sortedSteps[index + 1]?.step.time ?? Number.POSITIVE_INFINITY
  const actionIds = document.actions
    .filter((action) => action.startTime >= current.time && action.startTime < endTime)
    .map((action) => action.id)
  return {
    stepId: current.id,
    startTime: current.time,
    endTime,
    actionIds,
    count: actionIds.length,
  }
}

export function formatStepActionRange(ownership: StepActionOwnership): string {
  return Number.isFinite(ownership.endTime)
    ? `${ownership.startTime.toFixed(2)}s ≤ 动作开始 < ${ownership.endTime.toFixed(2)}s`
    : `动作开始 ≥ ${ownership.startTime.toFixed(2)}s`
}
