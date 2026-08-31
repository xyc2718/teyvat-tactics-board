import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { AttackAction, EZoneAction, MoveAction, PassAction, QMoveAction, ShootAction } from '../model/types'
import { movementDuration, passDuration, shotDuration } from './durations'
import { analyzeDocumentIceQHits, effectiveQPath, evaluateQDistanceEffect, projectFrame } from './projectFrame'
import { waterQMoveBoost } from './movementEffects'

describe('timeline defaults', () => {
  it('uses 1 grid/s movement and 8 grid/s passing', () => {
    const document = createDefaultDocument()
    expect(movementDuration([{ x: 0, y: 0 }, { x: 4, y: 0 }], document.rulesSnapshot)).toBe(4)
    expect(passDuration([{ x: 0, y: 0 }, { x: 4, y: 0 }], document.rulesSnapshot)).toBe(0.5)
    expect(passDuration([{ x: 0, y: 0 }, { x: 8, y: 0 }], document.rulesSnapshot)).toBe(1)
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
})

describe('projectFrame', () => {
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
    expect(frame.players.find((player) => player.id === target.id)?.position.x).toBeCloseTo(3.9333)
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

    document.rulesSnapshot.roles.ice.e!.slowMultiplier = 0.25
    expect(projectFrame(document, 4).players.find((player) => player.id === enemy.id)?.position.x).toBeCloseTo(7)
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

  it('reduces only the enemy Q distance authored inside the moving ice zone', () => {
    const document = createDefaultDocument()
    const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    const enemy = document.initialScene.players.find((player) => player.id === 'red-fire')!
    const teammate = document.initialScene.players.find((player) => player.id === 'blue-fire')!
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

  it('does not freeze a target beyond an ice Q endpoint shortened by the enemy zone', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 5, y: 5 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 5, y: 5 }
    document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 8, y: 5 }
    const q: QMoveAction = {
      id: 'shortened-ice-q', type: 'qMove', actorId: 'red-ice', startTime: 1, duration: 1,
      path: [{ x: 5, y: 5 }, { x: 8, y: 5 }],
    }
    document.actions.push(
      { id: 'enemy-zone-for-ice-q', type: 'eZone', actorId: 'blue-ice', center: { x: 19, y: 9 }, radius: 2, startTime: 0, duration: 5 },
      q,
    )

    expect(evaluateQDistanceEffect(document, q).effectiveDistance).toBeCloseTo(2.4, 1)
    expect(analyzeDocumentIceQHits(document, q).some((hit) => hit.targetId === 'blue-water')).toBe(false)
  })

  it('turns overlong passes into a free ball at the configured maximum distance', () => {
    const document = createDefaultDocument()
    const action: PassAction = {
      id: 'pass-long', type: 'pass', actorId: 'blue-water', startTime: 0, duration: 1.5,
      path: [{ x: 5.5, y: 5 }, { x: 17.5, y: 5 }],
    }
    document.actions.push(action)
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
