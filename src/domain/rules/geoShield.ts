import { compilePath } from '../geometry/compiledPath'
import { distance, distanceToSegment } from '../geometry/geometry'
import type { LoosePassAction, PassAction, PlayerState, ProjectedFrame, RuleSetV1, ShootAction, TacticDocumentV1, Vec2 } from '../model/types'
import { deceleratingDistance, deceleratingTime, passTimeForDistance } from '../timeline/durations'
import { projectFrameAtKeyframe } from '../timeline/projectFrame'
import { circleSegmentCuts, fixedQPreRunDistance } from './geoShieldGeometry'
import { loosePassingRule } from './loosePassing'

const EPSILON = 1e-9
const MAX_UNIFORM_SAMPLES = 512
const MAX_ACTION_ENTRIES = 128

export const GEO_SHIELD_LABELS = {
  inPlace: '岩原地护罩',
  reachable: '岩跑动 / Q 护罩',
} as const

export interface GeoShieldSegment {
  kind: 'inPlace' | 'reachable'
  path: Vec2[]
  startDistance: number
  endDistance: number
  opponentIds: string[]
}

export interface GeoShieldShotEvaluation {
  defenderId: string
  defenderName: string
  earliestTime: number
  mode: 'inPlace' | 'direct' | 'q'
}

export interface GeoShieldAnalysis {
  passSegments: GeoShieldSegment[]
  shot: GeoShieldShotEvaluation | null
}

export interface GeoShieldReach {
  earliestTime: number
  directTime: number
  qTime: number
  mode: GeoShieldShotEvaluation['mode']
}

interface DefenderContext {
  player: PlayerState
  radius: number
  frozenDelay: number
  qReady: number
  runDuringCooldown: number
  speed: number
  rule: RuleSetV1['roles']['geo']
  field: RuleSetV1['field']
}

function defenderContext(frame: ProjectedFrame, player: PlayerState, rules: RuleSetV1): DefenderContext | null {
  const rule = rules.roles[player.role]
  if (player.role !== 'geo' || !rule.shield) return null
  const frozenDelay = frame.statuses.reduce((delay, status) => (
    status.playerId === player.id && status.kind === 'frozen'
      && status.startsAt <= frame.time && status.endsAt > frame.time
      ? Math.max(delay, status.endsAt - frame.time) : delay
  ), 0)
  const qReady = Math.max(frozenDelay, frame.cooldowns[player.id]?.q ?? 0, 0)
  const speed = Math.max(EPSILON, rules.field.baseMoveSpeed)
  return {
    player, radius: rule.shield.radius, frozenDelay, qReady, speed, rule, field: rules.field,
    runDuringCooldown: (qReady - frozenDelay) * speed,
  }
}

function segmentReach(context: DefenderContext, start: Vec2, end: Vec2): GeoShieldReach {
  const { player, radius, speed, rule, frozenDelay, qReady, runDuringCooldown, field } = context
  const gap = distanceToSegment(player.position, start, end)
  if (gap <= radius + EPSILON) return { earliestTime: 0, directTime: 0, qTime: 0, mode: 'inPlace' }
  const directTime = frozenDelay + (gap - radius) / speed
  const preRun = rule.q.fixedDistance
    ? fixedQPreRunDistance(player.position, start, end, radius, rule.q.maxDistance, field)
    : Math.max(0, gap - radius - rule.q.maxDistance)
  // Cooldown may elapse during the launch-position run, but the completed
  // Q itself must land with its shield on the route; no walking back after Q.
  const qTime = qReady + rule.q.duration + Math.max(0, preRun - runDuringCooldown) / speed
  return directTime <= qTime
    ? { earliestTime: directTime, directTime, qTime, mode: 'direct' }
    : { earliestTime: qTime, directTime, qTime, mode: 'q' }
}

/** Pure launch-frame estimate against a point or the union of finite segments. */
export function evaluateGeoShieldReach(
  frame: ProjectedFrame, defender: PlayerState, path: readonly Vec2[], rules: RuleSetV1,
): GeoShieldReach | null {
  const context = defenderContext(frame, defender, rules)
  if (!context || path.length === 0) return null
  let directTime = Infinity
  let qTime = Infinity
  for (let index = 0; index < Math.max(1, path.length - 1); index += 1) {
    const candidate = segmentReach(context, path[index]!, path[index + 1] ?? path[index]!)
    if (candidate.mode === 'inPlace') return candidate
    directTime = Math.min(directTime, candidate.directTime)
    qTime = Math.min(qTime, candidate.qTime)
  }
  return directTime <= qTime
    ? { earliestTime: directTime, directTime, qTime, mode: 'direct' }
    : { earliestTime: qTime, directTime, qTime, mode: 'q' }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function classifyPoint(point: Vec2, arrival: number, defenders: DefenderContext[]) {
  let kind: GeoShieldSegment['kind'] | null = null
  const opponentIds: string[] = []
  for (const defender of defenders) {
    const reach = segmentReach(defender, point, point)
    if (reach.earliestTime > arrival + EPSILON) continue
    opponentIds.push(defender.player.id)
    if (reach.mode === 'inPlace') kind = 'inPlace'
    else kind ??= 'reachable'
  }
  return { kind, opponentIds }
}

function scanPass(
  action: PassAction | LoosePassAction, path: Vec2[], defenders: DefenderContext[], rules: RuleSetV1,
): GeoShieldSegment[] {
  const compiled = compilePath(path)
  const loose = loosePassingRule(rules)
  const maximum = action.type === 'pass' ? rules.passing.maxDistance : loose.maxDistance
  const flownAtEnd = action.type === 'pass'
    ? maximum
    : deceleratingDistance(action.duration, loose.maxDistance, loose.maxDuration)
  const total = Math.min(compiled.length, maximum, flownAtEnd)
  if (path.length < 2 || total <= EPSILON) return []
  // Ordinary projection scales the calibrated deceleration curve to the
  // authoritative saved duration. Loose flights retain their own 6/3 (or
  // customized) curve and cap elapsed time at pickup/landing.
  const calibratedDuration = passTimeForDistance(total, rules)
  const arrivalAt = action.type === 'pass'
    ? (at: number) => action.duration * passTimeForDistance(at, rules) / Math.max(EPSILON, calibratedDuration)
    : (at: number) => deceleratingTime(at, loose.maxDistance, loose.maxDuration)
  const cuts = new Set([0, total])
  const vertices = new Map<number, Vec2>([[0, path[0]!]])
  let traversed = 0
  for (let index = 1; index < path.length && traversed < total; index += 1) {
    const start = path[index - 1]!
    const end = path[index]!
    const length = distance(start, end)
    for (const defender of defenders) {
      for (const ratio of circleSegmentCuts(defender.player.position, defender.radius, start, end)) {
        const at = traversed + length * ratio
        if (at >= 0 && at <= total) cuts.add(at)
      }
    }
    traversed += length
    if (traversed <= total) {
      cuts.add(traversed)
      vertices.set(traversed, end)
    }
  }
  const steps = Math.min(MAX_UNIFORM_SAMPLES, Math.ceil(total / 0.1))
  for (let index = 1; index < steps; index += 1) cuts.add(total * index / steps)
  const distances: number[] = []
  for (const at of [...cuts].sort((left, right) => left - right)) {
    const previous = distances.at(-1)
    if (previous === undefined || at - previous > EPSILON) distances.push(at)
    else if (vertices.has(at) || at === total) distances[distances.length - 1] = at
  }
  const pointAt = (at: number) => ({ ...(vertices.get(at) ?? compiled.pointAtDistance(at)) })
  const segments: GeoShieldSegment[] = []
  const append = (kind: GeoShieldSegment['kind'], from: number, to: number, opponentIds: string[]) => {
    const previous = segments.at(-1)
    if (previous?.kind === kind && previous.endDistance === from) {
      previous.endDistance = to
      previous.path.push(pointAt(to))
      previous.opponentIds = [...new Set([...previous.opponentIds, ...opponentIds])].sort(compareIds)
    } else segments.push({ kind, startDistance: from, endDistance: to, path: [pointAt(from), pointAt(to)], opponentIds: [...opponentIds] })
  }
  // Endpoint checks preserve a tangent or equality at the exact flight end as
  // a point interval; they never paint the neighboring safe interval blue.
  for (let index = 0; index < distances.length; index += 1) {
    const at = distances[index]!
    const endpoint = classifyPoint(pointAt(at), arrivalAt(at), defenders)
    if (endpoint.kind) append(endpoint.kind, at, at, endpoint.opponentIds)
    const next = distances[index + 1]
    if (next === undefined || next - at <= EPSILON) continue
    const midpoint = (at + next) / 2
    const middle = classifyPoint(compiled.pointAtDistance(midpoint), arrivalAt(midpoint), defenders)
    if (middle.kind) append(middle.kind, at, next, middle.opponentIds)
  }
  return segments
}

interface CacheEntry { signature: string; actions: Map<string, GeoShieldAnalysis> }
const analysisCache = new WeakMap<TacticDocumentV1, CacheEntry>()

function cloneAnalysis(result: GeoShieldAnalysis): GeoShieldAnalysis {
  return {
    shot: result.shot ? { ...result.shot } : null,
    passSegments: result.passSegments.map((segment) => ({
      ...segment, path: segment.path.map((point) => ({ ...point })), opponentIds: [...segment.opponentIds],
    })),
  }
}

/** Cached static advisory data; never resolves or authors hypothetical flights. */
export function analyzeActionGeoShield(
  document: TacticDocumentV1, action: PassAction | LoosePassAction | ShootAction, path: Vec2[] = action.path,
): GeoShieldAnalysis {
  if (action.type === 'shoot' && action.charge === 'red') return { passSegments: [], shot: null }
  const actor = document.initialScene.players.find((player) => player.id === action.actorId)
  if (!actor || !document.initialScene.players.some((player) => (
    player.team !== actor.team && player.role === 'geo' && document.rulesSnapshot.roles.geo.shield
  ))) return { passSegments: [], shot: null }
  // In-place draft mutations are real edits. Validate once per action call,
  // never inside the route/defender sample loops; metadata is irrelevant.
  const signature = JSON.stringify([document.rulesSnapshot, document.initialScene, document.actions])
  let cache = analysisCache.get(document)
  if (!cache || cache.signature !== signature) {
    cache = { signature, actions: new Map() }
    analysisCache.set(document, cache)
  }
  const key = JSON.stringify([action, path])
  const cached = cache.actions.get(key)
  if (cached) return cloneAnalysis(cached)
  const frame = projectFrameAtKeyframe(document, action.startTime, action.type === 'shoot' ? null : action.originKeyframe ?? null)
  const defenders = frame.players
    .filter((player) => player.team !== actor.team)
    .map((player) => defenderContext(frame, player, document.rulesSnapshot))
    .filter((context): context is DefenderContext => context !== null)
    .sort((left, right) => compareIds(left.player.id, right.player.id))
  const result: GeoShieldAnalysis = { passSegments: [], shot: null }
  if (action.type === 'shoot') {
    for (const defender of defenders) {
      for (let index = 0; index < Math.max(1, path.length - 1); index += 1) {
        const start = path[index]
        if (!start) continue
        const reach = segmentReach(defender, start, path[index + 1] ?? start)
        if (reach.earliestTime < 2 && (!result.shot || reach.earliestTime < result.shot.earliestTime
          || (reach.earliestTime === result.shot.earliestTime && reach.mode === 'inPlace' && result.shot.defenderId === defender.player.id))) {
          result.shot = { defenderId: defender.player.id, defenderName: defender.player.name, earliestTime: reach.earliestTime, mode: reach.mode }
        }
      }
    }
  } else result.passSegments = scanPass(action, path, defenders, document.rulesSnapshot)
  if (cache.actions.size >= MAX_ACTION_ENTRIES) cache.actions.delete(cache.actions.keys().next().value!)
  cache.actions.set(key, result)
  return cloneAnalysis(result)
}

export function geoShieldPassSummary(segments: readonly GeoShieldSegment[], players: readonly PlayerState[]): string {
  return (['inPlace', 'reachable'] as const).flatMap((kind) => {
    const ids = [...new Set(segments.filter((segment) => segment.kind === kind).flatMap((segment) => segment.opponentIds))].sort(compareIds)
    return ids.length ? [`${GEO_SHIELD_LABELS[kind]} · ${ids.map((id) => players.find((player) => player.id === id)?.name ?? id).join('、')}`] : []
  }).join('；')
}

export function geoShieldShotSummary(evaluation: GeoShieldShotEvaluation): string {
  const seconds = evaluation.earliestTime.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
  const mode = evaluation.mode === 'inPlace' ? '原地护罩' : evaluation.mode === 'direct' ? '直跑护罩' : 'Q 护罩'
  return `岩最早挡球 ${seconds}s · ${evaluation.defenderName} ${mode}`
}
