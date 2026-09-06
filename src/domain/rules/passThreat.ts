import { distance } from '../geometry/geometry'
import { compilePath } from '../geometry/compiledPath'
import type { PassAction, ProjectedFrame, RuleSetV1, TeamId, Vec2 } from '../model/types'
import { passTimeForDistance } from '../timeline/durations'

const SAMPLE_SPACING = 0.2
const MAX_UNIFORM_SAMPLES = 512
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

function frozenDelayAtFrame(frame: ProjectedFrame, playerId: string): number {
  return frame.statuses
    .filter(
      (status) => status.playerId === playerId
        && status.kind === 'frozen'
        && status.startsAt <= frame.time
        && status.endsAt > frame.time,
    )
    .reduce((latest, status) => Math.max(latest, status.endsAt - frame.time), 0)
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

  const ballArrivalTime = passTimeForDistance(distanceFromStart, rules)
  const qReachable = opponents.filter((player) => {
    const qRule = rules.roles[player.role].q
    const requiredQDistance = Math.max(0, distance(player.position, point) - width)
    if (requiredQDistance > qRule.maxDistance + EPSILON) return false

    // Cooldown keeps ticking while frozen, but Q cannot begin until both
    // cooldown and freeze have ended. A player already standing in the
    // corridor was handled above and can still intercept in place.
    const qAvailableDelay = Math.max(
      Math.max(0, frame.cooldowns[player.id]?.q ?? 0),
      frozenDelayAtFrame(frame, player.id),
    )
    return qAvailableDelay + qRule.duration <= ballArrivalTime + EPSILON
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
  flightOutcome?: PassAction['flightOutcome'],
): PassThreatSegment[] {
  const compiled = compilePath(path)
  const total = compiled.length
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
  const steps = Math.min(MAX_UNIFORM_SAMPLES, Math.ceil(total / SAMPLE_SPACING))
  for (let index = 1; index < steps; index += 1) {
    boundaries.add(total * index / steps)
  }

  const distances = [...boundaries].sort((left, right) => left - right)
  const segments: PassThreatSegment[] = []
  for (let index = 1; index < distances.length; index += 1) {
    const startDistance = distances[index - 1]
    const endDistance = distances[index]
    if (startDistance === undefined || endDistance === undefined || endDistance - startDistance <= EPSILON) continue
    const midpoint = (startDistance + endDistance) / 2
    const classification = classifyPoint(
      compiled.pointAtDistance(midpoint),
      midpoint,
      passerTeam,
      frame,
      rules,
    )
    const start = boundaryPoints.get(startDistance) ?? compiled.pointAtDistance(startDistance)
    const end = boundaryPoints.get(endDistance) ?? compiled.pointAtDistance(endDistance)
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
  // A homing flight may use its entire budget without contact. Its endpoint
  // is a drop, but no imaginary path beyond that endpoint exists.
  if (flightOutcome === 'dropped' && segments.at(-1)?.level !== 'drop') {
    const end = compiled.pointAtDistance(total)
    segments.push({ level: 'drop', path: [end, { ...end }], startDistance: total, endDistance: total, opponentIds: [] })
  }
  return segments
}

/** Bounded offset ribbon that follows the actual risk-route bends, not its chord. */
export function buildPassCorridor(path: Vec2[], rules: RuleSetV1): Vec2[] {
  const compiled = compilePath(path)
  const startDistance = rules.passing.safeDistance
  const endDistance = Math.min(compiled.length, rules.passing.maxDistance)
  if (endDistance - startDistance <= EPSILON) return []
  const distances = new Set([startDistance, endDistance])
  let cumulative = 0
  for (let index = 1; index < path.length; index += 1) {
    cumulative += distance(path[index - 1]!, path[index]!)
    if (cumulative > startDistance && cumulative < endDistance) distances.add(cumulative)
  }
  const samples = [...distances].sort((a, b) => a - b).map((at) => ({ at, point: compiled.pointAtDistance(at) }))
  const left: Vec2[] = []
  const right: Vec2[] = []
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!
    const previous = samples[Math.max(0, index - 1)]!.point
    const next = samples[Math.min(samples.length - 1, index + 1)]!.point
    const dx = next.x - previous.x
    const dy = next.y - previous.y
    const span = Math.hypot(dx, dy) || 1
    const width = corridorWidth(sample.at, rules)
    const offset = { x: -dy / span * width, y: dx / span * width }
    left.push({ x: sample.point.x + offset.x, y: sample.point.y + offset.y })
    right.push({ x: sample.point.x - offset.x, y: sample.point.y - offset.y })
  }
  return [...left, ...right.reverse()]
}

export function highestPassThreat(segments: PassThreatSegment[]): PassThreatLevel {
  return segments.reduce<PassThreatLevel>((highest, segment) => (
    PASS_THREAT_ORDER.indexOf(segment.level) > PASS_THREAT_ORDER.indexOf(highest)
      ? segment.level
      : highest
  ), 'safe')
}
