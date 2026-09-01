import type { PlayerState, ProjectedFrame, RuleSetV1 } from '../model/types'

const EPSILON = 1e-6

export type ReachMode = 'direct' | 'q'

export interface ReachTiming {
  mode: ReachMode
  requiredDistance: number
  frozenDelay: number
  qCooldownAtStart: number
  qCooldownAfterFreeze: number
  cooldownWalkTime: number
  walkDuringCooldown: number
  qMaxDistance: number
  qDuration: number
  qDistanceUsed: number
  residualWalkDistance: number
  directTime: number
  qTime: number
  earliestTime: number
}

/** Estimates the earliest direct-run or Q-assisted arrival without a reaction-time parameter. */
export function evaluateReachTiming(
  frame: ProjectedFrame,
  player: PlayerState,
  rawRequiredDistance: number,
  rules: RuleSetV1,
): ReachTiming {
  const requiredDistance = Math.max(0, rawRequiredDistance)
  const speed = Math.max(EPSILON, rules.field.baseMoveSpeed)
  const role = rules.roles[player.role]
  const frozenDelay = frame.statuses
    .filter((status) => status.playerId === player.id && status.kind === 'frozen')
    .reduce((latest, status) => Math.max(latest, status.endsAt - frame.time), 0)
  const qCooldownAtStart = Math.max(0, frame.cooldowns[player.id]?.q ?? 0)
  const qCooldownAfterFreeze = Math.max(0, qCooldownAtStart - frozenDelay)
  const cooldownWalkTime = qCooldownAfterFreeze
  const walkDuringCooldown = Math.min(requiredDistance, cooldownWalkTime * speed)
  const remainingBeforeQ = Math.max(0, requiredDistance - walkDuringCooldown)
  const qDistanceUsed = Math.min(remainingBeforeQ, role.q.maxDistance)
  const residualWalkDistance = Math.max(0, remainingBeforeQ - qDistanceUsed)
  const directTime = frozenDelay + requiredDistance / speed
  const qTime = frozenDelay + cooldownWalkTime + role.q.duration + residualWalkDistance / speed
  const mode: ReachMode = directTime <= qTime + EPSILON ? 'direct' : 'q'

  return {
    mode,
    requiredDistance,
    frozenDelay,
    qCooldownAtStart,
    qCooldownAfterFreeze,
    cooldownWalkTime,
    walkDuringCooldown,
    qMaxDistance: role.q.maxDistance,
    qDuration: role.q.duration,
    qDistanceUsed,
    residualWalkDistance,
    directTime,
    qTime,
    earliestTime: mode === 'direct' ? directTime : qTime,
  }
}
