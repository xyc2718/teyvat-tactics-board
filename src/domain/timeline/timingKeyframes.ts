import type { MoveAction, TacticDocumentV1, TimingTargetReference, WaitAction } from '../model/types'
import { actionEndTime } from './durations'
import { playerActionKeyframes } from './playerKeyframes'
import { movementQBoostWindowsFor, movementReceiveBoostWindowsFor } from './movementEffects'
import { documentFreezeWindows } from './projectFrame'
import { createTimingDependencyGraph, timingGraphWouldCycle } from './moveTimingDependencies'

export interface TimingKeyframe {
  id: string
  playerId: string
  time: number
  label: string
  reference: TimingTargetReference
  /** Includes refresh/control causes in addition to the primary stable source. */
  dependencyActionIds: string[]
}

const cache = new WeakMap<TacticDocumentV1, { signature: string; events: TimingKeyframe[] }>()
export function timingReferenceKey(reference: TimingTargetReference): string {
  return JSON.stringify([reference.playerId, 'event' in reference ? reference.event : 'action',
    'actionId' in reference ? reference.actionId : reference.statusId, reference.edge])
}

/** All six lanes share one content-validated catalog, including effective refresh windows. */
export function documentTimingKeyframes(document: TacticDocumentV1): TimingKeyframe[] {
  const signature = JSON.stringify([document.rulesSnapshot, document.initialScene, document.actions])
  const cached = cache.get(document)
  if (cached?.signature === signature) return structuredClone(cached.events)
  const events: TimingKeyframe[] = []
  const add = (reference: TimingTargetReference, time: number, label: string, dependencies: string[]) => {
    if (!Number.isFinite(time) || time < 0) return
    events.push({ id: timingReferenceKey(reference), playerId: reference.playerId, time, label, reference,
      dependencyActionIds: [...new Set(dependencies)] })
  }
  const freezeWindows = documentFreezeWindows(document)
  for (const player of document.initialScene.players) {
    for (const event of playerActionKeyframes(document, player.id)) {
      const source = document.actions.find((action) => action.id === event.actionId)
      const statusLabel = source?.type === 'status' ? { frozen: '冻结', slowed: '挂冰', boosted: '加速' }[source.status] : null
      const label = statusLabel ? `${statusLabel}${event.edge === 'start' ? '开始' : '结束'}` : event.label
      add(event.reference, event.time, label, [event.actionId])
    }
    const qActions = document.actions.filter((action) => action.type === 'qMove' && action.actorId === player.id)
      .sort((a, b) => actionEndTime(a) - actionEndTime(b))
    const role = document.rulesSnapshot.roles[player.role]
    qActions.forEach((action) => {
      add({ playerId: player.id, actionId: action.id, event: 'qReady', edge: 'end' },
        action.startTime + role.q.cooldown, 'Q 冷却结束', [action.id])
    })
    const qBoosts = movementQBoostWindowsFor(document, player.id, 0, Number.MAX_VALUE)
    qBoosts.forEach((window, index) => {
      const next = qBoosts[index + 1]
      const refreshed = next && window.end < window.start + window.boost.duration
      add({ playerId: player.id, actionId: window.sourceActionId, event: 'qBoost', edge: 'start' }, window.start, 'Q 后加速开始', [window.sourceActionId])
      add({ playerId: player.id, actionId: window.sourceActionId, event: 'qBoost', edge: 'end' }, window.end,
        refreshed ? 'Q 后加速刷新' : 'Q 后加速结束', refreshed ? [window.sourceActionId, next.sourceActionId] : [window.sourceActionId])
    })
    const boosts = movementReceiveBoostWindowsFor(document, player.id, 0, Number.MAX_VALUE)
    boosts.forEach((window, index) => {
      const source = document.actions.find((action) => action.id === window.sourceActionId)
      // Pickup identities belong to the authored pickup, not the regenerated receipt ID.
      const actionId = source?.type === 'receive' && source.pickupActionId ? source.pickupActionId : window.sourceActionId
      const label = source?.type === 'receive' && source.pickupActionId ? '捡球加速'
        : role.receiveBoost ? '接球加速' : '传递加速'
      const dependencies = [window.sourceActionId, actionId]
      add({ playerId: player.id, actionId, event: 'receiveBoost', edge: 'start' }, window.start, `${label}开始`, dependencies)
      const refreshed = window.end < window.start + window.boost.duration
      const next = boosts[index + 1]
      add({ playerId: player.id, actionId, event: 'receiveBoost', edge: 'end' }, window.end,
        `${label}${refreshed ? '刷新' : '结束'}`, refreshed && next ? [...dependencies, next.sourceActionId] : dependencies)
    })
    for (const window of freezeWindows.filter((candidate) => candidate.playerId === player.id)) {
      if (document.initialScene.statuses.some((status) => status.id === window.id)) continue
      const source = document.actions.find((action) => action.id === window.sourceActionId)
      if (source?.type !== 'qMove') continue // Authored status edges are already listed.
      const dependencies = [source.id, ...document.actions.filter((action) => (
        (action.type === 'move' || action.type === 'qMove') && action.actorId === player.id
        // Completed motion still determines the target position when this Q
        // arrives. Omitting it would offer a run its own derived thaw event.
        && action.startTime <= actionEndTime(source)
      )).map((action) => action.id)]
      add({ playerId: player.id, actionId: source.id, event: 'freeze', edge: 'start' }, window.startsAt, '冻结开始', dependencies)
      add({ playerId: player.id, actionId: source.id, event: 'freeze', edge: 'end' }, window.endsAt, '解冻', dependencies)
    }
    for (const status of document.initialScene.statuses.filter((candidate) => candidate.playerId === player.id)) {
      const label = { frozen: '冻结', slowed: '减速', boosted: '加速' }[status.kind]
      add({ playerId: player.id, statusId: status.id, event: 'initialStatus', edge: 'start' }, status.startsAt, `${label}开始`, [])
      add({ playerId: player.id, statusId: status.id, event: 'initialStatus', edge: 'end' }, status.endsAt, `${label}结束`, [])
    }
  }
  events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
  cache.set(document, { signature, events })
  return structuredClone(events)
}

export function playerTimingKeyframes(document: TacticDocumentV1, playerId: string): TimingKeyframe[] {
  return documentTimingKeyframes(document).filter((event) => event.playerId === playerId)
}

/** Valid for one synchronous operation over unchanged document content. */
export function createTimingKeyframeReader(document: TacticDocumentV1) {
  const events = new Map(documentTimingKeyframes(document).map((event) => [timingReferenceKey(event.reference), event]))
  return (reference: TimingTargetReference): TimingKeyframe | null => events.get(timingReferenceKey(reference)) ?? null
}

export function resolveTimingKeyframe(document: TacticDocumentV1, reference: TimingTargetReference): TimingKeyframe | null {
  return createTimingKeyframeReader(document)(reference)
}

export function createTimingValidationContext(document: TacticDocumentV1) {
  const read = createTimingKeyframeReader(document)
  const graph = createTimingDependencyGraph(document)
  // Derived bindings carry refresh/control dependencies not present in their primary source ID.
  for (const candidate of document.actions) {
    if ((candidate.type === 'move' || candidate.type === 'wait') && candidate.timingConstraint?.kind === 'keyframe') {
      for (const id of read(candidate.timingConstraint.reference)?.dependencyActionIds ?? []) graph.get(candidate.id)?.add(id)
    }
  }
  const unavailableReason = (action: MoveAction | WaitAction, reference: TimingTargetReference): string | null => {
    if (!action.actorId) return '没有所属球员的等待只能手动设置时间。'
    const event = read(reference)
    if (!event) return '时间参照关键帧已失效或不存在。'
    if (event.time <= action.startTime + 1e-6) return '目标关键帧必须晚于动作开始。'
    if (timingGraphWouldCycle(graph, action.id, event.dependencyActionIds)) return '该关键帧依赖当前动作，会形成循环时间依赖。'
    return null
  }
  return { read, unavailableReason }
}

export function createTimingTargetValidator(document: TacticDocumentV1, action: MoveAction | WaitAction) {
  const context = createTimingValidationContext(document)
  return (reference: TimingTargetReference) => context.unavailableReason(action, reference)
}

export function timingTargetUnavailableReason(document: TacticDocumentV1, action: MoveAction | WaitAction, reference: TimingTargetReference): string | null {
  return createTimingTargetValidator(document, action)(reference)
}
