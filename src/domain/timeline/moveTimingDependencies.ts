import type { TacticAction, TacticDocumentV1, TimingTargetReference } from '../model/types'
import { actionEndTime } from './durations'

function isSequenceAction(action: TacticAction): action is Extract<TacticAction, { type: 'move' | 'qMove' | 'wait' }> & { actorId: string } {
  return (action.type === 'move' || action.type === 'qMove' || action.type === 'wait') && Boolean(action.actorId)
}

export function timingReferenceSourceIds(reference: TimingTargetReference): string[] {
  return 'actionId' in reference ? [reference.actionId] : []
}

/** Build once per edit or picker, rather than sorting a track at every graph node. */
export function createTimingDependencyGraph(document: TacticDocumentV1): Map<string, Set<string>> {
  const graph = new Map(document.actions.map((action) => [action.id, new Set<string>()]))
  const players = new Map(document.initialScene.players.map((player) => [player.id, player]))
  const tracks = new Map<string, Array<{ action: TacticAction; index: number }>>()
  document.actions.forEach((action, index) => {
    if (!isSequenceAction(action)) return
    const track = tracks.get(action.actorId) ?? []
    track.push({ action, index })
    tracks.set(action.actorId, track)
  })
  for (const track of tracks.values()) {
    track.sort((a, b) => a.action.startTime - b.action.startTime
      || Number(b.action.type === 'qMove' && b.action.duration <= 1e-6) - Number(a.action.type === 'qMove' && a.action.duration <= 1e-6)
      || actionEndTime(a.action) - actionEndTime(b.action) || a.index - b.index)
    track.forEach(({ action }, index) => {
      const previous = track[index - 1]?.action
      if (previous) graph.get(action.id)!.add(previous.id)
    })
  }
  const addMotion = (edges: Set<string>, playerId: string, before: number) => {
    for (const { action } of tracks.get(playerId) ?? []) {
      if (action.startTime < before - 1e-6) edges.add(action.id)
    }
  }
  for (const action of document.actions) {
    const edges = graph.get(action.id)!
    if (action.type === 'move' || action.type === 'wait') {
      if (action.timingConstraint?.kind === 'keyframe') {
        for (const id of timingReferenceSourceIds(action.timingConstraint.reference)) edges.add(id)
      }
      if (action.type === 'move') {
        if (action.syncActionId) edges.add(action.syncActionId)
        if (action.timingConstraint?.kind === 'qCooldown') edges.add(action.timingConstraint.sourceActionId)
      }
    }
    if (action.type === 'pass' || action.type === 'loosePass') {
      if (action.originKeyframe) edges.add(action.originKeyframe.actionId)
      if (action.originPickupActionId) edges.add(action.originPickupActionId)
      if (action.originReception) edges.add(action.originReception.sourceActionId)
      addMotion(edges, action.actorId, action.startTime)
      if (action.type === 'pass' && action.targetPlayerId) {
        // Catch time is derived from actual target motion, not the generated receipt.
        addMotion(edges, action.targetPlayerId, actionEndTime(action))
        const receiver = players.get(action.targetPlayerId)
        for (const zone of document.actions) {
          if (zone.type === 'eZone' && zone.startTime < actionEndTime(action) && actionEndTime(zone) > action.startTime) {
            const owner = players.get(zone.actorId)
            // Friendly zones cannot affect a receiver's motion or ball speed.
            // Their owners therefore are not causes of this catch event.
            if (!receiver || !owner || owner.team === receiver.team || !document.rulesSnapshot.roles[owner.role].e) continue
            edges.add(zone.id)
            addMotion(edges, zone.actorId, actionEndTime(action))
          }
        }
      }
    }
    if (action.type === 'receive') {
      if (action.sourceActionId) edges.add(action.sourceActionId)
      if (action.pickupActionId) edges.add(action.pickupActionId)
      if (action.ballSourceActionId) edges.add(action.ballSourceActionId)
    }
    if ((action.type === 'move' || action.type === 'qMove') && action.ballTarget?.sourceActionId) edges.add(action.ballTarget.sourceActionId)
  }
  return graph
}

export function timingGraphWouldCycle(graph: ReadonlyMap<string, ReadonlySet<string>>, actionId: string, sourceIds: Iterable<string>): boolean {
  const visited = new Set<string>()
  const pending = [...sourceIds]
  while (pending.length > 0) {
    const currentId = pending.pop()
    if (!currentId) continue
    if (currentId === actionId) return true
    if (visited.has(currentId)) continue
    visited.add(currentId)
    pending.push(...(graph.get(currentId) ?? []))
  }
  return false
}

export function moveTimingWouldCycle(document: TacticDocumentV1, moveActionId: string, referencedActionId: string): boolean {
  return timingGraphWouldCycle(createTimingDependencyGraph(document), moveActionId, [referencedActionId])
}
