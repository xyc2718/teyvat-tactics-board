import { createDefaultDocument } from '../domain/model/createDocument'
import { parseTactic } from '../persistence/tacticFile'
import fixture from './fixtures/follow-performance.json'

/** Gameplay-only copy of the reported 13-action import; no user metadata. */
export function createFollowPerformanceFixture() {
  const document = { ...createDefaultDocument(), ...structuredClone(fixture) }
  const parsed = parseTactic(JSON.stringify({
    ...document,
    stepMarkers: document.stepMarkers.map((step) => ({ ...step, snapshot: document.initialScene })),
  }))
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.document
}
