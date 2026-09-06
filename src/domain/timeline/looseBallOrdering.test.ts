import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { LoosePassAction, PassAction, QMoveAction } from '../model/types'
import { ballEpisodeSourceIdAt, normalizeBallActions } from './looseBall'
import { projectFrame, projectFrameAtKeyframe } from './projectFrame'

function simultaneousChain(onwardType: 'pass' | 'loosePass') {
  const document = createDefaultDocument()
  document.initialScene.players.forEach((player, index) => {
    player.hasBall = player.id === 'blue-fire'
    player.position = { x: 2 + index * 2, y: 12 }
  })
  document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 6, y: 3 }
  document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 4, y: 3 }
  document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 9, y: 3 }
  document.initialScene.ball = { carrierId: 'blue-fire', isFree: false, position: { x: 6, y: 3 } }
  const source: LoosePassAction = { id: 'source', type: 'loosePass', actorId: 'blue-fire', startTime: 0, duration: 3,
    aimDirection: { x: 1, y: 0 }, path: [{ x: 6, y: 3 }, { x: 12, y: 3 }], flightOutcome: 'grounded' }
  const pickup: QMoveAction = { id: 'pickup', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0,
    path: [{ x: 4, y: 3 }, { x: 6.5, y: 3 }], ballTarget: { sourceActionId: source.id } }
  const onward: PassAction | LoosePassAction = onwardType === 'pass'
    ? { id: 'onward', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice', originPickupActionId: pickup.id,
      startTime: 0, duration: 0, path: [{ x: 6.5, y: 3 }, { x: 9, y: 3 }] }
    : { id: 'onward', type: 'loosePass', actorId: 'blue-water', originPickupActionId: pickup.id, aimDirection: { x: 0, y: 1 },
      startTime: 0, duration: 3, path: [{ x: 6.5, y: 3 }, { x: 6.5, y: 9 }], flightOutcome: 'grounded' }
  document.actions = [source, pickup, onward]
  expect(normalizeBallActions(document).invalidPickups).toEqual([])
  return document
}

describe('same-time loose-ball causal ordering', () => {
  it('keeps an instant pickup start edge free and excludes its causal onward release', () => {
    const document = simultaneousChain('loosePass')
    const reference = { playerId: 'blue-water', actionId: 'pickup', edge: 'start' as const }
    const before = projectFrameAtKeyframe(document, 0, reference)
    expect(before.ball).toEqual({ carrierId: null, isFree: true, position: { x: 6, y: 3 } })
    expect(before.players.find((player) => player.id === reference.playerId)?.position).toEqual({ x: 4, y: 3 })
    const pickupOnly = structuredClone(document)
    pickupOnly.actions = pickupOnly.actions.filter((action) => action.id !== 'onward')
    expect(projectFrameAtKeyframe(pickupOnly, 0, reference).ball.carrierId).toBeNull()
    expect(projectFrameAtKeyframe(pickupOnly, 0, { ...reference, edge: 'end' }).ball.carrierId).toBe('blue-water')
  })
  it.each(['pass', 'loosePass'] as const)('projects a source, instant pickup and onward %s independently of array order', (type) => {
    const document = simultaneousChain(type)
    const expected = [0, 0.1, 0.5, 3].map((time) => projectFrame(document, time).ball)
    expect(expected[1]?.isFree).toBe(true)
    const reversed = structuredClone(document)
    reversed.actions.reverse()
    for (const [index, time] of [0, 0.1, 0.5, 3].entries()) expect(projectFrame(reversed, time).ball).toEqual(expected[index])
    expect(ballEpisodeSourceIdAt(reversed, 0.1)).toBe(type === 'loosePass' ? 'onward' : undefined)
    expect(normalizeBallActions(reversed).invalidPickups).toEqual([])
    for (const [index, time] of [0, 0.1, 0.5, 3].entries()) expect(projectFrame(reversed, time).ball).toEqual(expected[index])
  })
})
