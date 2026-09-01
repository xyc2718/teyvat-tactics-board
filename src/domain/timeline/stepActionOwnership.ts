import type { TacticDocumentV1 } from '../model/types'
import { actionEndTime } from './durations'
import { isOpeningStep, sortedStepMarkers } from './steps'

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

/** The keyframe a step card represents after its currently owned actions finish. */
export function stepDisplayTime(document: TacticDocumentV1, stepId: string): number | null {
  const step = document.stepMarkers.find((candidate) => candidate.id === stepId)
  if (!step) return null
  if (isOpeningStep(document, stepId)) return step.time
  const ownership = getStepActionOwnership(document, stepId)
  if (!ownership?.count) return step.time
  const ownedIds = new Set(ownership.actionIds)
  return document.actions.reduce(
    (latest, action) => ownedIds.has(action.id) ? Math.max(latest, actionEndTime(action)) : latest,
    step.time,
  )
}
