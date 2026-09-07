import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { MoveAction, QMoveAction } from '../model/types'
import { findMoveQCooldownTarget, resolveMoveQCooldownTarget } from './moveTiming'
import { moveTimingWouldCycle } from './moveTimingDependencies'

function fixture() {
  const document = createDefaultDocument()
  document.rulesSnapshot.roles.water.q.cooldown = 6
  const move: MoveAction = {
    id: 'run', type: 'move', actorId: 'blue-water', startTime: 4, duration: 4,
    path: [{ x: 8, y: 4.7 }, { x: 12, y: 4.7 }],
  }
  const source: QMoveAction = {
    id: 'q', type: 'qMove', actorId: 'blue-water', startTime: 2, duration: 0,
    path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }],
  }
  document.actions = [source, move]
  return { document, move, source }
}

describe('move Q cooldown targets', () => {
  it('uses the latest preceding own Q and the saved role cooldown, ignoring future/other-player Q and thaw', () => {
    const { document, move, source } = fixture()
    document.actions.push(
      { ...source, id: 'old', startTime: 0 },
      { ...source, id: 'future', startTime: 5 },
      { ...source, id: 'other', actorId: 'red-water', startTime: 3 },
    )
    document.initialScene.statuses.push({
      id: 'frozen', playerId: move.actorId, kind: 'frozen', sourceActionId: 'freeze', startsAt: 3, endsAt: 12,
    })
    expect(findMoveQCooldownTarget(document, move)).toEqual({ sourceActionId: 'q', readyTime: 8 })
    expect(findMoveQCooldownTarget({ ...document, actions: [...document.actions].reverse() }, move))
      .toEqual({ sourceActionId: 'q', readyTime: 8 })
  })

  it('keeps a bound source identity when a newer preceding Q is added', () => {
    const { document, move, source } = fixture()
    move.timingConstraint = { kind: 'qCooldown', sourceActionId: 'q' }
    document.actions.push({ ...source, id: 'new-q', startTime: 3 })
    expect(findMoveQCooldownTarget(document, move)).toEqual({ sourceActionId: 'new-q', readyTime: 9 })
    expect(resolveMoveQCooldownTarget(document, move)).toEqual({ sourceActionId: 'q', readyTime: 8 })
    document.actions = document.actions.filter((action) => action.id !== source.id)
    expect(resolveMoveQCooldownTarget(document, move)).toBeNull()
  })

  it('accepts an instant Q at the run start independently of array order or Q duration', () => {
    const { document, move, source } = fixture()
    move.startTime = source.startTime
    document.actions.reverse()
    expect(findMoveQCooldownTarget(document, move)).toEqual({ sourceActionId: 'q', readyTime: 8 })
    expect(moveTimingWouldCycle(document, move.id, source.id)).toBe(false)
    move.duration = 0
    expect(moveTimingWouldCycle(document, move.id, source.id)).toBe(false)
    move.startTime = 4
    source.duration = 1.5
    expect(findMoveQCooldownTarget(document, move)?.readyTime).toBe(8)
  })

  it.each([8, 9])('rejects cooldown already ready at %ss', (start) => {
    const { document, move } = fixture()
    move.startTime = start
    expect(findMoveQCooldownTarget(document, move)).toBeNull()
  })

  it('rejects missing, future, other-actor, pickup and following sources', () => {
    const { document, move, source } = fixture()
    expect(findMoveQCooldownTarget({ ...document, actions: [move] }, move)).toBeNull()
    source.startTime = 5
    expect(findMoveQCooldownTarget(document, move)).toBeNull()
    source.startTime = 2
    source.actorId = 'red-water'
    move.timingConstraint = { kind: 'qCooldown', sourceActionId: source.id }
    expect(resolveMoveQCooldownTarget(document, move)).toBeNull()
    source.actorId = move.actorId
    expect(findMoveQCooldownTarget(document, { ...move, ballTarget: { sourceActionId: null } })).toBeNull()
    expect(findMoveQCooldownTarget(document, { ...move, targetPlayerId: 'red-fire' })).toBeNull()
  })

  it('includes Q bindings in dependency traversal', () => {
    const { document, move, source } = fixture()
    move.timingConstraint = { kind: 'qCooldown', sourceActionId: source.id }
    // Test the explicit timing edge without the implicit same-actor sequence edge.
    source.actorId = 'red-water'
    expect(moveTimingWouldCycle(document, source.id, move.id)).toBe(true)
  })
})
