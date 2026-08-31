import { getShootZone, pathLength } from '../geometry/geometry'
import type { PlayerState, RuleSetV1, TacticAction, Vec2 } from '../model/types'

export function movementDuration(path: Vec2[], rules: RuleSetV1): number {
  return pathLength(path) / rules.field.baseMoveSpeed
}

export function passDuration(path: Vec2[], rules: RuleSetV1): number {
  return pathLength(path) / rules.passing.ballSpeed
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
