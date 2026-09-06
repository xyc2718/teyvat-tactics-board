import { compilePath } from '../geometry/compiledPath'
import { goalOpening } from '../geometry/field'
import { clampPoint, distance } from '../geometry/geometry'
import type { LoosePassAction, RuleSetV1, TacticDocumentV1, Vec2 } from '../model/types'
import { deceleratingDistance, deceleratingTime } from './durations'
import { projectFrameAtKeyframe } from './projectFrame'
import { loosePassingRule } from '../rules/loosePassing'

export { DEFAULT_LOOSE_PASSING, loosePassingRule } from '../rules/loosePassing'

export const MAX_LOOSE_PATH_POINTS = 128

export function reflectedFlight(origin: Vec2, direction: Vec2, rules: RuleSetV1) {
  const { maxDistance, maxDuration } = loosePassingRule(rules)
  const { width, height } = rules.field
  const norm = Math.hypot(direction.x, direction.y)
  if (norm < 1e-9 || !Number.isFinite(norm)) throw new Error('请选择有效的空传方向。')
  let dx = direction.x / norm
  let dy = direction.y / norm
  let position = clampPoint(origin, width, height)
  const path = [{ ...position }]
  let traveled = 0
  let flightOutcome: LoosePassAction['flightOutcome'] = 'grounded'
  const opening = goalOpening(height)
  for (let iteration = 0; traveled < maxDistance - 1e-9; iteration += 1) {
    if (iteration >= MAX_LOOSE_PATH_POINTS - 1) throw new Error('空传反弹次数超过安全上限，请调整方向或球场规则。')
    // Starting on a solid wall and pointing outwards reflects without a zero-length vertex.
    if ((position.x <= 1e-9 && dx < 0) || (position.x >= width - 1e-9 && dx > 0)) {
      if (position.y > opening.top && position.y < opening.bottom) { flightOutcome = 'goal'; break }
      dx = -dx
    }
    if ((position.y <= 1e-9 && dy < 0) || (position.y >= height - 1e-9 && dy > 0)) dy = -dy
    const xDistance = Math.abs(dx) < 1e-12 ? Infinity : ((dx > 0 ? width : 0) - position.x) / dx
    const yDistance = Math.abs(dy) < 1e-12 ? Infinity : ((dy > 0 ? height : 0) - position.y) / dy
    const advance = Math.min(maxDistance - traveled, xDistance, yDistance)
    if (!(advance > 1e-12)) throw new Error('无法解算此空传的边界反弹。')
    position = clampPoint({ x: position.x + dx * advance, y: position.y + dy * advance }, width, height)
    path.push({ ...position })
    traveled += advance
    const hitX = Math.abs(advance - xDistance) < 1e-8
    const hitY = Math.abs(advance - yDistance) < 1e-8
    if (hitX && position.y > opening.top && position.y < opening.bottom) { flightOutcome = 'goal'; break }
    if (hitX) dx = -dx
    if (hitY) dy = -dy
  }
  if (path.length === 1) path.push({ ...position })
  return { path, flightOutcome, duration: deceleratingTime(traveled, maxDistance, maxDuration) }
}

export function resolveLoosePass(document: TacticDocumentV1, action: LoosePassAction) {
  const projection = { ...document, actions: document.actions.filter((candidate) => candidate.id !== action.id
    && !(candidate.type === 'receive' && candidate.ballSourceActionId === action.id)) }
  const origin = projectFrameAtKeyframe(projection, action.startTime, action.originKeyframe ?? null)
    .players.find((player) => player.id === action.actorId)?.position ?? action.path[0]!
  return reflectedFlight(origin, action.aimDirection, document.rulesSnapshot)
}

export function loosePassPosition(action: LoosePassAction, time: number, rules: RuleSetV1): Vec2 {
  const curve = loosePassingRule(rules)
  return compilePath(action.path).pointAtDistance(deceleratingDistance(Math.min(time - action.startTime, action.duration), curve.maxDistance, curve.maxDuration))
}

export function loosePassJointTimes(action: LoosePassAction, rules: RuleSetV1): number[] {
  const curve = loosePassingRule(rules)
  let traveled = 0
  return action.path.slice(1).map((point, index) => {
    traveled += distance(action.path[index]!, point)
    if (index === action.path.length - 2) return action.startTime + action.duration
    return action.startTime + deceleratingTime(traveled, curve.maxDistance, curve.maxDuration)
  })
}
