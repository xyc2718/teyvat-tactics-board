import type { RuleSetV1 } from '../model/types'

export const DEFAULT_LOOSE_PASSING = { maxDistance: 6, maxDuration: 3 } as const

/** Optional calibration keeps legacy passing snapshots untouched. */
export function loosePassingRule(rules: RuleSetV1) {
  return rules.loosePassing ?? DEFAULT_LOOSE_PASSING
}
