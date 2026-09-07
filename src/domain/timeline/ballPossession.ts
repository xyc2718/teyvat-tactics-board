import { passIsReceived } from '../model/passFlight'
import type { ReceptionOriginReference, TacticAction, TacticDocumentV1 } from '../model/types'
import { actionEndTime } from './durations'
import { ballCausalRanks } from './ballCausalOrder'
import { createPlayerPositionReader } from './projectFrame'
import { shotOutcome } from './shotOutcome'

interface HoldingInterval {
  actorId: string
  start: number
  end: number
  sourceActionId?: string
  pickupActionId?: string
}

interface PossessionHistory {
  invalidActionIds: Set<string>
  intervals: HoldingInterval[]
  shotReleaseTimes: number[]
}

// Shot outcomes additionally depend on position/control. Ordinary ball-only
// histories retain the cheap scalar signature; neither caches per-playhead data.
const histories = new WeakMap<TacticDocumentV1, { signature: string; history: PossessionHistory }>()
const activeHistories = new WeakMap<TacticDocumentV1, PossessionHistory>()

/** Like a position reader, this scope is valid for one unchanged synchronous
 * projection session. Nested samples must not hash the whole tactic again. */
export function createBallPossessionScope(document: TacticDocumentV1) {
  const history = ballPossessionHistory(document)
  return <T>(read: () => T): T => {
    const previous = activeHistories.get(document)
    activeHistories.set(document, history)
    try { return read() }
    finally {
      if (previous) activeHistories.set(document, previous)
      else activeHistories.delete(document)
    }
  }
}

export function ballPossessionHistory(document: TacticDocumentV1): PossessionHistory {
  const active = activeHistories.get(document)
  if (active) return active
  const actions = document.actions.filter((action) => action.type === 'pass' || action.type === 'loosePass'
    || action.type === 'receive' || action.type === 'possession' || action.type === 'shoot'
    || (action.type === 'move' || action.type === 'qMove') && action.ballTarget)
  const hasShots = actions.some((action) => action.type === 'shoot')
  const metadata = (hasShots ? document.actions : actions).map((action) => {
    if (action.type === 'pass' || action.type === 'loosePass') return [action.id, action.type, action.actorId,
      action.startTime, action.duration, action.type === 'pass' ? action.targetPlayerId : null,
      action.type === 'pass' ? passIsReceived(action, document.rulesSnapshot) : null,
      action.originReception, action.originPickupActionId]
    if (action.type === 'receive') return [action.id, action.type, action.actorId, action.startTime,
      action.sourceActionId, action.pickupActionId, action.ballSourceActionId]
    if (hasShots) return action
    if (action.type === 'move' || action.type === 'qMove') return [action.id, action.type, action.actorId, action.ballTarget]
    return [action.id, action.type, action.startTime]
  })
  // Ball-flight vertices never move a player; only their outcome/timing affects
  // receive boosts. Avoid serializing a 1024-vertex flight on each position read.
  const signature = JSON.stringify(hasShots ? [document.rulesSnapshot, document.initialScene, metadata]
    : [document.initialScene.ball.carrierId, metadata])
  const cached = histories.get(document)
  if (cached?.signature === signature) return cached.history

  const ranks = ballCausalRanks(actions)
  const byId = new Map(actions.map((action) => [action.id, action]))
  const invalidActionIds = new Set<string>()
  const effectiveLaunches = new Set<string>()
  const effectivePickups = new Set<string>()
  const intervals: HoldingInterval[] = []
  const shotReleaseTimes: number[] = []
  let holding: HoldingInterval | undefined
  let episode: string | null | undefined = document.initialScene.ball.carrierId ? undefined : null
  const release = (time: number, source?: string | null) => {
    if (holding) holding.end = time
    holding = undefined
    episode = source
  }
  const receive = (actorId: string, time: number, sourceActionId?: string, pickupActionId?: string) => {
    release(time)
    holding = { actorId, start: time, end: Infinity, sourceActionId, pickupActionId }
    intervals.push(holding)
  }
  if (document.initialScene.ball.carrierId) receive(document.initialScene.ball.carrierId, 0)

  const events: Array<{ action: TacticAction; time: number; rank: number; catch: boolean }> = []
  for (const action of actions) {
    if (action.type === 'move' || action.type === 'qMove' || action.type === 'receive' && action.sourceActionId) continue
    events.push({ action, time: action.type === 'shoot' ? actionEndTime(action) : action.startTime,
      rank: ranks.get(action.id) ?? 0, catch: false })
    if (action.type === 'pass' && action.targetPlayerId && passIsReceived(action, document.rulesSnapshot)) {
      events.push({ action, time: actionEndTime(action), rank: (ranks.get(action.id) ?? 0) + 1, catch: true })
    }
  }
  events.sort((a, b) => a.time - b.time || a.rank - b.rank || a.action.id.localeCompare(b.action.id))
  for (const event of events) {
    const { action, time } = event
    if (action.type === 'pass' || action.type === 'loosePass') {
      if (event.catch) {
        if (effectiveLaunches.has(action.id) && action.type === 'pass' && action.targetPlayerId) {
          receive(action.targetPlayerId, time, action.id)
        }
        continue
      }
      const source = action.originReception
      const pickupId = action.originPickupActionId
      const guarded = action.type === 'loosePass' || source || pickupId
      if (guarded && (holding?.actorId !== action.actorId
        || source && (holding.sourceActionId !== source.sourceActionId
          || !Number.isFinite(source.offset) || source.offset < 0 || time !== holding.start + source.offset)
        || pickupId && (holding.pickupActionId !== pickupId || !effectivePickups.has(pickupId)))) {
        invalidActionIds.add(action.id)
        continue
      }
      effectiveLaunches.add(action.id)
      release(time, action.id)
    } else if (action.type === 'receive') {
      if (action.pickupActionId) {
        const pickup = byId.get(action.pickupActionId)
        if (!pickup || (pickup.type !== 'move' && pickup.type !== 'qMove') || !pickup.ballTarget
          || pickup.actorId !== action.actorId || episode !== action.ballSourceActionId
          || action.ballSourceActionId != null && invalidActionIds.has(action.ballSourceActionId)) {
          invalidActionIds.add(action.id)
          continue
        }
        effectivePickups.add(action.pickupActionId)
      }
      receive(action.actorId, time, undefined, action.pickupActionId)
    } else if (action.type === 'possession') release(time, action.id)
    else if (action.type === 'shoot' && action.path.length >= 2) {
      // Position queries must never re-enter a history containing shots. Remove
      // already-invalid launches/receipts too, so their boosts cannot move the
      // shooter or an interrupting attacker in this outcome calculation.
      const projection = { ...document, actions: document.actions.filter((candidate) => candidate.type !== 'shoot'
        && !invalidActionIds.has(candidate.id)
        && !(candidate.type === 'receive' && candidate.sourceActionId && invalidActionIds.has(candidate.sourceActionId))) }
      const readers = new Map<string, ReturnType<typeof createPlayerPositionReader>>()
      const outcome = shotOutcome(projection, action, (playerId, at) => {
        let read = readers.get(playerId)
        if (!read) { read = createPlayerPositionReader(projection, playerId); readers.set(playerId, read) }
        return read(at)
      })
      if (outcome.canComplete) { release(time); shotReleaseTimes.push(time) }
    }
  }
  for (const action of actions) if (action.type === 'receive' && action.sourceActionId
    && !effectiveLaunches.has(action.sourceActionId)) invalidActionIds.add(action.id)
  const history = { invalidActionIds, intervals, shotReleaseTimes }
  histories.set(document, { signature, history })
  return history
}

/** Metadata for the current holding interval, never a historical possession flag. */
export function receptionOriginAt(document: TacticDocumentV1, actorId: string, time: number): ReceptionOriginReference | undefined {
  const interval = [...ballPossessionHistory(document).intervals].reverse().find((candidate) => candidate.actorId === actorId
    && candidate.start <= time && time < candidate.end)
  return interval?.sourceActionId ? { sourceActionId: interval.sourceActionId, offset: time - interval.start } : undefined
}

export function ballActionIsEffective(document: TacticDocumentV1, actionId: string): boolean {
  return !ballPossessionHistory(document).invalidActionIds.has(actionId)
}
