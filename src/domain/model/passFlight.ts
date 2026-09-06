import { pathLength } from '../geometry/geometry'
import type { PassAction, RuleSetV1 } from './types'

/** Bounded generated geometry; other authored action paths keep their small limit. */
export const MAX_PASS_PATH_POINTS = 1024

/** Legacy files use distance until the editor normalizes their named passes. */
export function passIsReceived(pass: PassAction, rules: RuleSetV1): boolean {
  if (!pass.targetPlayerId) return false
  return pass.flightOutcome !== undefined
    ? pass.flightOutcome === 'received'
    : pathLength(pass.path) <= rules.passing.maxDistance
}

export function passIsDropped(pass: PassAction, rules: RuleSetV1): boolean {
  return pass.flightOutcome !== undefined
    ? pass.flightOutcome === 'dropped'
    : pathLength(pass.path) > rules.passing.maxDistance
}
