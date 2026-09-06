import { clamp, getShootZone, pathLength } from '../geometry/geometry'
import type { PlayerState, RuleSetV1, TacticAction, Vec2 } from '../model/types'

const EPSILON = 1e-6

export function deceleratingDistance(elapsed: number, distance: number, duration: number): number {
  const progress = clamp(elapsed / Math.max(duration, EPSILON), 0, 1)
  return distance * progress * (2 - progress)
}

export function deceleratingTime(distance: number, maximum: number, duration: number): number {
  return duration * (1 - Math.sqrt(1 - clamp(distance / Math.max(maximum, EPSILON), 0, 1)))
}

export function movementDuration(path: Vec2[], rules: RuleSetV1): number {
  return pathLength(path) / rules.field.baseMoveSpeed
}

export function passDuration(path: Vec2[], rules: RuleSetV1): number {
  return passTimeForDistance(pathLength(path), rules)
}

export function passMaxDuration(rules: RuleSetV1): number {
  return Math.max(rules.passing.maxDistance, EPSILON) / Math.max(rules.passing.ballSpeed, EPSILON)
}

/** Integrated scalar speed, independent of the direction of a homing pass. */
export function passTravelDistance(elapsed: number, rules: RuleSetV1): number {
  return deceleratingDistance(elapsed, Math.max(rules.passing.maxDistance, EPSILON), passMaxDuration(rules))
}

/** Inverse of passTravelDistance; distances beyond the budget stop at its end. */
export function passTimeForDistance(distance: number, rules: RuleSetV1): number {
  const maxDistance = Math.max(rules.passing.maxDistance, EPSILON)
  return deceleratingTime(distance, maxDistance, passMaxDuration(rules))
}

/**
 * Passing follows one fixed linear-deceleration curve calibrated by the
 * configured maximum distance and its average speed. A shorter pass ends
 * earlier on that same curve instead of rescaling the curve to stop at zero.
 */
export function passPathProgress(path: Vec2[], elapsed: number, duration: number, rules: RuleSetV1, knownLength?: number): number {
  const length = knownLength ?? pathLength(path)
  if (length <= EPSILON) return 0
  const maxDistance = Math.max(rules.passing.maxDistance, EPSILON)
  const travelDistance = Math.min(length, maxDistance)
  const targetCurveTime = 1 - Math.sqrt(1 - travelDistance / maxDistance)
  const actionProgress = duration <= EPSILON ? (elapsed >= 0 ? 1 : 0) : clamp(elapsed / duration, 0, 1)
  const curveTime = actionProgress * targetCurveTime
  const traveledDistance = maxDistance * (1 - (1 - curveTime) ** 2)
  return clamp(traveledDistance / length, 0, travelDistance / length)
}

export function passArrivalTimeAtDistance(path: Vec2[], distanceFromStart: number, rules: RuleSetV1): number {
  const maxDistance = Math.max(rules.passing.maxDistance, EPSILON)
  const reachableDistance = Math.min(pathLength(path), maxDistance)
  if (reachableDistance <= EPSILON) return 0
  const distanceProgress = clamp(distanceFromStart / maxDistance, 0, reachableDistance / maxDistance)
  return (1 - Math.sqrt(1 - distanceProgress)) * passMaxDuration(rules)
}

export function qDuration(player: PlayerState, rules: RuleSetV1): number {
  return rules.roles[player.role].q.duration
}

export function shotDuration(player: PlayerState, charge: 'yellow' | 'red', rules: RuleSetV1): number {
  const zone = getShootZone(
    player.position,
    player.team,
    rules.field.width,
    rules.field.height,
    rules.field.smallPenaltyRadius,
    rules.field.largePenaltyRadius,
  )
  if (zone === 'inner') return charge === 'yellow' ? rules.shooting.innerYellow : rules.shooting.innerRed
  return charge === 'yellow' ? rules.shooting.outerYellow : rules.shooting.outerRed
}

export function actionEndTime(action: TacticAction): number {
  return action.startTime + Math.max(0, action.duration)
}

export function documentDuration(actions: TacticAction[], stepTimes: number[]): number {
  const actionEnd = actions.reduce((max, action) => Math.max(max, actionEndTime(action)), 0)
  return Math.max(actionEnd, ...stepTimes, 0)
}
