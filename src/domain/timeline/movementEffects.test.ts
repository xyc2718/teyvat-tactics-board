import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { MoveAction, PassAction } from '../model/types'
import { movementReceiveBoostWindowsFor, receiveMoveBoosts } from './movementEffects'
import { projectPlayerPosition } from './projectFrame'

function repeatedReceptions(follow = false) {
  const document = createDefaultDocument()
  const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
  ice.position = { x: 1, y: 7 }
  const move: MoveAction = {
    id: 'run-through-receptions', type: 'move', actorId: ice.id, startTime: 0, duration: 18,
    path: [{ ...ice.position }, { x: 19, y: 7 }],
  }
  if (follow) {
    move.targetPlayerId = 'blue-fire'
    move.syncActionId = 'follow-target'
    move.followGap = 0
    document.actions.push({
      id: 'follow-target', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 18,
      path: [{ x: 18, y: 7 }, { x: 20, y: 7 }],
    })
  }
  document.actions.push(move)
  for (const time of [1, 2, 8]) {
    const pass: PassAction = {
      id: `catch-${time}`, type: 'pass', actorId: 'blue-water', targetPlayerId: ice.id,
      startTime: time - 0.25, duration: 0.25, flightOutcome: 'received',
      path: [{ x: 1, y: 6 }, { x: 1, y: 7 }],
    }
    document.actions.push(pass)
  }
  return { document, move }
}

describe('historical reception movement gain', () => {
  it.each([false, true])('retains gain across refreshed catches and expired gaps (follow=%s)', (follow) => {
    const { document, move } = repeatedReceptions(follow)
    const boost = document.rulesSnapshot.roles.ice.receiveBoost!
    const rate = boost.netSeparationGain / boost.duration
    const expectedGain = (time: number) => rate * (
      Math.max(0, Math.min(time, 2 + boost.duration) - 1)
      + Math.max(0, Math.min(time, 8 + boost.duration) - 8)
    )
    for (const time of [0.9, 1, 1.999999, 2, 2.000001, 3, 7, 7.9, 8, 9]) {
      const position = projectPlayerPosition(document, move.actorId, time)!
      expect(position.x).toBeCloseTo(1 + time + expectedGain(time), follow ? 5 : 9)
    }
  })

  it('uses nonstacking source intervals and preserves every accelerated route portion', () => {
    const { document, move } = repeatedReceptions()
    const boost = document.rulesSnapshot.roles.ice.receiveBoost!
    const windows = movementReceiveBoostWindowsFor(document, move.actorId, 0, 18)
    expect(windows.map(({ sourceActionId, start, end }) => ({ sourceActionId, start, end }))).toEqual([
      { sourceActionId: 'catch-1', start: 1, end: 2 },
      { sourceActionId: 'catch-2', start: 2, end: 2 + boost.duration },
      { sourceActionId: 'catch-8', start: 8, end: 8 + boost.duration },
    ])
    const effects = receiveMoveBoosts(document, move)
    expect(effects).toHaveLength(3)
    for (const effect of effects) {
      expect(effect.path[0]!.x).toBeCloseTo(projectPlayerPosition(document, move.actorId, effect.overlapStart)!.x, 8)
      expect(effect.path.at(-1)!.x).toBeCloseTo(projectPlayerPosition(document, move.actorId, effect.overlapEnd)!.x, 8)
    }
    expect(effects.reduce((sum, effect) => sum + effect.separationGain, 0)).toBeCloseTo(
      boost.netSeparationGain * (1 / boost.duration + 2), 8,
    )
    const missed = document.actions.find((action) => action.id === 'catch-2') as PassAction
    missed.flightOutcome = 'dropped'
    expect(movementReceiveBoostWindowsFor(document, move.actorId, 0, 18).map((window) => window.sourceActionId)).toEqual(['catch-1', 'catch-8'])
  })
})
