import { describe, expect, it, vi } from 'vitest'
import { pathLength, resolvedMovePath } from '../geometry/geometry'
import { createDefaultDocument } from '../model/createDocument'
import type { MoveAction, PassAction, TacticDocumentV1 } from '../model/types'
import { createBallPickupAction, normalizeBallActions } from './looseBall'
import { movementReceiveBoostWindowsFor } from './movementEffects'
import { documentFreezeWindows, eZoneSlowSegmentsForMove, projectPlayerPosition, projectedMovePath, projectedMovePathSegment, resolveTimedMoveGeometry, statusSlowSegmentsForMove, timedMoveBoosts } from './projectFrame'
import * as timed from './timedMove'

function runFixture(actorId = 'blue-water', startTime = 0, duration = 4.3) {
  const document = createDefaultDocument()
  const actor = document.initialScene.players.find((player) => player.id === actorId)!
  actor.position = { x: 2, y: 3 }
  const move: MoveAction = { id: 'timed-run', type: 'move', actorId, startTime, duration,
    path: [{ ...actor.position }, { x: 3, y: 3 }], timingConstraint: { kind: 'fixed' } }
  document.actions.push(move)
  return { document, move }
}

function sync(document: TacticDocumentV1, move: MoveAction) {
  const result = resolveTimedMoveGeometry(document, move)
  move.path = result.path
  if (result.curveControl) move.curveControl = result.curveControl
  else delete move.curveControl
  if (result.timingRouteBasis) move.timingRouteBasis = result.timingRouteBasis
  else delete move.timingRouteBasis
}

function waterQ(document: TacticDocumentV1, actorId = 'blue-water', time = 0) {
  document.actions.unshift({ id: `q-${time}`, type: 'qMove', actorId, startTime: time, duration: 0,
    path: [{ x: 0, y: 3 }, { x: 2, y: 3 }] })
}

function catchAt(document: TacticDocumentV1, id: string, actorId: string, receiverId: string, end: number) {
  const pass: PassAction = { id, type: 'pass', actorId, targetPlayerId: receiverId, startTime: end - 0.25,
    duration: 0.25, flightOutcome: 'received', path: [{ x: 1, y: 3 }, { x: 2, y: 3 }] }
  document.actions.push(pass)
}

describe('physical fixed-time runs', () => {
  it.each(['fixed', 'keyframe', 'qCooldown'] as const)('uses full water Q gain once for %s timing, including intermediate positions and colors', (kind) => {
    const { document, move } = runFixture()
    waterQ(document)
    move.timingConstraint = kind === 'fixed' ? { kind }
      : kind === 'qCooldown' ? { kind, sourceActionId: 'q-0' }
        : { kind, reference: { playerId: 'blue-fire', actionId: 'target', edge: 'end' } }
    sync(document, move)
    expect(pathLength(resolvedMovePath(move))).toBeCloseTo(5.1, 9)
    expect(move.duration).toBe(4.3)
    expect(projectPlayerPosition(document, move.actorId, 2.15)?.x).toBeCloseTo(4.55, 9)
    expect(projectPlayerPosition(document, move.actorId, 4.3)?.x).toBeCloseTo(7.1, 9)
    expect(timedMoveBoosts(document, move)[0]?.path).toEqual(projectedMovePath(document, move))
    const once = structuredClone(move)
    sync(document, move)
    expect(move.path[1]!.x).toBeCloseTo(once.path[1]!.x, 9)
  })

  it('cuts partial boost boundaries instead of spreading gain over the entire run', () => {
    const { document, move } = runFixture('blue-water', 3, 4)
    waterQ(document)
    sync(document, move)
    const gain = 1.3 * 0.8 / 4.3
    expect(pathLength(move.path)).toBeCloseTo(4 + gain, 9)
    expect(projectPlayerPosition(document, move.actorId, 3.5)?.x).toBeCloseTo(2.5 + 0.5 * 0.8 / 4.3, 9)
    expect(projectPlayerPosition(document, move.actorId, 6)?.x).toBeCloseTo(5 + gain, 9)
    const segment = timedMoveBoosts(document, move)[0]!
    expect(segment.overlapEnd).toBe(4.3)
    expect(segment.path.at(-1)).toEqual(projectedMovePathSegment(document, move, 3, 4.3).at(-1))
  })

  it('adds independent Q and transferred receive gains, but not refreshed duplicates', () => {
    const { document, move } = runFixture('blue-water', 0, 6)
    waterQ(document)
    catchAt(document, 'to-ice', 'blue-water', 'blue-ice', 0.5)
    catchAt(document, 'back-water', 'blue-ice', 'blue-water', 1.5)
    sync(document, move)
    expect(pathLength(move.path)).toBeCloseTo(7.6, 9)
    expect(timedMoveBoosts(document, move).map((effect) => effect.kind)).toEqual(['q', 'receive'])
    const iceFixture = runFixture('blue-ice', 0, 10)
    for (const time of [1, 2, 8]) catchAt(iceFixture.document, `catch-${time}`, 'blue-water', 'blue-ice', time)
    sync(iceFixture.document, iceFixture.move)
    const gain = (5.3 + 2) * 0.8 / 4.3
    expect(pathLength(iceFixture.move.path)).toBeCloseTo(10 + gain, 9)
    for (const effect of timedMoveBoosts(iceFixture.document, iceFixture.move)) {
      expect(effect.path[0]?.x).toBeCloseTo(projectPlayerPosition(iceFixture.document, 'blue-ice', effect.overlapStart)!.x, 9)
      expect(effect.path.at(-1)?.x).toBeCloseTo(projectPlayerPosition(iceFixture.document, 'blue-ice', effect.overlapEnd)!.x, 9)
    }
  })

  it('subtracts unioned authored slow before applying an enemy zone multiplier', () => {
    const { document, move } = runFixture('blue-water', 0, 4.3)
    waterQ(document)
    document.actions.push(
      { id: 'slow-1', type: 'status', targetId: move.actorId, status: 'slowed', startTime: 0, duration: 3 },
      { id: 'slow-2', type: 'status', targetId: move.actorId, status: 'slowed', startTime: 2, duration: 2 },
      { id: 'zone', type: 'eZone', actorId: 'red-ice', startTime: 0, duration: 10, center: { x: 10, y: 7 }, radius: 30 },
    )
    sync(document, move)
    const slow = document.rulesSnapshot.roles.ice.slow!
    expect(pathLength(move.path)).toBeCloseTo((5.1 - 4 * slow.fullSeparationLoss / slow.duration) * 0.5, 5)
    expect(projectPlayerPosition(document, move.actorId, 1)?.x).toBeCloseTo(2 + (1 + 0.8 / 4.3 - slow.fullSeparationLoss / slow.duration) * 0.5, 5)
    expect(statusSlowSegmentsForMove(document, move)).toHaveLength(1)
    expect(eZoneSlowSegmentsForMove(document, move)).toHaveLength(1)
  })

  it('solves direction-dependent crossings and moving zone centers with a bounded warm cache', () => {
    const { document, move } = runFixture('blue-fire', 0, 6)
    const owner = document.initialScene.players.find((player) => player.id === 'red-ice')!
    owner.position = { x: 5, y: 3 }
    document.actions.push({ id: 'zone', type: 'eZone', actorId: owner.id, startTime: 0, duration: 10,
      center: owner.position, radius: 1 })
    sync(document, move)
    expect(pathLength(move.path)).toBeCloseTo(4, 1)
    const first = move.path[1]!.x
    sync(document, move)
    expect(move.path[1]!.x).toBeCloseTo(first, 5)
    document.actions.push({ id: 'owner-run', type: 'move', actorId: owner.id, startTime: 0, duration: 6,
      path: [owner.position, { x: 11, y: 3 }] })
    sync(document, move)
    expect(pathLength(move.path)).toBeCloseTo(6, 6)
    projectPlayerPosition(document, move.actorId, 3)
    const spy = vi.spyOn(timed, 'integrateTimedMove')
    for (let index = 0; index < 90; index += 1) {
      projectPlayerPosition(document, move.actorId, (index % 2 ? 90 - index : index) * 6 / 90)
      projectedMovePathSegment(document, move, 0, index * 6 / 90)
    }
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('preserves curved shape, clips the field without slowing the early motion, and keeps zero-distance direction', () => {
    const { document, move } = runFixture('blue-fire', 0, 4)
    move.curveControl = { x: 2.5, y: 4 }
    sync(document, move)
    expect(pathLength(resolvedMovePath(move))).toBeCloseTo(4, 8)
    expect(projectedMovePathSegment(document, move, 0, 2).at(-1)).toEqual(projectPlayerPosition(document, move.actorId, 2))
    delete move.curveControl
    move.path = [{ x: 19, y: 3 }, { x: 20, y: 3 }]
    sync(document, move)
    expect(move.path[1]!.x).toBe(20)
    expect(projectPlayerPosition(document, move.actorId, 0.5)?.x).toBeCloseTo(19.5, 9)
    expect(projectPlayerPosition(document, move.actorId, 3)?.x).toBe(20)
    move.path = [{ x: 2, y: 3 }, { x: 2, y: 5 }]
    document.initialScene.statuses.push({ id: 'freeze', sourceActionId: 'freeze', playerId: move.actorId,
      kind: 'frozen', startsAt: 0, endsAt: 1 })
    sync(document, move)
    expect(pathLength(move.path)).toBe(0)
    expect(move.timingRouteBasis?.endOffset).toEqual({ x: 0, y: 1 })
    expect(projectPlayerPosition(document, move.actorId, 3)).toEqual({ x: 2, y: 3 })
    document.initialScene.statuses = []
    sync(document, move)
    expect(move.path[1]).toEqual({ x: 2, y: 7 })
    expect(move.timingRouteBasis).toBeUndefined()
  })

  it('cancels at first authored freeze and never resumes or extends fixed time', () => {
    const { document, move } = runFixture('blue-fire', 0, 5)
    document.actions.push({ id: 'freeze', type: 'status', targetId: move.actorId, status: 'frozen', startTime: 1.25, duration: 1 })
    sync(document, move)
    expect(pathLength(move.path)).toBeCloseTo(1.25, 9)
    expect(move.duration).toBe(5)
    expect(projectPlayerPosition(document, move.actorId, 0.5)?.x).toBeCloseTo(2.5, 9)
    expect(projectPlayerPosition(document, move.actorId, 4)?.x).toBeCloseTo(3.25, 9)
  })

  it('shares derived Q-hit interruption with the arrow and retains the separate knockback', () => {
    const { document, move } = runFixture('blue-fire', 0, 4)
    const opponent = document.initialScene.players.find((player) => player.id === 'red-ice')!
    opponent.position = { x: 3, y: 0 }
    document.actions.push({ id: 'enemy-q', type: 'qMove', actorId: opponent.id, startTime: 0, duration: 1,
      path: [{ x: 3, y: 0 }, { x: 3, y: 3 }] })
    // Hit discovery and geometry synchronization use bounded edit rounds.
    for (let round = 0; round < 3; round += 1) sync(document, move)
    const freeze = documentFreezeWindows(document, move.actorId)[0]!
    expect(freeze).toBeDefined()
    expect(pathLength(projectedMovePath(document, move))).toBeCloseTo(freeze.startsAt, 6)
    expect(move.duration).toBe(4)
    expect(projectPlayerPosition(document, move.actorId, 4)?.x).toBeCloseTo(
      2 + freeze.startsAt - document.rulesSnapshot.roles.ice.q.facingKnockback!, 6)
  })

  it('invalidates in-place rule/path edits and keeps cached routes caller-owned', () => {
    const { document, move } = runFixture('blue-water')
    waterQ(document)
    sync(document, move)
    const path = projectedMovePath(document, move)
    path[0]!.x = -100
    expect(projectedMovePath(document, move)[0]!.x).toBe(2)
    document.rulesSnapshot.roles.water.afterQBoost!.netSeparationGain = 1.6
    sync(document, move)
    expect(pathLength(move.path)).toBeCloseTo(5.9, 9)
    move.path[1] = { x: 2, y: 5 }
    sync(document, move)
    expect(projectPlayerPosition(document, move.actorId, 2.15)?.x).toBe(2)
    expect(projectPlayerPosition(document, move.actorId, 2.15)?.y).toBeCloseTo(5.95, 9)
    expect(projectedMovePath(structuredClone(document), structuredClone(move))).toEqual(projectedMovePath(document, move))
  })

  it('preserves imported intermediate path vertices through scaling and zero-distance recovery', () => {
    const { document, move } = runFixture('blue-fire', 0, 4)
    move.path = [{ x: 2, y: 3 }, { x: 2.5, y: 4 }, { x: 3, y: 3 }]
    sync(document, move)
    expect(move.path).toHaveLength(3)
    expect(move.path[1]!.x).toBeCloseTo(4, 9)
    expect(move.path[1]!.y).toBeCloseTo(7, 9)
    expect(move.path[2]!.x).toBeCloseTo(6, 9)
    document.initialScene.statuses.push({ id: 'freeze', sourceActionId: 'freeze', playerId: move.actorId,
      kind: 'frozen', startsAt: 0, endsAt: 1 })
    sync(document, move)
    expect(move.path).toHaveLength(3)
    expect(move.timingRouteBasis?.pathOffsets).toHaveLength(2)
    document.initialScene.statuses = []
    sync(document, move)
    expect(move.path[1]!.x).toBeCloseTo(4, 9)
    expect(move.path[1]!.y).toBeCloseTo(7, 9)
  })

  it('uses marked-ball pickup boost only after the solved catch, restarting its saved duration', () => {
    const { document, move } = runFixture('blue-fire', 20, 4.3)
    catchAt(document, 'to-ice', 'blue-water', 'blue-ice', 0.25)
    document.actions.push({ id: 'throw', type: 'loosePass', actorId: 'blue-ice', startTime: 1, duration: 3,
      aimDirection: { x: 1, y: 0 }, path: [{ x: 5.5, y: 9.3 }, { x: 11.5, y: 9.3 }], flightOutcome: 'grounded' })
    document.actions = document.actions.filter((action) => action.id !== move.id)
    normalizeBallActions(document)
    document.initialScene.players.find((player) => player.id === move.actorId)!.position = { x: 10.5, y: 9.3 }
    const pickup = createBallPickupAction(document, move.actorId, 20, 'move', 'pickup')
    if (!pickup.ok) throw Error(pickup.message)
    document.actions.push(pickup.action)
    normalizeBallActions(document)
    move.startTime = pickup.action.startTime + pickup.action.duration
    move.path = [{ x: 11.5, y: 9.3 }, { x: 12.5, y: 9.3 }]
    document.actions.push(move)
    expect(movementReceiveBoostWindowsFor(document, move.actorId, move.startTime, move.startTime + move.duration)).toHaveLength(1)
    sync(document, move)
    expect(pathLength(move.path)).toBeCloseTo(5.1, 6)
    expect(timedMoveBoosts(document, move)[0]?.kind).toBe('receive')
  })
})
