import { describe, expect, it } from 'vitest'
import { distance } from '../geometry/geometry'
import { createDefaultDocument } from '../model/createDocument'
import type { AttackAction, EZoneAction, MoveAction, PassAction, QMoveAction, ShootAction } from '../model/types'
import { movementDuration, passArrivalTimeAtDistance, passDuration, shotDuration } from './durations'
import { timelineJointTimes } from './keyframes'
import { analyzeDocumentIceQHits, documentFreezeWindows, documentSlowWindows, effectiveQPath, evaluateQDistanceEffect, eZoneSlowSegmentsForMove, projectedMovePath, projectFrame, projectFrameAtKeyframe, statusSlowSegmentsForMove } from './projectFrame'
import { receiveMoveBoost, waterQMoveBoost } from './movementEffects'

describe('timeline defaults', () => {
  it('uses 1 grid/s movement and an 8-grid, 1-second decelerating pass', () => {
    const document = createDefaultDocument()
    const passPath = [{ x: 0, y: 0 }, { x: 8, y: 0 }]
    expect(movementDuration([{ x: 0, y: 0 }, { x: 4, y: 0 }], document.rulesSnapshot)).toBe(4)
    expect(passDuration([{ x: 0, y: 0 }, { x: 4, y: 0 }], document.rulesSnapshot)).toBeCloseTo(1 - Math.sqrt(0.5))
    expect(passDuration(passPath, document.rulesSnapshot)).toBe(1)
    expect(passDuration([{ x: 0, y: 0 }, { x: 12, y: 0 }], document.rulesSnapshot)).toBe(1)
    expect(passArrivalTimeAtDistance(passPath, 6, document.rulesSnapshot)).toBeCloseTo(0.5)
    expect(passArrivalTimeAtDistance(passPath, 8, document.rulesSnapshot)).toBeCloseTo(1)
  })

  it('uses inner and outer shooting charge times', () => {
    const document = createDefaultDocument()
    const player = document.initialScene.players[0]!
    player.position = { x: 17, y: 5 }
    expect(shotDuration(player, 'yellow', document.rulesSnapshot)).toBe(0.4)
    expect(shotDuration(player, 'red', document.rulesSnapshot)).toBe(0.8)
    player.position = { x: 14, y: 5 }
    expect(shotDuration(player, 'yellow', document.rulesSnapshot)).toBe(0.8)
    expect(shotDuration(player, 'red', document.rulesSnapshot)).toBe(1.6)
  })

  it('keeps ice Q distance, travel time, cooldown, and freeze time as separate rule values', () => {
    const iceQ = createDefaultDocument().rulesSnapshot.roles.ice.q
    expect(iceQ).toMatchObject({
      maxDistance: 3,
      duration: 1,
      cooldown: 7,
      freezeDuration: 1.75,
    })
  })
})

describe('projectFrame', () => {
  it('applies target-only hang ice to ordinary movement without slowing Q', () => {
    const document = createDefaultDocument()
    const player = document.initialScene.players.find((candidate) => candidate.id === 'blue-water')!
    const slow = document.rulesSnapshot.roles.ice.slow!
    const run: MoveAction = {
      id: 'hang-ice-run', type: 'move', actorId: player.id, startTime: 0, duration: slow.duration,
      path: [{ ...player.position }, { x: player.position.x + slow.duration, y: player.position.y }],
    }
    document.actions.push(
      run,
      {
        id: 'hang-ice', type: 'status', targetId: player.id, status: 'slowed', startTime: 0,
        duration: slow.duration, separationDelta: -slow.fullSeparationLoss,
      },
      // A second overlapping application must not double the slowdown.
      {
        id: 'overlapping-hang-ice', type: 'status', targetId: player.id, status: 'slowed', startTime: 1,
        duration: slow.duration, separationDelta: -slow.fullSeparationLoss,
      },
    )

    expect(projectFrame(document, slow.duration).players.find((candidate) => candidate.id === player.id)?.position.x)
      .toBeCloseTo(player.position.x + slow.duration - slow.fullSeparationLoss, 2)
    expect(documentSlowWindows(document, player.id)).toHaveLength(2)
    expect(statusSlowSegmentsForMove(document, run)).not.toHaveLength(0)

    const qDocument = createDefaultDocument()
    const qPlayer = qDocument.initialScene.players.find((candidate) => candidate.id === 'blue-water')!
    qDocument.actions.push(
      { id: 'q-hang-ice', type: 'status', targetId: qPlayer.id, status: 'slowed', startTime: 0, duration: slow.duration },
      {
        id: 'q-while-slowed', type: 'qMove', actorId: qPlayer.id, startTime: 0, duration: 0,
        path: [{ ...qPlayer.position }, { x: qPlayer.position.x + 2, y: qPlayer.position.y }],
      },
    )
    expect(projectFrame(qDocument, 0).players.find((candidate) => candidate.id === qPlayer.id)?.position.x)
      .toBeCloseTo(qPlayer.position.x + 2)
  })

  it('treats an explicit move duration as an exact arrival contract', () => {
    const document = createDefaultDocument()
    document.actions.push(
      {
        id: 'fixed-arrival', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 4,
        path: [{ x: 3.5, y: 7 }, { x: 7.5, y: 7 }], timingConstraint: { kind: 'fixed' },
      },
      {
        id: 'enemy-ice-field', type: 'eZone', actorId: 'red-ice', startTime: 0, duration: 6,
        center: { x: 15.5, y: 9.3 }, radius: 20,
      },
    )

    expect(projectFrame(document, 2).players.find((player) => player.id === 'blue-fire')?.position.x).toBeCloseTo(5.5)
    expect(projectFrame(document, 4).players.find((player) => player.id === 'blue-fire')?.position.x).toBeCloseTo(7.5)
    expect(eZoneSlowSegmentsForMove(document, document.actions[0] as MoveAction)).toEqual([])
  })

  it('projects a pass with linearly decreasing speed', () => {
    const document = createDefaultDocument()
    const action: PassAction = {
      id: 'decelerating-pass', type: 'pass', actorId: 'blue-water', startTime: 0, duration: 1,
      path: [{ x: 5.5, y: 5 }, { x: 13.5, y: 5 }],
    }
    document.actions.push(action)

    expect(projectFrame(document, 0.5).ball.position.x).toBeCloseTo(11.5)
    expect(projectFrame(document, 1).ball.position.x).toBeCloseTo(13.5)

    const short = createDefaultDocument()
    const shortPath = [{ x: 5.5, y: 5 }, { x: 9.5, y: 5 }]
    const shortDuration = passDuration(shortPath, short.rulesSnapshot)
    short.actions.push({
      id: 'short-decelerating-pass', type: 'pass', actorId: 'blue-water', startTime: 0,
      duration: shortDuration, path: shortPath,
    })
    expect(projectFrame(short, shortDuration / 2).ball.position.x).toBeCloseTo(7.6716, 3)
    expect(projectFrame(short, shortDuration).ball.position.x).toBeCloseTo(9.5)
  })

  it('normalizes possession flags from the ball carrier and attaches the ball to that player', () => {
    const document = createDefaultDocument()
    const carrier = document.initialScene.players.find((player) => player.id === 'red-fire')!
    for (const player of document.initialScene.players) player.hasBall = player.id === 'blue-water'
    document.initialScene.ball = { carrierId: carrier.id, position: { x: 1, y: 1 }, isFree: true }

    const frame = projectFrame(document, 0)
    expect(frame.ball).toMatchObject({ carrierId: carrier.id, position: carrier.position, isFree: false })
    expect(frame.players.filter((player) => player.hasBall).map((player) => player.id)).toEqual([carrier.id])
  })

  it('projects normal movement deterministically at arbitrary time', () => {
    const document = createDefaultDocument()
    const action: MoveAction = {
      id: 'move-1', type: 'move', actorId: 'blue-water', startTime: 0, duration: 2,
      path: [{ x: 5.5, y: 5 }, { x: 7.5, y: 5 }],
    }
    document.actions.push(action)
    expect(projectFrame(document, 1).players.find((player) => player.id === action.actorId)?.position.x).toBeCloseTo(6.5)
    expect(projectFrame(document, 0.25).players.find((player) => player.id === action.actorId)?.position.x).toBeCloseTo(5.75)
  })

  it('projects an adjustable curved run through its Bezier arc', () => {
    const document = createDefaultDocument()
    const action: MoveAction = {
      id: 'curve-1', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2.3,
      path: [{ x: 3.5, y: 2.7 }, { x: 5.5, y: 2.7 }], curveControl: { x: 4.5, y: 4.7 },
    }
    document.actions.push(action)
    const middle = projectFrame(document, action.duration / 2).players.find((player) => player.id === action.actorId)
    expect(middle?.position.x).toBeCloseTo(4.5, 1)
    expect(middle?.position.y).toBeGreaterThan(3.5)
    expect(projectFrame(document, action.duration).players.find((player) => player.id === action.actorId)?.position).toEqual({ x: 5.5, y: 2.7 })
  })

  it('applies water Q instantly and tracks its cooldown and boost', () => {
    const document = createDefaultDocument()
    const action: QMoveAction = {
      id: 'q-water', type: 'qMove', actorId: 'blue-water', startTime: 1, duration: 0,
      path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }],
    }
    document.actions.push(action)
    const frame = projectFrame(document, 1)
    expect(frame.players.find((player) => player.id === action.actorId)?.position.x).toBe(8)
    expect(frame.cooldowns[action.actorId]?.q).toBe(7)
    expect(projectFrame(document, 2).statuses.some((status) => status.kind === 'boosted')).toBe(true)
  })

  it('projects both semantic edges of an instantaneous water Q at one rules time', () => {
    const document = createDefaultDocument()
    const actor = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const origin = { ...actor.position }
    const endpoint = { x: origin.x + 2.5, y: origin.y }
    document.actions.push({
      id: 'semantic-water-q', type: 'qMove', actorId: actor.id, startTime: 1, duration: 0,
      path: [origin, endpoint],
    })

    const before = projectFrameAtKeyframe(document, 1, {
      playerId: actor.id, actionId: 'semantic-water-q', edge: 'start',
    })
    const after = projectFrameAtKeyframe(document, 1, {
      playerId: actor.id, actionId: 'semantic-water-q', edge: 'end',
    })

    expect(before.players.find((player) => player.id === actor.id)?.position).toEqual(origin)
    expect(before.ball.position).toEqual(origin)
    expect(before.cooldowns[actor.id]?.q).toBe(0)
    expect(before.statuses.some((status) => status.sourceActionId === 'semantic-water-q')).toBe(false)
    expect(after.players.find((player) => player.id === actor.id)?.position).toEqual(endpoint)
    expect(after.ball.position).toEqual(endpoint)
    expect(after.cooldowns[actor.id]?.q).toBe(7)
  })

  it('plays ice Q for one second then freezes and moves the target opposite its facing', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'red-water')!
    target.position = { x: 6.8, y: 7.3 }
    target.facing = 180
    const action: QMoveAction = {
      id: 'q-ice', type: 'qMove', actorId: 'blue-ice', targetId: target.id, startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    }
    document.actions.push(action)
    expect(projectFrame(document, 0.5).players.find((player) => player.id === action.actorId)?.position.x).toBeCloseTo(5)
    const hitFrame = projectFrame(document, 1.2)
    expect(hitFrame.statuses.some((status) => status.playerId === target.id && status.kind === 'frozen')).toBe(true)
    expect(hitFrame.players.find((player) => player.id === target.id)?.position.x).toBeCloseTo(7.25)
  })

  it('derives ice-Q freeze start and end as editable timeline joints', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'red-water')!
    target.position = { x: 6.8, y: 7.3 }
    document.actions.push({
      id: 'timeline-freeze',
      type: 'qMove',
      actorId: 'blue-ice',
      startTime: 0,
      duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    })

    expect(documentFreezeWindows(document, target.id)).toEqual([
      expect.objectContaining({
        playerId: target.id,
        sourceActionId: 'timeline-freeze',
        startsAt: 1,
        endsAt: 2.75,
      }),
    ])
    expect(timelineJointTimes(document)).toEqual(expect.arrayContaining([1, 2.75]))
  })

  it('does not freeze a target outside the ice attack radius at the dash endpoint', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'red-water')!
    target.position = { x: 10, y: 7.3 }
    const action: QMoveAction = {
      id: 'q-ice-miss', type: 'qMove', actorId: 'blue-ice', targetId: target.id, startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    }
    document.actions.push(action)
    const frame = projectFrame(document, 1.2)
    expect(frame.statuses.some((status) => status.playerId === target.id && status.kind === 'frozen')).toBe(false)
    expect(frame.players.find((player) => player.id === target.id)?.position).toEqual(target.position)
  })

  it('freezes every opponent crossed by an ice Q even without a legacy targetId', () => {
    const document = createDefaultDocument()
    const first = document.initialScene.players.find((player) => player.id === 'red-water')!
    const second = document.initialScene.players.find((player) => player.id === 'red-fire')!
    first.position = { x: 4.5, y: 7.8 }
    second.position = { x: 6.5, y: 7.8 }
    const action: QMoveAction = {
      id: 'multi-hit', type: 'qMove', actorId: 'blue-ice', startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    }
    document.actions.push(action)

    const early = projectFrame(document, 0.2)
    expect(early.statuses.some((status) => status.kind === 'frozen')).toBe(false)
    const complete = projectFrame(document, 1.1)
    expect(complete.statuses.filter((status) => status.kind === 'frozen').map((status) => status.playerId).sort()).toEqual(['red-fire', 'red-water'])
  })

  it('does not freeze an opponent who stays ahead while moving along the same Q path', () => {
    const document = createDefaultDocument()
    const actor = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    const target = document.initialScene.players.find((player) => player.id === 'red-ice')!
    actor.position = { x: 3.5, y: 7.3 }
    target.position = { x: 4.5, y: 7.3 }
    const q: QMoveAction = {
      id: 'moving-target-miss', type: 'qMove', actorId: actor.id, startTime: 0, duration: 1,
      path: [{ ...actor.position }, { x: 6.5, y: 7.3 }],
    }
    const targetMove: MoveAction = {
      id: 'moving-target-run', type: 'move', actorId: target.id, startTime: 0, duration: 1,
      path: [{ ...target.position }, { x: 7.5, y: 7.3 }],
      timingConstraint: { kind: 'fixed' },
    }
    document.actions.push(q, targetMove)

    expect(analyzeDocumentIceQHits(document, q).some((hit) => hit.targetId === target.id)).toBe(false)
    const frame = projectFrame(document, 1.1)
    expect(frame.statuses.some((status) => status.playerId === target.id && status.kind === 'frozen')).toBe(false)
    expect(frame.players.find((player) => player.id === target.id)?.position.x).toBeCloseTo(7.5)
  })

  it('uses the opponent position at the same instant when a moving target crosses an ice Q', () => {
    const document = createDefaultDocument()
    const actor = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    const target = document.initialScene.players.find((player) => player.id === 'red-ice')!
    actor.position = { x: 3.5, y: 7.3 }
    target.position = { x: 6.5, y: 7.3 }
    const q: QMoveAction = {
      id: 'moving-target-hit', type: 'qMove', actorId: actor.id, startTime: 0, duration: 1,
      path: [{ ...actor.position }, { x: 6.5, y: 7.3 }],
    }
    const targetMove: MoveAction = {
      id: 'moving-target-cross', type: 'move', actorId: target.id, startTime: 0, duration: 1,
      path: [{ ...target.position }, { x: 4.5, y: 7.3 }],
      timingConstraint: { kind: 'fixed' },
    }
    document.actions.push(q, targetMove)

    const hit = analyzeDocumentIceQHits(document, q).find((candidate) => candidate.targetId === target.id)
    expect(hit).toBeDefined()
    expect(hit?.hitTime).toBeCloseTo(0.6)
    expect(hit?.target.position.x).toBeCloseTo(5.3)
  })

  it('uses projected positions at ice-Q start and recomputes hits after path, rule, timing, or role edits', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'red-water')!
    const setupMove: MoveAction = {
      id: 'target-setup', type: 'move', actorId: target.id, startTime: 0, duration: 1,
      path: [{ x: 10, y: 7.3 }, { x: 6.8, y: 7.3 }],
    }
    const q: QMoveAction = {
      id: 'editable-ice-q', type: 'qMove', actorId: 'blue-ice', startTime: 2, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    }
    document.actions.push(setupMove, q)

    expect(analyzeDocumentIceQHits(document, q).map((hit) => hit.targetId)).toContain(target.id)
    expect(analyzeDocumentIceQHits(document, q).find((hit) => hit.targetId === target.id)?.hitTime).toBeCloseTo(3)
    q.startTime = 4
    expect(analyzeDocumentIceQHits(document, q).find((hit) => hit.targetId === target.id)?.hitTime).toBeCloseTo(5)
    q.path = [{ x: 3.5, y: 6 }, { x: 6.5, y: 6 }]
    expect(analyzeDocumentIceQHits(document, q)).toEqual([])
    q.path = [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }]
    document.rulesSnapshot.roles.ice.attackRadius = 0.1
    expect(analyzeDocumentIceQHits(document, q)).toEqual([])
    document.rulesSnapshot.roles.ice.attackRadius = 0.5
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.role = 'fire'
    expect(analyzeDocumentIceQHits(document, q)).toEqual([])
  })

  it('ignores a stale legacy targetId while applying full-path hits to actual opponents', () => {
    const document = createDefaultDocument()
    const legacyTarget = document.initialScene.players.find((player) => player.id === 'red-water')!
    const crossed = document.initialScene.players.find((player) => player.id === 'red-fire')!
    legacyTarget.position = { x: 14, y: 1 }
    crossed.position = { x: 5, y: 7.8 }
    const q: QMoveAction = {
      id: 'legacy-target-q', type: 'qMove', actorId: 'blue-ice', targetId: legacyTarget.id, startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    }
    document.actions.push(q)

    const frame = projectFrame(document, 1.1)
    expect(frame.statuses.some((status) => status.playerId === crossed.id && status.kind === 'frozen')).toBe(true)
    expect(frame.statuses.some((status) => status.playerId === legacyTarget.id && status.kind === 'frozen')).toBe(false)
  })

  it('applies repeated ice-Q knockback once per hit and interrupts an overlapping move', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'red-water')!
    target.position = { x: 4.5, y: 7.8 }
    target.facing = 0
    const targetMove: MoveAction = {
      id: 'interrupted-target-move', type: 'move', actorId: target.id, startTime: 0, duration: 5,
      path: [{ ...target.position }, { x: 9.5, y: 7.8 }],
    }
    const first: QMoveAction = {
      id: 'first-hit', type: 'qMove', actorId: 'blue-ice', startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    }
    const second: QMoveAction = {
      ...first, id: 'second-hit', startTime: 3,
    }
    document.actions.push(targetMove, first, second)

    const firstHit = analyzeDocumentIceQHits(document, first).find((hit) => hit.targetId === target.id)!
    const secondHit = analyzeDocumentIceQHits(document, second).find((hit) => hit.targetId === target.id)!
    const frame = projectFrame(document, 4.1)
    expect(firstHit).toBeDefined()
    expect(secondHit).toBeDefined()
    expect(frame.players.find((player) => player.id === target.id)?.position.x).toBeCloseTo(4.1)
  })

  it('shares the configured water-Q overlap between projection and route analysis', () => {
    const document = createDefaultDocument()
    const q: QMoveAction = { id: 'water-overlap-q', type: 'qMove', actorId: 'blue-water', startTime: 1, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] }
    const move: MoveAction = { id: 'water-overlap-move', type: 'move', actorId: 'blue-water', startTime: 1, duration: 6, path: [{ x: 8, y: 5 }, { x: 14, y: 5 }] }
    document.actions.push(q, move)
    const effect = waterQMoveBoost(document, move)

    expect(effect?.overlapStart).toBe(1)
    expect(effect?.overlapEnd).toBeCloseTo(5.3)
    expect(effect?.separationGain).toBeCloseTo(0.8)
    expect(effect?.path.at(-1)?.x).toBeCloseTo(13.1)
    expect(projectFrame(document, 5.3).players.find((player) => player.id === 'blue-water')?.position.x).toBeCloseTo(13.1)
  })

  it('shares the solved ice receive-boost interval between projection and route analysis', () => {
    const document = createDefaultDocument()
    const pass: PassAction = {
      id: 'ice-reception-pass', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice', startTime: 0.5, duration: 0.5,
      path: [{ x: 5.5, y: 5 }, { x: 3.5, y: 9.3 }],
    }
    const move: MoveAction = {
      id: 'ice-reception-run', type: 'move', actorId: 'blue-ice', startTime: 0.5, duration: 6,
      path: [{ x: 3.5, y: 9.3 }, { x: 9.5, y: 9.3 }],
    }
    document.actions.push(pass, move)
    const effect = receiveMoveBoost(document, move)

    expect(effect?.sourceActionId).toBe(pass.id)
    expect(effect?.overlapStart).toBe(1)
    expect(effect?.overlapEnd).toBeCloseTo(5.3)
    expect(effect?.separationGain).toBeCloseTo(0.8)
    expect(effect?.path[0]?.x).toBeCloseTo(4)
    expect(effect?.path.at(-1)?.x).toBeCloseTo(9.1)
    expect(projectFrame(document, 5.3).players.find((player) => player.id === 'blue-ice')?.position.x).toBeCloseTo(9.1)
  })

  it('projects an instantaneous water Q before a same-time move regardless of file action order', () => {
    const document = createDefaultDocument()
    const move: MoveAction = { id: 'move-first-in-file', type: 'move', actorId: 'blue-water', startTime: 0, duration: 5, path: [{ x: 8, y: 5 }, { x: 13, y: 5 }] }
    const q: QMoveAction = { id: 'q-second-in-file', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] }
    document.actions.push(move, q)

    expect(projectFrame(document, 2).players.find((player) => player.id === 'blue-water')?.position.x).toBeCloseTo(10 + (0.8 * 2) / 4.3)
  })

  it('uses the edited movement duration and does not reactivate an expired water boost', () => {
    const document = createDefaultDocument()
    const q: QMoveAction = {
      id: 'water-q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0,
      path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }],
    }
    const move: MoveAction = {
      id: 'late-move', type: 'move', actorId: 'blue-water', startTime: 10, duration: 2,
      path: [{ x: 8, y: 5 }, { x: 12, y: 5 }],
    }
    document.actions.push(q, move)
    expect(projectFrame(document, 11).players.find((player) => player.id === 'blue-water')?.position.x).toBeCloseTo(10)
  })

  it('transfers the ice receive boost only while the ice player actually has it', () => {
    const boosted = createDefaultDocument()
    const receiveIce: PassAction = {
      id: 'to-ice', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice', startTime: 0, duration: 0.5,
      path: [{ x: 5.5, y: 5 }, { x: 3.5, y: 7.3 }],
    }
    const transfer: PassAction = {
      id: 'ice-transfer', type: 'pass', actorId: 'blue-ice', targetPlayerId: 'blue-fire', startTime: 1, duration: 0.5,
      path: [{ x: 3.5, y: 7.3 }, { x: 3.5, y: 2.7 }],
    }
    const move: MoveAction = {
      id: 'boosted-move', type: 'move', actorId: 'blue-fire', startTime: 1.5, duration: 4,
      path: [{ x: 3.5, y: 2.7 }, { x: 7.5, y: 2.7 }],
    }
    boosted.actions.push(receiveIce, transfer, move)
    const boostedX = projectFrame(boosted, 3.5).players.find((player) => player.id === 'blue-fire')!.position.x

    const plain = createDefaultDocument()
    plain.actions.push(transfer, move)
    const plainX = projectFrame(plain, 3.5).players.find((player) => player.id === 'blue-fire')!.position.x
    expect(boostedX).toBeGreaterThan(plainX)
    expect(plainX).toBeCloseTo(5.5)
  })

  it('keeps the ice zone centered on moving Frost and applies its configured speed multiplier to enemies only', () => {
    const document = createDefaultDocument()
    const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    const enemy = document.initialScene.players.find((player) => player.id === 'red-water')!
    const teammate = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    ice.position = { x: 5, y: 5 }
    enemy.position = { x: 6, y: 5 }
    teammate.position = { x: 6, y: 5 }
    const zone: EZoneAction = {
      id: 'ice-zone', type: 'eZone', actorId: ice.id, center: { x: 19, y: 9 }, radius: 2,
      startTime: 0, duration: 5,
    }
    const iceMove: MoveAction = {
      id: 'ice-move', type: 'move', actorId: ice.id, startTime: 0, duration: 4,
      path: [{ x: 5, y: 5 }, { x: 9, y: 5 }],
    }
    const enemyMove: MoveAction = {
      id: 'enemy-move', type: 'move', actorId: enemy.id, startTime: 0, duration: 4,
      path: [{ x: 6, y: 5 }, { x: 10, y: 5 }],
    }
    const teammateMove: MoveAction = {
      id: 'teammate-move', type: 'move', actorId: teammate.id, startTime: 0, duration: 4,
      path: [{ x: 6, y: 5 }, { x: 10, y: 5 }],
    }
    document.actions.push(zone, iceMove, enemyMove, teammateMove)

    const frame = projectFrame(document, 4)
    expect(frame.players.find((player) => player.id === ice.id)?.position.x).toBeCloseTo(9)
    expect(frame.players.find((player) => player.id === enemy.id)?.position.x).toBeCloseTo(8)
    expect(frame.players.find((player) => player.id === teammate.id)?.position.x).toBeCloseTo(10)
    expect(frame.statuses.some((status) => status.playerId === enemy.id && status.kind === 'slowed')).toBe(true)
    expect(projectFrame(document, 5).statuses.some((status) => status.kind === 'slowed')).toBe(false)
    const slowSegments = eZoneSlowSegmentsForMove(document, enemyMove)
    expect(slowSegments).toHaveLength(1)
    expect(slowSegments[0]?.multiplier).toBe(0.5)
    expect(slowSegments[0]?.path[0]?.x).toBeCloseTo(6)
    expect(slowSegments[0]?.path.at(-1)?.x).toBeCloseTo(8)
    expect(eZoneSlowSegmentsForMove(document, teammateMove)).toEqual([])

    document.rulesSnapshot.roles.ice.e!.slowMultiplier = 0.25
    expect(projectFrame(document, 4).players.find((player) => player.id === enemy.id)?.position.x).toBeCloseTo(7)
    expect(eZoneSlowSegmentsForMove(document, enemyMove)[0]?.path.at(-1)?.x).toBeCloseTo(7)
  })

  it('restores enemy move speed after leaving or outlasting the moving ice zone', () => {
    const leftZone = createDefaultDocument()
    leftZone.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 5, y: 5 }
    leftZone.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 6, y: 5 }
    leftZone.actions.push(
      { id: 'leave-zone', type: 'eZone', actorId: 'blue-ice', center: { x: 5, y: 5 }, radius: 2, startTime: 0, duration: 5 },
      { id: 'leave-move', type: 'move', actorId: 'red-water', startTime: 0, duration: 4, path: [{ x: 6, y: 5 }, { x: 10, y: 5 }] },
    )
    expect(projectFrame(leftZone, 4).players.find((player) => player.id === 'red-water')?.position.x).toBeCloseTo(9, 1)

    const expiredZone = structuredClone(leftZone)
    const zone = expiredZone.actions.find((action) => action.id === 'leave-zone')!
    zone.duration = 1
    expect(projectFrame(expiredZone, 4).players.find((player) => player.id === 'red-water')?.position.x).toBeCloseTo(9.5, 1)
  })

  it('reduces only the enemy Water Q distance authored inside the moving ice zone', () => {
    const document = createDefaultDocument()
    const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    const enemy = document.initialScene.players.find((player) => player.id === 'red-water')!
    const teammate = document.initialScene.players.find((player) => player.id === 'blue-water')!
    ice.position = { x: 5, y: 5 }
    enemy.position = { x: 5, y: 5 }
    teammate.position = { x: 5, y: 5 }
    const zone: EZoneAction = {
      id: 'q-zone', type: 'eZone', actorId: ice.id, center: { x: 19, y: 9 }, radius: 2,
      startTime: 0, duration: 5,
    }
    const iceMove: MoveAction = {
      id: 'q-zone-owner-move', type: 'move', actorId: ice.id, startTime: 0, duration: 4,
      path: [{ x: 5, y: 5 }, { x: 9, y: 5 }],
    }
    const enemyQ: QMoveAction = {
      id: 'enemy-q-in-zone', type: 'qMove', actorId: enemy.id, startTime: 2, duration: 0,
      path: [{ x: 5, y: 5 }, { x: 7.3, y: 5 }],
    }
    const friendlyQ: QMoveAction = {
      id: 'friendly-q-in-zone', type: 'qMove', actorId: teammate.id, startTime: 2, duration: 0,
      path: [{ x: 5, y: 5 }, { x: 7.3, y: 5 }],
    }
    document.actions.push(zone, iceMove, enemyQ, friendlyQ)

    const effect = evaluateQDistanceEffect(document, enemyQ)
    expect(effect.authoredDistance).toBeCloseTo(2.3)
    expect(effect.effectiveDistance).toBeCloseTo(1.61, 2)
    expect(effectiveQPath(document, enemyQ).at(-1)?.x).toBeCloseTo(6.61, 2)
    expect(projectFrame(document, 2).players.find((player) => player.id === enemy.id)?.position.x).toBeCloseTo(6.61, 2)
    expect(projectFrame(document, 2).players.find((player) => player.id === teammate.id)?.position.x).toBeCloseTo(7.3, 2)

    document.rulesSnapshot.roles.ice.e!.qDistanceMultiplier = 0.5
    expect(evaluateQDistanceEffect(document, enemyQ).effectiveDistance).toBeCloseTo(1.15, 2)
  })

  it('keeps the outside portion of a partially intersecting enemy Q at full length', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 5, y: 5 }
    document.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 2, y: 5 }
    const zone: EZoneAction = {
      id: 'partial-q-zone', type: 'eZone', actorId: 'blue-ice', center: { x: 18, y: 8 }, radius: 2,
      startTime: 0, duration: 5,
    }
    const q: QMoveAction = {
      id: 'partial-enemy-q', type: 'qMove', actorId: 'red-water', startTime: 1, duration: 0,
      path: [{ x: 2, y: 5 }, { x: 4.5, y: 5 }],
    }
    document.actions.push(zone, q)

    const effect = evaluateQDistanceEffect(document, q)
    // 1 格在圈外保持原长，1.5 格在圈内按 0.7× 折算。
    expect(effect.effectiveDistance).toBeCloseTo(1 + 1.5 * 0.7, 1)
    expect(projectFrame(document, 1).players.find((player) => player.id === 'red-water')?.position.x).toBeCloseTo(4.05, 1)
  })

  it('does not shorten Fire or Ice Q inside the enemy zone', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 5, y: 5 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 5, y: 5 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 5, y: 6 }
    document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 8, y: 5 }
    const iceQ: QMoveAction = {
      id: 'unshortened-ice-q', type: 'qMove', actorId: 'red-ice', startTime: 1, duration: 1,
      path: [{ x: 5, y: 5 }, { x: 8, y: 5 }],
    }
    const fireQ: QMoveAction = {
      id: 'unshortened-fire-q', type: 'qMove', actorId: 'red-fire', startTime: 2, duration: 0,
      path: [{ x: 5, y: 6 }, { x: 7.3, y: 6 }],
    }
    document.actions.push(
      { id: 'enemy-zone-for-ice-q', type: 'eZone', actorId: 'blue-ice', center: { x: 19, y: 9 }, radius: 2, startTime: 0, duration: 5 },
      iceQ,
      fireQ,
    )

    expect(evaluateQDistanceEffect(document, iceQ).effectiveDistance).toBeCloseTo(3)
    expect(evaluateQDistanceEffect(document, fireQ).effectiveDistance).toBeCloseTo(2.3)
    expect(analyzeDocumentIceQHits(document, iceQ).some((hit) => hit.targetId === 'blue-water')).toBe(true)
  })

  it('turns overlong passes into a free ball at the configured maximum distance', () => {
    const document = createDefaultDocument()
    const action: PassAction = {
      id: 'pass-long', type: 'pass', actorId: 'blue-water', startTime: 0,
      duration: passDuration([{ x: 5.5, y: 5 }, { x: 17.5, y: 5 }], document.rulesSnapshot),
      path: [{ x: 5.5, y: 5 }, { x: 17.5, y: 5 }],
    }
    document.actions.push(action)
    expect(action.duration).toBe(1)
    const frame = projectFrame(document, 2)
    expect(frame.ball.isFree).toBe(true)
    expect(frame.ball.carrierId).toBeNull()
    expect(frame.ball.position.x).toBeCloseTo(13.5)
  })

  it('marks a shot interrupted when an in-range attack lands during charging', () => {
    const document = createDefaultDocument()
    const shooter = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const defender = document.initialScene.players.find((player) => player.id === 'red-fire')!
    shooter.position = { x: 14, y: 5 }
    defender.position = { x: 14.9, y: 5 }
    const shot: ShootAction = {
      id: 'shot', type: 'shoot', actorId: shooter.id, charge: 'red', startTime: 0, duration: 1.6,
      path: [{ ...shooter.position }, { x: 20, y: 5 }],
    }
    const attack: AttackAction = { id: 'hit', type: 'attack', actorId: defender.id, targetId: shooter.id, startTime: 0.6, duration: 0 }
    document.actions.push(shot, attack)
    expect(projectFrame(document, 1.6).shots.find((candidate) => candidate.actionId === shot.id)?.interrupted).toBe(true)
  })

  it('respects the water attack annulus inner radius', () => {
    const document = createDefaultDocument()
    const shooter = document.initialScene.players.find((player) => player.id === 'red-fire')!
    const attacker = document.initialScene.players.find((player) => player.id === 'blue-water')!
    shooter.position = { x: 3, y: 5 }
    attacker.position = { x: 3.1, y: 5 }
    const shot: ShootAction = { id: 'annulus-shot', type: 'shoot', actorId: shooter.id, charge: 'red', startTime: 0, duration: 0.8, path: [{ ...shooter.position }, { x: 0, y: 5 }] }
    const attack: AttackAction = { id: 'annulus-hit', type: 'attack', actorId: attacker.id, targetId: shooter.id, startTime: 0.4, duration: 0 }
    document.actions.push(shot, attack)
    expect(projectFrame(document, 0.8).shots.find((candidate) => candidate.actionId === shot.id)?.interrupted).toBe(false)
    attacker.position = { x: 3.5, y: 5 }
    expect(projectFrame(document, 0.8).shots.find((candidate) => candidate.actionId === shot.id)?.interrupted).toBe(true)
  })

  it('does not complete a shot authored outside the large penalty area', () => {
    const document = createDefaultDocument()
    const shooter = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const shot: ShootAction = {
      id: 'outside-shot', type: 'shoot', actorId: shooter.id, charge: 'yellow', startTime: 0, duration: 0.8,
      path: [{ ...shooter.position }, { x: 20, y: 5 }],
    }
    document.actions.push(shot)
    const frame = projectFrame(document, 1)
    expect(frame.shots.find((candidate) => candidate.actionId === shot.id)?.completed).toBe(false)
    expect(frame.ball.carrierId).toBe(shooter.id)
  })
})

describe('close-follow movement', () => {
  it('uses the follower speed and stays on the attack-radius edge after catching up', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    const follower = document.initialScene.players.find((player) => player.id === 'red-fire')!
    target.position = { x: 5, y: 7 }
    follower.position = { x: 9, y: 7 }
    const targetMove: MoveAction = {
      id: 'follow-target-run', type: 'move', actorId: target.id, startTime: 0, duration: 4,
      path: [{ x: 5, y: 7 }, { x: 9, y: 7 }],
    }
    const follow: MoveAction = {
      id: 'close-follow', type: 'move', actorId: follower.id, startTime: 0, duration: 4,
      path: [{ x: 9, y: 7 }, { x: 9, y: 7 }], targetPlayerId: target.id,
      syncActionId: targetMove.id, followGap: 1,
    }
    document.actions.push(targetMove, follow)

    expect(projectFrame(document, 1).players.find((player) => player.id === follower.id)?.position.x).toBeCloseTo(8)
    const endFrame = projectFrame(document, 4)
    const targetEnd = endFrame.players.find((player) => player.id === target.id)!
    const followerEnd = endFrame.players.find((player) => player.id === follower.id)!
    expect(distance(targetEnd.position, followerEnd.position)).toBeCloseTo(1, 1)
    expect(projectedMovePath(document, follow).at(-1)).toEqual(followerEnd.position)
  })

  it('does not stretch follower speed to force a catch at the synchronized end', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const follower = document.initialScene.players.find((player) => player.id === 'red-water')!
    target.position = { x: 5, y: 5 }
    follower.position = { x: 0, y: 5 }
    const targetMove: MoveAction = {
      id: 'fast-target-run', type: 'move', actorId: target.id, startTime: 0, duration: 4,
      path: [{ x: 5, y: 5 }, { x: 13, y: 5 }],
    }
    const follow: MoveAction = {
      id: 'rule-speed-follow', type: 'move', actorId: follower.id, startTime: 0, duration: 4,
      path: [{ x: 0, y: 5 }, { x: 13, y: 5 }], targetPlayerId: target.id,
      syncActionId: targetMove.id, followGap: 1.5,
    }
    document.actions.push(targetMove, follow)

    const endFrame = projectFrame(document, 4)
    expect(endFrame.players.find((player) => player.id === follower.id)?.position.x).toBeCloseTo(4, 1)
    expect(endFrame.players.find((player) => player.id === target.id)?.position.x).toBeCloseTo(13)
  })

  it('recomputes the derived follow route when the target route changes', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    const follower = document.initialScene.players.find((player) => player.id === 'red-fire')!
    target.position = { x: 5, y: 7 }
    follower.position = { x: 9, y: 7 }
    const targetMove: MoveAction = {
      id: 'editable-target-run', type: 'move', actorId: target.id, startTime: 0, duration: 4,
      path: [{ x: 5, y: 7 }, { x: 9, y: 7 }],
    }
    const follow: MoveAction = {
      id: 'derived-follow-route', type: 'move', actorId: follower.id, startTime: 0, duration: 4,
      path: [{ x: 9, y: 7 }, { x: 9, y: 7 }], targetPlayerId: target.id,
      syncActionId: targetMove.id, followGap: 1,
    }
    document.actions.push(targetMove, follow)

    const originalEnd = projectedMovePath(document, follow).at(-1)!
    targetMove.path[1] = { x: 7, y: 9 }
    const revisedEnd = projectedMovePath(document, follow).at(-1)!

    expect(revisedEnd).not.toEqual(originalEnd)
    expect(revisedEnd.y).toBeGreaterThan(originalEnd.y)
  })
})
