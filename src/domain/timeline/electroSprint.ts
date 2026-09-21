import { clamp, pathLength, resolvedMovePath, slicePath, truncatePath } from '../geometry/geometry'
import type { ElectroSprintState, MoveAction, RoleRule, TacticDocumentV1 } from '../model/types'
import { passIsReceived } from '../model/passFlight'
import { actionEndTime } from './durations'
import { solveTimedMoveGeometry } from './timedMove'
import { documentFreezeWindows, projectFrame } from './projectFrame'

const EPSILON = 1e-8
export type SprintFreezeWindow = { start: number; end: number }

export function sprintSpeed(role: RoleRule): number {
  return role.sprint ? role.sprint.maxDistance / Math.max(role.sprint.maxDuration, EPSILON) : 0
}

function actorRule(document: TacticDocumentV1, actorId: string): RoleRule | undefined {
  const actor = document.initialScene.players.find((player) => player.id === actorId)
  return actor && document.rulesSnapshot.roles[actor.role]
}

/** No projection here: recursive position readers must not rebuild hit maps. */
export function sprintInterruptionTime(
  document: TacticDocumentV1, action: MoveAction, freezes: readonly SprintFreezeWindow[] = [],
): number {
  let end = actionEndTime(action)
  const consider = (time: number) => { if (time >= action.startTime && time < end) end = time }
  for (const window of freezes) if (window.end > action.startTime) consider(Math.max(action.startTime, window.start))
  for (const status of document.initialScene.statuses) {
    if (status.kind === 'frozen' && status.playerId === action.actorId && status.endsAt > action.startTime) {
      consider(Math.max(action.startTime, status.startsAt))
    }
  }
  for (const candidate of document.actions) {
    if (candidate.id === action.id) continue
    if (candidate.type === 'status' && candidate.status === 'frozen' && candidate.targetId === action.actorId
      && actionEndTime(candidate) > action.startTime) consider(Math.max(action.startTime, candidate.startTime))
    // Same-time instant Q is before E, not an interruption of the new E.
    if (candidate.type === 'qMove' && candidate.actorId === action.actorId && candidate.startTime > action.startTime) consider(candidate.startTime)
    if (candidate.type === 'receive' && candidate.actorId === action.actorId) {
      const source = candidate.sourceActionId && document.actions.find((item) => item.id === candidate.sourceActionId)
      if (!candidate.sourceActionId || (source && source.type === 'pass' && passIsReceived(source, document.rulesSnapshot))) consider(candidate.startTime)
    }
  }
  return Math.max(action.startTime, end)
}

/** Compile once at an unchanged projection boundary; all reads are O(log E). */
export function createElectroSprintStateReader(
  document: TacticDocumentV1, actorId: string, ignoreActionId?: string,
  freezes: readonly SprintFreezeWindow[] = [],
) {
  const rule = actorRule(document, actorId)?.sprint
  const intervals: Array<{ start: number; stop: number; energyBefore: number; energyAfter: number; ready: number }> = []
  const stops = new Map<string, number>()
  const zero: ElectroSprintState = { energy: 0, cooldown: 0, active: false, maxDuration: 0, maxDistance: 0 }
  if (!rule) return Object.assign(() => ({ ...zero }), { stopTime: (id: string) => stops.get(id) })
  let energy = 1
  let lastEnd = 0
  let ready = 0
  const actions = document.actions.filter((action): action is MoveAction => action.type === 'move' && !!action.sprint
    && action.actorId === actorId && action.id !== ignoreActionId)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
  for (const action of actions) {
    if (action.startTime + EPSILON < ready || action.duration <= EPSILON) { stops.set(action.id, action.startTime); continue }
    energy = clamp(energy + Math.max(0, action.startTime - lastEnd) / rule.recoveryDuration, 0, 1)
    const stop = Math.min(sprintInterruptionTime(document, action, freezes), action.startTime + energy * rule.maxDuration)
    stops.set(action.id, stop)
    const energyBefore = energy
    energy = clamp(energy - Math.max(0, stop - action.startTime) / rule.maxDuration, 0, 1)
    lastEnd = stop
    if (stop <= action.startTime + EPSILON) continue
    ready = stop + rule.cooldown
    intervals.push({ start: action.startTime, stop, energyBefore, energyAfter: energy, ready })
  }
  return Object.assign((time: number): ElectroSprintState => {
    const at = Math.max(0, time)
    let low = 0
    let high = intervals.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (intervals[middle]!.start <= at) low = middle + 1
      else high = middle
    }
    const interval = intervals[low - 1]
    const active = !!interval && at < interval.stop
    const current = interval ? active
      ? clamp(interval.energyBefore - (at - interval.start) / rule.maxDuration, 0, 1)
      : clamp(interval.energyAfter + (at - interval.stop) / rule.recoveryDuration, 0, 1) : 1
    return { energy: current, active, cooldown: interval && !active ? Math.max(0, interval.ready - at) : 0,
      maxDuration: current * rule.maxDuration, maxDistance: current * rule.maxDistance }
  }, { stopTime: (id: string) => stops.get(id) })
}

/** Scalar edit/inspection API. Full projection reuses its precompiled reader. */
export function electroSprintState(
  document: TacticDocumentV1, actorId: string, time: number, ignoreActionId?: string,
  freezes: readonly SprintFreezeWindow[] = [],
): ElectroSprintState {
  return createElectroSprintStateReader(document, actorId, ignoreActionId, freezes)(time)
}

/** Edit-time geometry only. Timed E changes length, never its independent speed. */
export function syncSprintPath(document: TacticDocumentV1, action: MoveAction): void {
  if (!action.sprint) return
  const role = actorRule(document, action.actorId)
  if (!role?.sprint) return
  const state = electroSprintState(document, action.actorId, action.startTime, action.id)
  const speed = sprintSpeed(role)
  if (action.timingConstraint) {
    action.duration = Math.min(Math.max(0, action.duration), state.maxDuration)
    const geometry = solveTimedMoveGeometry(action, { start: action.startTime, end: actionEndTime(action),
      baseSpeed: speed, windows: [], cuts: [] }, document.rulesSnapshot.field)
    if (action.path.length !== geometry.path.length || geometry.path.some((point, index) =>
      Math.hypot(point.x - action.path[index]!.x, point.y - action.path[index]!.y) > EPSILON)) action.path = geometry.path
    if (geometry.curveControl) {
      if (!action.curveControl || Math.hypot(geometry.curveControl.x - action.curveControl.x, geometry.curveControl.y - action.curveControl.y) > EPSILON) action.curveControl = geometry.curveControl
    } else delete action.curveControl
    if (geometry.timingRouteBasis) action.timingRouteBasis = geometry.timingRouteBasis
    else delete action.timingRouteBasis
    // Reaching the wall ends E immediately; it cannot spend energy standing still.
    const duration = Math.min(action.duration, pathLength(resolvedMovePath(action)) / speed)
    if (Math.abs(action.duration - duration) > EPSILON) action.duration = duration
  } else {
    const route = resolvedMovePath(action)
    if (pathLength(route) > state.maxDistance + EPSILON) {
      const geometry = solveTimedMoveGeometry(action, { start: action.startTime, end: action.startTime + state.maxDuration,
        baseSpeed: speed, windows: [], cuts: [] }, document.rulesSnapshot.field)
      action.path = geometry.path
      if (geometry.curveControl) action.curveControl = geometry.curveControl
    }
    const duration = pathLength(resolvedMovePath(action)) / speed
    if (Math.abs(action.duration - duration) > EPSILON) action.duration = duration
  }
}

/**
 * One edit-boundary pass. Receipts have already been solved by normalizeBallActions.
 * Truncation is persisted, not an ongoing dependency: deleted/edited ordinary tails
 * cannot be silently recreated, and removing a pass never rejoins an earlier E.
 */
export function normalizeSprintActions(document: TacticDocumentV1): { changed: boolean; notices: string[]; splitActorIds: string[] } {
  const sprints = document.actions.filter((action): action is MoveAction => action.type === 'move' && !!action.sprint)
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
  if (!sprints.length) return { changed: false, notices: [], splitActorIds: [] }
  const before = JSON.stringify(document.actions)
  const notices: string[] = []
  const splitActorIds = new Set<string>()
  for (const action of sprints) {
    if (action.sprintReceptionSourceId && !document.actions.some((item) => item.type === 'pass' && item.id === action.sprintReceptionSourceId)) delete action.sprintReceptionSourceId
    const alreadySplit = !!action.sprintReceptionSourceId
    const role = actorRule(document, action.actorId)
    if (!role?.sprint) { delete action.sprint; delete action.sprintReceptionSourceId; notices.push('球员不再拥有雷 E，已保留为普通跑动。'); continue }
    const available = electroSprintState(document, action.actorId, action.startTime, action.id)
    // Excluding the candidate does not alter incoming reception/possession.
    const beforeAction = { ...document, actions: document.actions.filter((item) => item.id !== action.id) }
    const blocked = available.cooldown > EPSILON || projectFrame(beforeAction, action.startTime).ball.carrierId === action.actorId
    if (blocked) {
      action.path = [{ ...action.path[0]! }, { ...action.path[0]! }]
      action.duration = 0
      delete action.curveControl
      delete action.timingConstraint
      delete action.timingRouteBasis
      notices.push('雷 E 起点处持球或仍在冷却，冲刺已停止。')
      continue
    }
    syncSprintPath(document, action)
    const oldEnd = actionEndTime(action)
    const freezes = documentFreezeWindows(document, action.actorId).map((window) => ({ start: window.startsAt, end: window.endsAt }))
    const stop = sprintInterruptionTime(document, action, freezes)
    if (stop >= oldEnd - EPSILON) continue
    const route = resolvedMovePath(action)
    const length = pathLength(route)
    const prefixLength = Math.min(length, Math.max(0, stop - action.startTime) * sprintSpeed(role))
    const fraction = length > EPSILON ? prefixLength / length : 0
    const tailPath = slicePath(route, fraction, 1)
    const receipt = document.actions.find((item) => item.type === 'receive' && item.actorId === action.actorId
      && Math.abs(item.startTime - stop) <= EPSILON)
    action.path = truncatePath(route, prefixLength)
    if (action.path.length < 2) action.path.push({ ...action.path[0]! })
    action.duration = stop - action.startTime
    delete action.curveControl
    delete action.timingConstraint
    delete action.timingRouteBasis
    if (receipt && pathLength(tailPath) > EPSILON) {
      if (receipt.type === 'receive' && receipt.sourceActionId) action.sprintReceptionSourceId = receipt.sourceActionId
      // Earlier re-solved contact may shorten the existing prefix, but its
      // independently edited/deleted continuation is never re-materialized.
      splitActorIds.add(action.actorId)
      if (alreadySplit) continue
      const label = '-after-receive'
      const baseId = `${action.id.slice(0, 120 - label.length)}${label}`
      let id = baseId
      let suffix = 1
      while (document.actions.some((item) => item.id === id)) {
        const collision = `-${suffix++}`
        id = `${baseId.slice(0, 120 - collision.length)}${collision}`
      }
      const tail: MoveAction = { id, type: 'move', actorId: action.actorId, startTime: stop,
        duration: pathLength(tailPath) / document.rulesSnapshot.field.baseMoveSpeed, path: tailPath, label: '接球后跑动' }
      document.actions.splice(document.actions.indexOf(action) + 1, 0, tail)
    }
  }
  return { changed: JSON.stringify(document.actions) !== before, notices, splitActorIds: [...splitActorIds] }
}
