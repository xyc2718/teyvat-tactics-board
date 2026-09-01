import type { TacticDocumentV1 } from '../model/types'
import { actionEndTime } from './durations'
import { sortedStepMarkers } from './steps'

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
  const sortedSteps = sortedStepMarkers(document)
  const index = sortedSteps.findIndex((step) => step.id === stepId)
  const current = sortedSteps[index]
  if (!current) return null
  const endTime = sortedSteps[index + 1]?.time ?? Number.POSITIVE_INFINITY
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

/**
 * Returns the elapsed time covered by the actions authored in one step.
 * Empty steps and steps containing only instantaneous actions last 0 seconds.
 */
export function stepDuration(document: TacticDocumentV1, stepId: string): number | null {
  const ownership = getStepActionOwnership(document, stepId)
  if (!ownership) return null
  if (ownership.count === 0) return 0

  const ownedIds = new Set(ownership.actionIds)
  const latestEnd = document.actions.reduce(
    (latest, action) => ownedIds.has(action.id) ? Math.max(latest, actionEndTime(action)) : latest,
    ownership.startTime,
  )
  return Math.max(0, latestEnd - ownership.startTime)
}
