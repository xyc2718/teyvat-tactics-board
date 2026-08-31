import { distance, pathLength, pointAlongPath } from '../geometry/geometry'
import type { ProjectedFrame, RuleSetV1, TeamId, Vec2 } from '../model/types'

const SAMPLE_SPACING = 0.2
const EPSILON = 1e-6

export const PASS_THREAT_ORDER = [
  'safe',
  'baseRisk',
  'qSingle',
  'qMultiple',
  'direct',
  'drop',
] as const

export type PassThreatLevel = (typeof PASS_THREAT_ORDER)[number]

export const PASS_THREAT_LABELS: Record<PassThreatLevel, string> = {
  safe: '安全段',
  baseRisk: '普通截断区',
  qSingle: '单人 Q 可达',
  qMultiple: '多人 Q 可达',
  direct: '直接截球走廊',
  drop: '超距落地',
}

export interface PassThreatSegment {
  level: PassThreatLevel
  path: Vec2[]
  startDistance: number
  endDistance: number
  opponentIds: string[]
}

function corridorWidth(distanceFromStart: number, rules: RuleSetV1): number {
  const riskLength = Math.max(rules.passing.maxDistance - rules.passing.safeDistance, EPSILON)
  const progress = Math.min(1, Math.max(0, (distanceFromStart - rules.passing.safeDistance) / riskLength))
  return rules.passing.interceptStartWidth
    + (rules.passing.interceptEndWidth - rules.passing.interceptStartWidth) * progress
}

function classifyPoint(
  point: Vec2,
  distanceFromStart: number,
  passerTeam: TeamId,
  frame: ProjectedFrame,
  rules: RuleSetV1,
): { level: PassThreatLevel; opponentIds: string[] } {
  if (distanceFromStart <= rules.passing.safeDistance + EPSILON) {
    return { level: 'safe', opponentIds: [] }
  }
  if (distanceFromStart > rules.passing.maxDistance + EPSILON) {
    return { level: 'drop', opponentIds: [] }
  }

  const width = corridorWidth(distanceFromStart, rules)
  const opponents = frame.players.filter((player) => player.team !== passerTeam)
  const direct = opponents.filter((player) => distance(player.position, point) <= width)
  if (direct.length > 0) {
    return { level: 'direct', opponentIds: direct.map((player) => player.id) }
  }

  const qReachable = opponents.filter((player) => {
    if ((frame.cooldowns[player.id]?.q ?? 0) > EPSILON) return false
    return distance(player.position, point) <= rules.roles[player.role].q.maxDistance + width
  })
  if (qReachable.length > 1) {
    return { level: 'qMultiple', opponentIds: qReachable.map((player) => player.id) }
  }
  if (qReachable.length === 1) {
    return { level: 'qSingle', opponentIds: qReachable.map((player) => player.id) }
  }
  return { level: 'baseRisk', opponentIds: [] }
}

export function classifyPassThreat(
  path: Vec2[],
  passerTeam: TeamId,
  frame: ProjectedFrame,
  rules: RuleSetV1,
): PassThreatSegment[] {
  const total = pathLength(path)
  if (path.length < 2 || total <= EPSILON) return []

  const boundaries = new Set<number>([0, total])
  const boundaryPoints = new Map<number, Vec2>([
    [0, { ...(path[0] ?? { x: 0, y: 0 }) }],
    [total, { ...(path[path.length - 1] ?? { x: 0, y: 0 }) }],
  ])
  let vertexDistance = 0
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1]
    const end = path[index]
    if (!start || !end) continue
    vertexDistance += distance(start, end)
    if (vertexDistance > EPSILON && vertexDistance < total - EPSILON) {
      boundaries.add(vertexDistance)
      boundaryPoints.set(vertexDistance, { ...end })
    }
  }
  if (rules.passing.safeDistance > 0 && rules.passing.safeDistance < total) {
    boundaries.add(rules.passing.safeDistance)
  }
  if (rules.passing.maxDistance > 0 && rules.passing.maxDistance < total) {
    boundaries.add(rules.passing.maxDistance)
  }
  const steps = Math.ceil(total / SAMPLE_SPACING)
  for (let index = 1; index < steps; index += 1) {
    boundaries.add(Math.min(total, index * SAMPLE_SPACING))
  }

  const distances = [...boundaries].sort((left, right) => left - right)
  const segments: PassThreatSegment[] = []
  for (let index = 1; index < distances.length; index += 1) {
    const startDistance = distances[index - 1]
    const endDistance = distances[index]
    if (startDistance === undefined || endDistance === undefined || endDistance - startDistance <= EPSILON) continue
    const midpoint = (startDistance + endDistance) / 2
    const classification = classifyPoint(
      pointAlongPath(path, midpoint / total),
      midpoint,
      passerTeam,
      frame,
      rules,
    )
    const start = boundaryPoints.get(startDistance) ?? pointAlongPath(path, startDistance / total)
    const end = boundaryPoints.get(endDistance) ?? pointAlongPath(path, endDistance / total)
    const previous = segments[segments.length - 1]
    if (previous?.level === classification.level) {
      previous.path.push(end)
      previous.endDistance = endDistance
      previous.opponentIds = [...new Set([...previous.opponentIds, ...classification.opponentIds])]
      continue
    }
    segments.push({
      level: classification.level,
      path: [start, end],
      startDistance,
      endDistance,
      opponentIds: classification.opponentIds,
    })
  }
  return segments
}

export function highestPassThreat(segments: PassThreatSegment[]): PassThreatLevel {
  return segments.reduce<PassThreatLevel>((highest, segment) => (
    PASS_THREAT_ORDER.indexOf(segment.level) > PASS_THREAT_ORDER.indexOf(highest)
      ? segment.level
      : highest
  ), 'safe')
}
