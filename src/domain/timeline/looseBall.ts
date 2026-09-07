import { compilePath } from '../geometry/compiledPath'
import { ballCausalRanks } from './ballCausalOrder'
import { ballActionIsEffective, ballPossessionHistory } from './ballPossession'
export { receptionOriginAt } from './ballPossession'
import { closestPointOnPath, distance, resolveQPath, resolvedMovePath, truncatePath } from '../geometry/geometry'
import { passIsReceived } from '../model/passFlight'
import type { BallTargetReference, LoosePassAction, MoveAction, PassAction, QMoveAction, ReceiveAction, TacticAction, TacticDocumentV1, Vec2 } from '../model/types'
import { actionEndTime, deceleratingDistance, movementDuration, passPathProgress } from './durations'
import { loosePassingRule, loosePassJointTimes, resolveLoosePass } from './loosePass'
import { validateQStart } from '../rules/qCooldown'
import { instantQActionAtKeyframe } from './playerKeyframes'
import { solvePassReception } from './passReception'
import { createMovementBudgetReader, createPlayerPositionReader, documentFreezeWindows, effectiveQPath, projectFrame, projectPlayerPosition } from './projectFrame'

const CONTACT = 1e-5
export const MAX_PICKUP_TRACE_POINTS = 2048
export interface PickupDiagnostic { actionId: string; message: string }
export interface BallEpisode {
  sourceActionId: string | null
  startTime: number
  endTime: number
  availableUntil: number
  positionAt(time: number): Vec2
}
type PickupAction = MoveAction | QMoveAction
const isPickup = (action: TacticAction): action is PickupAction => (action.type === 'move' || action.type === 'qMove') && !!action.ballTarget

function projectionWithoutPickupEffects(document: TacticDocumentV1, actionId?: string): TacticDocumentV1 {
  return { ...document, actions: document.actions.filter((action) => action.id !== actionId
    && !(action.type === 'receive' && action.pickupActionId === actionId)) }
}

function episodeForSource(document: TacticDocumentV1, sourceId: string | null): BallEpisode | undefined {
  const source = document.actions.find((action) => action.id === sourceId)
  if (sourceId !== null && !source) return undefined
  const history = ballPossessionHistory(document)
  const invalid = history.invalidActionIds
  if (source && invalid.has(source.id)) return undefined
  let startTime = 0
  let endTime = 0
  let positionAt: BallEpisode['positionAt'] = () => ({ ...document.initialScene.ball.position })
  let availableUntil = Infinity
  if (!source) {
    if (!document.initialScene.ball.isFree) return undefined
  } else if (source.type === 'loosePass') {
    const curve = loosePassingRule(document.rulesSnapshot)
    const route = compilePath(source.path)
    startTime = source.startTime
    endTime = actionEndTime(source)
    positionAt = (time) => route.pointAtDistance(deceleratingDistance(Math.min(time - source.startTime, source.duration), curve.maxDistance, curve.maxDuration))
    if (source.flightOutcome === 'goal') availableUntil = endTime
  } else if (source.type === 'pass') {
    if (passIsReceived(source, document.rulesSnapshot)) return undefined
    const route = compilePath(source.path)
    startTime = source.targetPlayerId ? actionEndTime(source) : source.startTime
    endTime = actionEndTime(source)
    positionAt = (time) => route.pointAtDistance(passPathProgress(source.path, time - source.startTime, source.duration, document.rulesSnapshot, route.length) * route.length)
  } else if (source.type === 'possession') {
    startTime = endTime = source.startTime
    positionAt = () => ({ ...source.position })
  } else return undefined
  for (const shotEnd of history.shotReleaseTimes) if (shotEnd > startTime) availableUntil = Math.min(availableUntil, shotEnd)
  for (const next of document.actions) {
    if (next.id === sourceId || next.startTime < startTime) continue
    if (invalid.has(next.id)) continue
    if ((next.type === 'pass' || next.type === 'loosePass') && next.originPickupActionId) {
      const pickup = document.actions.find((candidate) => candidate.id === next.originPickupActionId)
      if (pickup && isPickup(pickup) && pickup.ballTarget!.sourceActionId === sourceId) continue
    }
    if (next.type === 'receive' && next.sourceActionId) {
      const flight = document.actions.find((candidate) => candidate.id === next.sourceActionId)
      if (flight?.type === 'pass' && flight.originPickupActionId) continue
    }
    if ((next.type === 'pass' || next.type === 'loosePass' || next.type === 'possession'
      || (next.type === 'receive' && !next.pickupActionId)) && next.startTime > startTime) {
      availableUntil = Math.min(availableUntil, next.startTime)
    }
  }
  return { sourceActionId: sourceId, startTime, endTime, availableUntil, positionAt }
}

/** Read-only episode lookup. No flight or pursuit solver runs on playhead reads. */
export function ballEpisodeAt(document: TacticDocumentV1, time: number): BallEpisode | undefined {
  if (!projectFrame(document, time).ball.isFree) return undefined
  const id = ballEpisodeSourceIdAt(document, time)
  if (id === undefined) return undefined
  const episode = episodeForSource(document, id)
  return episode && time >= episode.startTime && time < episode.availableUntil ? episode : undefined
}

/** Lightweight source metadata only; caller can use its existing projected frame. */
export function ballEpisodeSourceIdAt(document: TacticDocumentV1, time: number): string | null | undefined {
  const ranks = ballCausalRanks(document.actions)
  const history = ballPossessionHistory(document)
  const invalid = history.invalidActionIds
  let latest: TacticAction | undefined
  for (const action of document.actions) {
    if (invalid.has(action.id)) continue
    if ((action.type === 'loosePass' || action.type === 'pass' || action.type === 'possession')
      && action.startTime <= time && (!latest || action.startTime > latest.startTime
        || action.startTime === latest.startTime && (ranks.get(action.id) ?? 0) >= (ranks.get(latest.id) ?? 0))) latest = action
  }
  if (history.shotReleaseTimes.some((end) => end <= time && (!latest || end > latest.startTime))) return undefined
  if (!latest) return document.initialScene.ball.isFree ? null : undefined
  if (latest.type === 'loosePass' && latest.flightOutcome === 'goal' && actionEndTime(latest) <= time) return undefined
  if (latest.type === 'pass' && (passIsReceived(latest, document.rulesSnapshot) || latest.targetPlayerId && actionEndTime(latest) > time)) return undefined
  return latest.id
}

function contactFraction(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2, tolerance = CONTACT): number | undefined {
  const dx = (a1.x - a0.x) - (b1.x - b0.x)
  const dy = (a1.y - a0.y) - (b1.y - b0.y)
  const rx = a0.x - b0.x
  const ry = a0.y - b0.y
  const square = dx * dx + dy * dy
  const fraction = square <= 1e-18 ? 0 : Math.max(0, Math.min(1, -(rx * dx + ry * dy) / square))
  return Math.hypot(rx + dx * fraction, ry + dy * fraction) <= tolerance ? fraction : undefined
}

function resolveRunPickup(document: TacticDocumentV1, action: MoveAction, episode: BallEpisode): number | undefined {
  const context = projectionWithoutPickupEffects(document, action.id)
  const origin = projectPlayerPosition(context, action.actorId, action.startTime)
  if (!origin) return undefined
  const horizon = Math.min(episode.availableUntil, Math.max(action.startTime, episode.endTime) + 120)
  const probe: MoveAction = { ...action, duration: horizon - action.startTime, path: [origin, episode.positionAt(horizon)], pickupTrace: undefined }
  const budgetAt = createMovementBudgetReader(context, probe)
  const freeze = documentFreezeWindows(context, action.actorId).find((window) => window.endsAt > action.startTime && window.startsAt < horizon)
  const end = Math.min(horizon, freeze?.startsAt ?? Infinity)
  let position = { ...origin }
  const trace = [{ time: action.startTime, position: { ...position } }]
  if (distance(position, episode.positionAt(action.startTime)) <= CONTACT) {
    action.path = [origin, { ...origin }]; action.duration = 0; action.pickupTrace = trace
    return action.startTime
  }
  let time = action.startTime
  // Fixed 25 ms integration while flying, coarser 100 ms after rest; bounded even for pathological rules.
  while (time < end && trace.length < MAX_PICKUP_TRACE_POINTS) {
    const next = Math.min(end, time + (time < episode.endTime ? 0.025 : 0.1), time < episode.endTime ? episode.endTime : Infinity)
    const ballStart = episode.positionAt(time)
    const ballEnd = episode.positionAt(next)
    const gap = distance(position, ballEnd)
    const budget = budgetAt(position, time, next)
    const advance = Math.min(gap, budget)
    const destination = gap > 1e-12 ? { x: position.x + (ballEnd.x - position.x) * advance / gap, y: position.y + (ballEnd.y - position.y) * advance / gap } : { ...position }
    let fraction = contactFraction(position, destination, ballStart, ballEnd)
    if (time >= episode.endTime && gap <= budget && budget > 0) fraction = gap / budget
    if (fraction !== undefined) {
      const catchTime = time + (next - time) * fraction
      if (catchTime >= episode.availableUntil || catchTime >= end && !!freeze) return undefined
      const catchPoint = episode.positionAt(catchTime)
      trace.push({ time: catchTime, position: catchPoint })
      action.duration = catchTime - action.startTime
      action.path = [{ ...origin }, { ...catchPoint }]
      action.pickupTrace = trace
      return catchTime
    }
    trace.push({ time: next, position: destination })
    position = destination
    time = next
  }
  return undefined
}

function resolveQPickup(document: TacticDocumentV1, action: QMoveAction, episode: BallEpisode): number | undefined {
  if (!validateQStart(document, action.actorId, action.startTime, action.id).valid) return undefined
  const context = projectionWithoutPickupEffects(document, action.id)
  context.actions = [...context.actions, action]
  const freezes = documentFreezeWindows(context, action.actorId)
  if (freezes.some((window) => window.startsAt <= action.startTime && window.endsAt > action.startTime)) return undefined
  if (action.duration <= 1e-6) {
    const nearest = closestPointOnPath(episode.positionAt(action.startTime), effectiveQPath(context, action))
    return nearest && nearest.distance <= CONTACT ? action.startTime : undefined
  }
  const read = createPlayerPositionReader(context, action.actorId)
  const end = Math.min(actionEndTime(action), episode.availableUntil,
    freezes.find((window) => window.startsAt > action.startTime)?.startsAt ?? Infinity)
  let previousTime = action.startTime
  let previous = read(previousTime)
  if (!previous) return undefined
  const flight = document.actions.find((candidate) => candidate.id === episode.sourceActionId)
  const cuts = new Set(Array.from({ length: 256 }, (_, index) => action.startTime + (end - action.startTime) * (index + 1) / 256))
  if (flight?.type === 'loosePass') for (const time of loosePassJointTimes(flight, document.rulesSnapshot)) if (time > action.startTime && time < end) cuts.add(time)
  const route = effectiveQPath(context, action)
  const routeLength = compilePath(route).length
  let traveled = 0
  for (let index = 1; index < route.length - 1; index += 1) {
    traveled += distance(route[index - 1]!, route[index]!)
    const time = action.startTime + action.duration * traveled / Math.max(routeLength, 1e-9)
    if (time > action.startTime && time < end) cuts.add(time)
  }
  const curve = flight?.type === 'loosePass' ? loosePassingRule(document.rulesSnapshot) : undefined
  const accelerationBound = curve ? 2 * curve.maxDistance / curve.maxDuration ** 2
    : flight?.type === 'pass' ? 2 * document.rulesSnapshot.passing.maxDistance / Math.max(flight.duration, 1e-6) ** 2 : 0
  for (const time of [...cuts].sort((a, b) => a - b)) {
    const position = read(time)
    if (!position) return undefined
    // On each bounce/route segment, the ball's deviation from its chord is
    // bounded by a*dt²/8. Refine only near-contact intervals, not every sample.
    const tolerance = CONTACT + accelerationBound * (time - previousTime) ** 2 / 8
    const fraction = contactFraction(previous, position, episode.positionAt(previousTime), episode.positionAt(time), tolerance)
    if (fraction !== undefined) {
      const separation = (at: number) => distance(read(at)!, episode.positionAt(at))
      let low = previousTime, high = time
      for (let iteration = 0; iteration < 32; iteration += 1) {
        const left = low + (high - low) / 3
        const right = high - (high - low) / 3
        if (separation(left) <= separation(right)) high = right
        else low = left
      }
      const contact = [previousTime, (low + high) / 2, time].reduce((best, candidate) => separation(candidate) < separation(best) ? candidate : best)
      if (contact < episode.availableUntil && !freezes.some((window) => window.startsAt <= contact && window.endsAt > contact)
        && separation(contact) <= CONTACT) return contact
    }
    previousTime = time
    previous = position
  }
  return undefined
}

export function createBallPickupAction(document: TacticDocumentV1, actorId: string, startTime: number, kind: 'move' | 'qMove', actionId: string):
  { ok: true; action: PickupAction } | { ok: false; message: string } {
  const episode = ballEpisodeAt(document, startTime)
  if (!episode) return { ok: false, message: '当前没有可以捡起的自由球；传给队友的飞行中球不能直接捡取。' }
  const actor = projectFrame(document, startTime).players.find((player) => player.id === actorId)
  if (!actor) return { ok: false, message: '请选择捡球球员。' }
  const ballTarget: BallTargetReference = { sourceActionId: episode.sourceActionId }
  if (kind === 'move') {
    const action: MoveAction = { id: actionId, type: 'move', actorId, startTime, duration: 0, path: [actor.position, episode.positionAt(startTime)], ballTarget }
    const caught = resolveRunPickup(document, action, episode)
    return caught === undefined ? { ok: false, message: '无法在当前动作和冻结限制下跑动捡球。' } : { ok: true, action }
  }
  const q = document.rulesSnapshot.roles[actor.role].q
  let intercept = startTime
  if (q.duration > 1e-6) {
    const f = (elapsed: number) => distance(actor.position, episode.positionAt(startTime + elapsed)) - q.maxDistance * elapsed / q.duration
    let previous = 0
    let found = false
    for (let index = 1; index <= 128; index += 1) {
      const elapsed = q.duration * index / 128
      if (f(elapsed) <= 0) {
        let low = previous, high = elapsed
        for (let iteration = 0; iteration < 36; iteration += 1) { const middle = (low + high) / 2; if (f(middle) > 0) low = middle; else high = middle }
        intercept = startTime + high
        found = true
        break
      }
      previous = elapsed
    }
    if (!found) return { ok: false, message: '无法用此次 Q 捡到球：球超出 Q 的可达范围。' }
  }
  const target = episode.positionAt(intercept)
  const path = resolveQPath([actor.position, target], q.maxDistance, true, document.rulesSnapshot.field.width, document.rulesSnapshot.field.height)
  const action: QMoveAction = { id: actionId, type: 'qMove', actorId, startTime, duration: q.duration, path, ballTarget }
  return resolveQPickup(document, action, episode) === undefined
    ? { ok: false, message: '无法用此次 Q 捡到球：Q 路径必须在同一时刻穿过球。' }
    : { ok: true, action }
}

function receiptId(document: TacticDocumentV1, base: string): string {
  let id = base.slice(0, 110)
  let suffix = 1
  while (document.actions.some((action) => action.id === id)) id = `${base.slice(0, 106)}-${suffix++}`
  return id
}

/** Exact old catch joints carry intent. Recover the historical loose-pass
 * integration drift only when removing its numerical cut reproduces the saved
 * launch, with a unique source and matching launch position. */
function bindExistingReceptionOrigins(document: TacticDocumentV1): void {
  for (const action of document.actions) {
    if ((action.type !== 'pass' && action.type !== 'loosePass') || action.originReception
      || action.originPickupActionId || action.originKeyframe) continue
    const sources = document.actions.filter((source): source is PassAction => source.type === 'pass'
      && source.id !== action.id && source.targetPlayerId === action.actorId
      && passIsReceived(source, document.rulesSnapshot) && source.startTime <= action.startTime)
    const exact = sources.filter((source) => actionEndTime(source) === action.startTime)
    if (exact.length === 1) {
      action.originReception = { sourceActionId: exact[0]!.id, offset: 0 }
      continue
    }
    if (action.type !== 'loosePass' || !/^loose-pass-[\da-f-]{36}$/i.test(action.id)) continue
    const near = sources.filter((source) => actionEndTime(source) > action.startTime
      && actionEndTime(source) - action.startTime < 0.001
      && document.actions.some((receipt) => receipt.type === 'receive' && receipt.sourceActionId === source.id
        && receipt.startTime === actionEndTime(source)))
    if (near.length !== 1) continue
    const source = near[0]!
    const resolution = solvePassReception(document, source)
    if (resolution.received && Math.abs(resolution.arrivalTime - action.startTime) < 1e-6
      && distance(resolution.path.at(-1)!, action.path[0]!) < 0.001) {
      action.originReception = { sourceActionId: source.id, offset: 0 }
    }
  }
}

export function normalizeBallActions(document: TacticDocumentV1): { invalidPickups: PickupDiagnostic[] } {
  const invalidPickups: PickupDiagnostic[] = []
  bindExistingReceptionOrigins(document)
  const oldPickups = new Map(document.actions.filter((action): action is ReceiveAction => action.type === 'receive' && !!action.pickupActionId)
    .map((action) => [action.pickupActionId!, action]))
  document.actions = document.actions.filter((action) => action.type !== 'receive' || !action.pickupActionId)
  const pickups = document.actions.filter(isPickup)
  const launches = document.actions.filter((action): action is PassAction | LoosePassAction => action.type === 'pass' || action.type === 'loosePass')
  for (const action of launches) if (action.originKeyframe) {
    const source = instantQActionAtKeyframe(document, action.originKeyframe)
    if (source && source.actorId === action.actorId) action.startTime = source.startTime
    else delete action.originKeyframe
  }
  const resolvedEpisodes = new Set<string | null>()
  const resolvePickups = (sourceId: string | null) => {
    if (resolvedEpisodes.has(sourceId)) return
    resolvedEpisodes.add(sourceId)
    const episode = episodeForSource(document, sourceId)
    const contenders = pickups.filter((action) => action.ballTarget?.sourceActionId === sourceId)
    const candidates: Array<{ action: PickupAction; time: number }> = []
    for (const action of contenders) {
      const oldEnd = actionEndTime(action)
      const valid = episode && action.startTime >= episode.startTime && action.startTime < episode.availableUntil
      const time = valid ? (action.type === 'move' ? resolveRunPickup(document, action, episode) : resolveQPickup(document, action, episode)) : undefined
      if (time === undefined) {
        if (action.type === 'move') delete action.pickupTrace
        invalidPickups.push({ actionId: action.id, message: action.type === 'qMove' ? '无法用此次 Q 捡到球。' : '无法完成跑动捡球，球源或控制状态已改变。' })
      } else {
        if (action.type === 'move') rebasePickupContinuation(document, action, oldEnd)
        candidates.push({ action, time })
      }
    }
    candidates.sort((a, b) => a.time - b.time)
    const winner = candidates[0]
    if (!winner) return
    if (candidates[1] && Math.abs(candidates[1].time - winner.time) <= 1e-6) {
      for (const candidate of candidates) invalidPickups.push({ actionId: candidate.action.id, message: '双方同时接触球，无法自动决定球权；请调整捡球时刻。' })
      return
    }
    const previous = oldPickups.get(winner.action.id)
    document.actions.push({ id: previous?.id ?? receiptId(document, `pickup-${winner.action.id}`), type: 'receive', actorId: winner.action.actorId,
      startTime: winner.time, duration: 0, pickupActionId: winner.action.id, ballSourceActionId: sourceId })
    const flight = document.actions.find((action) => action.id === sourceId)
    if (flight?.type === 'loosePass' && winner.time < actionEndTime(flight)) {
      const curve = loosePassingRule(document.rulesSnapshot)
      flight.path = truncatePath(flight.path, deceleratingDistance(winner.time - flight.startTime, curve.maxDistance, curve.maxDuration))
      if (flight.path.length === 1) flight.path.push({ ...flight.path[0]! })
      flight.duration = winner.time - flight.startTime
      flight.flightOutcome = 'pickedUp'
    }
    for (const loser of candidates.slice(1)) invalidPickups.push({ actionId: loser.action.id, message: '球已被其他球员提前捡起。' })
  }
  resolvePickups(null)
  for (const possession of document.actions.filter((action) => action.type === 'possession')) resolvePickups(possession.id)
  const pending = new Set(launches)
  const blocked = new Set<string>()
  while (pending.size) {
    const ready = [...pending].filter((action) => action.originReception
      ? ![...pending].some((source) => source.id === action.originReception!.sourceActionId)
        && !blocked.has(action.originReception.sourceActionId)
        && document.actions.some((receive) => receive.type === 'receive' && receive.sourceActionId === action.originReception!.sourceActionId)
      : !action.originPickupActionId
        || document.actions.some((receive) => receive.type === 'receive' && receive.pickupActionId === action.originPickupActionId))
    if (!ready.length) break
    for (const action of ready) {
      const receive = document.actions.find((candidate) => candidate.type === 'receive' && (
        action.originReception ? candidate.sourceActionId === action.originReception.sourceActionId
          : action.originPickupActionId && candidate.pickupActionId === action.originPickupActionId))
      if (receive) action.startTime = receive.startTime + (action.originReception?.offset ?? 0)
    }
    const ranks = ballCausalRanks(document.actions)
    ready.sort((a, b) => a.startTime - b.startTime || (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0) || a.id.localeCompare(b.id))
    const action = ready[0]!
    pending.delete(action)
    if (!ballActionIsEffective(document, action.id)) {
      blocked.add(action.id)
      if (action.type === 'pass' && action.targetPlayerId) action.flightOutcome = 'dropped'
      document.actions = document.actions.filter((candidate) => candidate.type !== 'receive' || candidate.sourceActionId !== action.id)
      invalidPickups.push({ actionId: action.id, message: '出球时球员未持球，或来源接球后的球权已经结束。' })
      continue
    }
    if (action.type === 'loosePass') {
      document.rulesSnapshot.loosePassing ??= { ...loosePassingRule(document.rulesSnapshot) }
      try { Object.assign(action, resolveLoosePass(document, action)) }
      catch (error) { invalidPickups.push({ actionId: action.id, message: error instanceof Error ? error.message : '无法解算空传。' }) }
    } else {
      const resolution = solvePassReception(document, action)
      action.path = resolution.path
      action.duration = resolution.duration
      if (action.targetPlayerId) action.flightOutcome = resolution.received ? 'received' : 'dropped'
      else delete action.flightOutcome
      const linked = document.actions.filter((candidate): candidate is ReceiveAction => candidate.type === 'receive' && candidate.sourceActionId === action.id)
      document.actions = document.actions.filter((candidate) => candidate.type !== 'receive' || candidate.sourceActionId !== action.id)
      if (resolution.received && action.targetPlayerId) document.actions.push({ id: linked[0]?.id ?? receiptId(document, `receive-${action.id}`), type: 'receive', actorId: action.targetPlayerId,
        sourceActionId: action.id, startTime: resolution.arrivalTime, duration: 0 })
    }
    resolvePickups(action.id)
  }
  for (const action of pending) {
    blocked.add(action.id)
    if (action.type === 'pass' && action.targetPlayerId) action.flightOutcome = 'dropped'
    invalidPickups.push({ actionId: action.id, message: '出球依赖的接球帧无效或形成循环。' })
  }
  document.actions = document.actions.filter((action) => action.type !== 'receive' || !action.sourceActionId || !blocked.has(action.sourceActionId))
  for (const pickup of pickups) if (!resolvedEpisodes.has(pickup.ballTarget!.sourceActionId)) {
    invalidPickups.push({ actionId: pickup.id, message: '捡球对应的自由球已不存在。' })
    if (pickup.type === 'move') delete pickup.pickupTrace
  }
  const passIds = new Set(launches.filter((action) => action.type === 'pass').map((action) => action.id))
  document.actions = document.actions.filter((action) => action.type !== 'receive' || !action.sourceActionId || passIds.has(action.sourceActionId))
  return { invalidPickups }
}

/** Only an already contiguous simple chain follows an edited pickup end.
 * Detached/advanced starts remain authored and an Ice Q still ends at its own end. */
function rebasePickupContinuation(document: TacticDocumentV1, pickup: MoveAction, previousEnd: number) {
  let oldEnd = previousEnd
  let newEnd = actionEndTime(pickup)
  let position = pickup.path.at(-1)!
  const role = document.initialScene.players.find((player) => player.id === pickup.actorId)?.role
  if (!role) return
  const following = document.actions.filter((action) => action.id !== pickup.id && 'actorId' in action && action.actorId === pickup.actorId
    && ['move', 'qMove', 'wait'].includes(action.type) && action.startTime >= previousEnd - 1e-6)
    .sort((a, b) => a.startTime - b.startTime)
  for (const action of following) {
    if (Math.abs(action.startTime - oldEnd) > 1e-6) break
    oldEnd = actionEndTime(action)
    action.startTime = newEnd
    if (action.type === 'move' || action.type === 'qMove') {
      action.path[0] = { ...position }
      if (action.type === 'qMove') {
        const q = document.rulesSnapshot.roles[role].q
        action.path = resolveQPath(action.path, q.maxDistance, q.fixedDistance, document.rulesSnapshot.field.width, document.rulesSnapshot.field.height)
      } else if (!action.timingConstraint && !action.targetPlayerId && !action.ballTarget) {
        action.duration = movementDuration(resolvedMovePath(action), document.rulesSnapshot)
      }
      position = action.path.at(-1)!
    }
    newEnd = actionEndTime(action)
  }
}

export function ballRelatedActionIds(document: TacticDocumentV1, ids: Iterable<string>): Set<string> {
  const result = new Set(ids)
  let changed = true
  while (changed) {
    changed = false
    const add = (id: string) => { if (!result.has(id)) { result.add(id); changed = true } }
    for (const action of document.actions) {
      if (action.type === 'receive') {
        if (action.pickupActionId) {
          if (result.has(action.id)) add(action.pickupActionId)
          if (result.has(action.pickupActionId) || action.ballSourceActionId && result.has(action.ballSourceActionId)) add(action.id)
        } else if (action.sourceActionId && (result.has(action.id) || result.has(action.sourceActionId))) { add(action.id); add(action.sourceActionId) }
      }
      if (isPickup(action) && action.ballTarget!.sourceActionId && result.has(action.ballTarget!.sourceActionId)) add(action.id)
      if ((action.type === 'pass' || action.type === 'loosePass') && action.originPickupActionId && result.has(action.originPickupActionId)) add(action.id)
      if ((action.type === 'pass' || action.type === 'loosePass') && action.originReception && result.has(action.originReception.sourceActionId)) add(action.id)
    }
  }
  return result
}
