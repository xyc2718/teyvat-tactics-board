import { distance } from '../geometry/geometry'
import type { PlayerState, ProjectedFrame, RuleSetV1, ShootAction, TacticDocumentV1 } from '../model/types'
import { projectFrame } from '../timeline/projectFrame'
import { evaluateReachTiming, type ReachMode, type ReachTiming } from './reachTime'

const EPSILON = 1e-6

export type ShotPressureMode = ReachMode
export type AttackRangeRelation = 'tooClose' | 'inside' | 'outside'

export interface DefenderShotPressure extends ReachTiming {
  defender: PlayerState
  rangeRelation: AttackRangeRelation
  gap: number
  attackInnerRadius: number
  attackOuterRadius: number
  radialEntryDistance: number
}

export interface ShotPressureEvaluation {
  shooter: PlayerState
  defenders: DefenderShotPressure[]
  earliest: DefenderShotPressure | null
  chargeDuration: number
  isRisk: boolean
  margin: number | null
}

export function radialDistanceToAttackAnnulus(
  gap: number,
  rawInnerRadius: number,
  rawOuterRadius: number,
): { distance: number; relation: AttackRangeRelation; innerRadius: number; outerRadius: number } {
  const outerRadius = Math.max(0, rawOuterRadius)
  const innerRadius = Math.min(Math.max(0, rawInnerRadius), outerRadius)
  if (gap < innerRadius) {
    return { distance: innerRadius - gap, relation: 'tooClose', innerRadius, outerRadius }
  }
  if (gap > outerRadius) {
    return { distance: gap - outerRadius, relation: 'outside', innerRadius, outerRadius }
  }
  return { distance: 0, relation: 'inside', innerRadius, outerRadius }
}

/**
 * Predicts the earliest time an opponent can enter their own attack annulus
 * around a stationary shooter. It intentionally models no reaction delay.
 */
export function evaluateShotPressure(
  frame: ProjectedFrame,
  shooterId: string,
  rules: RuleSetV1,
  chargeDuration: number,
): ShotPressureEvaluation | null {
  const shooter = frame.players.find((player) => player.id === shooterId)
  if (!shooter) return null
  const defenders = frame.players
    .filter((player) => player.team !== shooter.team)
    .map((defender): DefenderShotPressure => {
      const role = rules.roles[defender.role]
      const gap = distance(defender.position, shooter.position)
      const annulus = radialDistanceToAttackAnnulus(gap, role.attackInnerRadius ?? 0, role.attackRadius)
      const timing = evaluateReachTiming(frame, defender, annulus.distance, rules)
      return {
        ...timing,
        defender,
        rangeRelation: annulus.relation,
        gap,
        attackInnerRadius: annulus.innerRadius,
        attackOuterRadius: annulus.outerRadius,
        radialEntryDistance: annulus.distance,
      }
    })
    .sort((left, right) => left.earliestTime - right.earliestTime || left.defender.id.localeCompare(right.defender.id))
  const earliest = defenders[0] ?? null
  const safeChargeDuration = Math.max(0, chargeDuration)
  return {
    shooter,
    defenders,
    earliest,
    chargeDuration: safeChargeDuration,
    isRisk: earliest ? earliest.earliestTime <= safeChargeDuration + EPSILON : false,
    margin: earliest ? earliest.earliestTime - safeChargeDuration : null,
  }
}

export function evaluateShotActionPressure(
  document: TacticDocumentV1,
  action: ShootAction,
): ShotPressureEvaluation | null {
  return evaluateShotPressure(
    projectFrame(document, action.startTime),
    action.actorId,
    document.rulesSnapshot,
    action.duration,
  )
}

export function shotPressureModeLabel(mode: ShotPressureMode): string {
  return mode === 'q' ? 'Q逼近' : '直跑逼近'
}

function compactSeconds(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

export function shotPressureSummary(evaluation: ShotPressureEvaluation): string {
  const earliest = evaluation.earliest
  if (!earliest) return '无对手可形成射门压力'
  return `最早受击 ${compactSeconds(earliest.earliestTime)}s · ${earliest.defender.name} ${shotPressureModeLabel(earliest.mode)}`
}

export function shotPressureComparison(evaluation: ShotPressureEvaluation): string {
  if (!evaluation.earliest || evaluation.margin === null) return '当前没有对手逼近数据'
  const margin = compactSeconds(Math.abs(evaluation.margin))
  return evaluation.isRisk ? `风险 · 不晚于蓄力完成 ${margin}s` : `安全窗 · 领先 ${margin}s`
}
