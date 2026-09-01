import type { StepMarker, TacticDocumentV1 } from '../model/types'

export const FIRST_ACTION_STEP_TIME = 0

export function sortedStepMarkers(document: TacticDocumentV1): StepMarker[] {
  return document.stepMarkers
    .map((step, originalIndex) => ({ step, originalIndex }))
    .sort((left, right) => left.step.time - right.step.time || left.originalIndex - right.originalIndex)
    .map(({ step }) => step)
}

export function openingStep(document: TacticDocumentV1): StepMarker | undefined {
  const first = sortedStepMarkers(document)[0]
  return first && Math.abs(first.time) <= 1e-6 ? first : undefined
}

export function isOpeningStep(document: TacticDocumentV1, stepId: string): boolean {
  return openingStep(document)?.id === stepId
}
