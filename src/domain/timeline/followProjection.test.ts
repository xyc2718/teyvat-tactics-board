import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { EZoneAction, MoveAction } from '../model/types'
import { projectFrame } from './projectFrame'

describe('close-follow projection performance', () => {
  it('does not re-enter the ignored follow while sampling a target during an ice-field window', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    const follower = document.initialScene.players.find((player) => player.id === 'red-fire')!
    const zoneOwner = document.initialScene.players.find((player) => player.id === 'red-ice')!
    target.position = { x: 12, y: 3 }
    follower.position = { x: 14, y: 3 }
    zoneOwner.position = { x: 3, y: 10 }

    const targetMove: MoveAction = {
      id: 'target-move-through-zone-window',
      type: 'move',
      actorId: target.id,
      path: [{ ...target.position }, { x: 12, y: 11 }],
      startTime: 0,
      duration: 8,
    }
    const zone: EZoneAction = {
      id: 'opposing-zone-window',
      type: 'eZone',
      actorId: zoneOwner.id,
      center: { ...zoneOwner.position },
      radius: 2,
      startTime: 0,
      duration: 8,
    }
    const follow: MoveAction = {
      id: 'bounded-follow',
      type: 'move',
      actorId: follower.id,
      targetPlayerId: target.id,
      syncActionId: targetMove.id,
      followGap: document.rulesSnapshot.roles[follower.role].attackRadius,
      path: [{ ...follower.position }, { x: 12, y: 11 }],
      startTime: 0,
      duration: 8,
    }
    document.actions.push(zone, targetMove, follow)

    const started = performance.now()
    const frame = projectFrame(document, 8)
    const elapsed = performance.now() - started

    expect(frame.players.find((player) => player.id === follower.id)).toBeDefined()
    expect(elapsed).toBeLessThan(1_000)
  })
})
