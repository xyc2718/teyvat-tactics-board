import type { PlayerState, ProjectedFrame, RuleSetV1, Vec2 } from '../model/types'
import { fixedQPreRunDistance } from './geoShieldGeometry'

const EPSILON = 1e-6

export type ReachMode = 'direct' | 'q' | 'e' | 'qE'

export interface ReachAnnulus {
  gap: number
  innerRadius: number
  outerRadius: number
  center?: Vec2
}

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
  eTime: number
  qETime: number
  eEnergy: number
  eCooldownAtStart: number
  earliestTime: number
}

/** Minimum radial running needed before/after a full fixed Q, never a shortened Q. */
function fixedQEntryDistance(target: ReachAnnulus, qDistance: number): number {
  const inner = Math.max(0, target.innerRadius)
  const outer = Math.max(inner, target.outerRadius)
  const lower = Math.max(0, inner - qDistance, qDistance - outer)
  const upper = outer + qDistance
  return Math.max(0, lower - target.gap, target.gap - upper)
}

/**
 * A single sprint plus ordinary running has three energy bounds at arrival T:
 * full duration B, T-ready, and B*(energy+T/recovery)/(1+B/recovery).
 * Inverting the three linear distance bounds gives the optimum without time
 * stepping. Waiting/running before E regenerates; time spent in E never does.
 */
function sprintArrival(
  requiredDistance: number,
  speed: number,
  sprintSpeed: number,
  frozenDelay: number,
  ready: number,
  energy: number,
  duration: number,
  recovery: number,
  active: boolean,
): number {
  if (sprintSpeed <= speed + EPSILON || duration <= 0) return Infinity
  const gain = sprintSpeed - speed
  if (active) {
    const budget = energy * duration
    if (budget <= EPSILON) return Infinity
    return Math.max(requiredDistance / sprintSpeed, (requiredDistance - gain * budget) / speed)
  }
  const effectiveDuration = duration / (1 + duration / recovery)
  return Math.max(
    frozenDelay,
    ready,
    (requiredDistance + speed * frozenDelay - gain * duration) / speed,
    (requiredDistance + speed * frozenDelay + gain * ready) / sprintSpeed,
    (requiredDistance + speed * frozenDelay - gain * effectiveDuration * energy)
      / (speed + gain * effectiveDuration / recovery),
  )
}

/** Compile snapshot-only input once for an entire sampled pass route. */
export function createReachTimingEvaluator(
  frame: ProjectedFrame,
  player: PlayerState,
  rules: RuleSetV1,
): (rawRequiredDistance: number, target?: ReachAnnulus) => ReachTiming {
  const speed = Math.max(EPSILON, rules.field.baseMoveSpeed)
  const role = rules.roles[player.role]
  const frozenDelay = frame.statuses
    .filter((status) => status.playerId === player.id && status.kind === 'frozen' && status.startsAt <= frame.time)
    .reduce((latest, status) => Math.max(latest, status.endsAt - frame.time), 0)
  const qCooldownAtStart = Math.max(0, frame.cooldowns[player.id]?.q ?? 0)
  const qCooldownAfterFreeze = Math.max(0, qCooldownAtStart - frozenDelay)
  const cooldownWalkTime = qCooldownAfterFreeze
  const sprint = role.sprint
  const state = frame.sprints?.[player.id]
  const eEnergy = Math.max(0, Math.min(1, state?.energy ?? 1))
  const eCooldownAtStart = Math.max(0, state?.cooldown ?? frame.cooldowns[player.id]?.e ?? 0)
  const active = state?.active === true && frozenDelay === 0
  const canSprint = sprint !== undefined && frame.ball.carrierId !== player.id

  return (rawRequiredDistance, target) => {
    const requiredDistance = Math.max(0, rawRequiredDistance)
    const walkDuringCooldown = Math.min(requiredDistance, cooldownWalkTime * speed)
    const remainingBeforeQ = Math.max(0, requiredDistance - walkDuringCooldown)
    const qDistanceUsed = Math.min(remainingBeforeQ, role.q.maxDistance)
    const residualWalkDistance = Math.max(0, remainingBeforeQ - qDistanceUsed)
    const directTime = frozenDelay + requiredDistance / speed
    // Keep legacy role estimates unchanged. Electro's new fixed Q must land
    // in the target annulus (a point for a loose ball), including its inner hole.
    let qEntryDistance = Math.max(0, requiredDistance - role.q.maxDistance)
    if (player.role === 'electro' && role.q.fixedDistance) {
      const annulus = target ?? { gap: requiredDistance, innerRadius: 0, outerRadius: 0 }
      qEntryDistance = fixedQEntryDistance(annulus, role.q.maxDistance)
      // An actual field-boundary landing can legally shorten Q. The shared
      // geometry only credits a real covering landing; unlike the Geo shield
      // contract, attack/ball approach may also run after a full overshoot.
      if (annulus.center && annulus.innerRadius === 0) {
        qEntryDistance = Math.min(qEntryDistance, fixedQPreRunDistance(
          player.position, annulus.center, annulus.center, annulus.outerRadius, role.q.maxDistance, rules.field,
        ))
      }
    }
    const qReady = Math.max(frozenDelay, qCooldownAtStart)
    const qTime = player.role === 'electro' && role.q.fixedDistance
      ? Math.max(qReady, frozenDelay + qEntryDistance / speed) + role.q.duration
      : frozenDelay + cooldownWalkTime + role.q.duration + residualWalkDistance / speed
    let eTime = Infinity
    let qETime = Infinity
    if (canSprint) {
      const sprintSpeed = sprint.maxDistance / Math.max(EPSILON, sprint.maxDuration)
      const ready = Math.max(frozenDelay, eCooldownAtStart)
      const recovery = Math.max(EPSILON, sprint.recoveryDuration)
      const arrival = (gap: number, freeze: number, starts: number, continuing: boolean) => sprintArrival(
        gap, speed, sprintSpeed, freeze, starts, eEnergy, sprint.maxDuration, recovery, continuing,
      )
      eTime = arrival(requiredDistance, frozenDelay, ready, active)
      // Continuing an active E uses only the energy still in hand. Alternatively
      // stop now, regenerate through the new cooldown and use one later burst.
      const restartReady = active ? Math.max(frozenDelay, sprint.cooldown) : ready
      if (active) eTime = Math.min(eTime, arrival(requiredDistance, frozenDelay, restartReady, false))
      const eThenQ = Math.max(qReady, arrival(qEntryDistance, frozenDelay, ready, active)) + role.q.duration
      const qThenE = arrival(qEntryDistance, frozenDelay + role.q.duration,
        Math.max(restartReady, qReady + role.q.duration), false)
      qETime = Math.min(eThenQ, qThenE)
    }
    let mode: ReachMode = 'direct'
    let earliestTime = directTime
    for (const [candidateMode, time] of [['q', qTime], ['e', eTime], ['qE', qETime]] as const) {
      if (time < earliestTime - EPSILON) {
        mode = candidateMode
        earliestTime = time
      }
    }
    return {
      mode, requiredDistance, frozenDelay, qCooldownAtStart, qCooldownAfterFreeze,
      cooldownWalkTime, walkDuringCooldown, qMaxDistance: role.q.maxDistance,
      qDuration: role.q.duration, qDistanceUsed, residualWalkDistance,
      directTime, qTime, eTime, qETime, eEnergy, eCooldownAtStart, earliestTime,
    }
  }
}

/** Snapshot advisory only: no actions, player/flight projection or reaction-time simulation. */
export function evaluateReachTiming(
  frame: ProjectedFrame,
  player: PlayerState,
  requiredDistance: number,
  rules: RuleSetV1,
  target?: ReachAnnulus,
): ReachTiming {
  return createReachTimingEvaluator(frame, player, rules)(requiredDistance, target)
}
