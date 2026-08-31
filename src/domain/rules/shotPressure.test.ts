import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { PlayerState, ProjectedFrame, ShootAction } from '../model/types'
import { projectFrame } from '../timeline/projectFrame'
import { evaluateShotActionPressure, evaluateShotPressure, radialDistanceToAttackAnnulus, shotPressureComparison } from './shotPressure'

function pressureFrame(players: PlayerState[]): ProjectedFrame {
  return {
    players,
    ball: { position: { x: 0, y: 0 }, carrierId: null, isFree: true },
    statuses: [],
    time: 0,
    cooldowns: Object.fromEntries(players.map((player) => [player.id, { q: 0, e: 0 }])),
    shots: [],
  }
}

function player(id: string, team: 'blue' | 'red', role: 'water' | 'fire' | 'ice', x: number): PlayerState {
  return { id, name: id, team, role, position: { x, y: 5 }, facing: 0, hasBall: false }
}

describe('shot pressure', () => {
  it('measures entry into an attack annulus, including water being too close', () => {
    expect(radialDistanceToAttackAnnulus(3, 0.2, 1)).toMatchObject({ distance: 2, relation: 'outside' })
    expect(radialDistanceToAttackAnnulus(0.5, 0.2, 1)).toMatchObject({ distance: 0, relation: 'inside' })
    expect(radialDistanceToAttackAnnulus(0.1, 0.2, 1)).toMatchObject({ distance: 0.1, relation: 'tooClose' })
    expect(radialDistanceToAttackAnnulus(0.2, 0.2, 1)).toMatchObject({ distance: 0, relation: 'inside' })
    expect(radialDistanceToAttackAnnulus(1, 0.2, 1)).toMatchObject({ distance: 0, relation: 'inside' })
  })

  it('chooses direct running when it beats an ice dash and Q when a ready blink wins', () => {
    const rules = createDefaultDocument().rulesSnapshot
    const shooter = player('shooter', 'blue', 'fire', 10)
    const closeIce = player('ice', 'red', 'ice', 11)
    const farWater = player('water', 'red', 'water', 13)
    const result = evaluateShotPressure(pressureFrame([shooter, closeIce, farWater]), shooter.id, rules, 0.8)!

    expect(result.defenders.find((item) => item.defender.id === closeIce.id)).toMatchObject({
      radialEntryDistance: 0.5,
      directTime: 0.5,
      qTime: 1,
      mode: 'direct',
    })
    expect(result.defenders.find((item) => item.defender.id === farWater.id)).toMatchObject({
      radialEntryDistance: 2,
      qTime: 0,
      mode: 'q',
    })
    expect(result.earliest?.defender.id).toBe(farWater.id)
    expect(result.isRisk).toBe(true)
  })

  it('ticks Q cooldown during freeze, walks while waiting, and then applies residual walking', () => {
    const rules = createDefaultDocument().rulesSnapshot
    const shooter = player('shooter', 'blue', 'ice', 10)
    const defender = player('defender', 'red', 'fire', 16)
    const frame = pressureFrame([shooter, defender])
    frame.time = 2
    frame.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'q', startsAt: 1, endsAt: 3.5 })
    frame.cooldowns[defender.id]!.q = 3

    const result = evaluateShotPressure(frame, shooter.id, rules, 1.6)!.earliest!
    expect(result).toMatchObject({
      radialEntryDistance: 4.5,
      frozenDelay: 1.5,
      qCooldownAtStart: 3,
      qCooldownAfterFreeze: 1.5,
      walkDuringCooldown: 1.5,
      qDistanceUsed: 2.3,
      qTime: 3.7,
      directTime: 6,
      mode: 'q',
    })
    expect(result.residualWalkDistance).toBeCloseTo(0.7)
  })

  it('accounts for configurable base speed and the full one-second ice Q duration', () => {
    const rules = createDefaultDocument().rulesSnapshot
    rules.field.baseMoveSpeed = 2
    const shooter = player('shooter', 'blue', 'water', 10)
    const defender = player('defender', 'red', 'ice', 13)
    const result = evaluateShotPressure(pressureFrame([shooter, defender]), shooter.id, rules, 0.8)!.earliest!
    expect(result.radialEntryDistance).toBe(2.5)
    expect(result.directTime).toBe(1.25)
    expect(result.qTime).toBe(1)
    expect(result.mode).toBe('q')
  })

  it('uses instant fire Q, keeps direct mode on a tie, and treats charge equality as risk', () => {
    const rules = createDefaultDocument().rulesSnapshot
    const shooter = player('shooter', 'blue', 'water', 10)
    const fire = player('fire', 'red', 'fire', 13.8)
    const qResult = evaluateShotPressure(pressureFrame([shooter, fire]), shooter.id, rules, 0.8)!.earliest!
    expect(qResult).toMatchObject({ qDistanceUsed: 2.3, qDuration: 0, mode: 'q' })
    expect(qResult.radialEntryDistance).toBeCloseTo(2.3)
    expect(qResult.qTime).toBeCloseTo(0)

    rules.roles.fire.q.duration = 2.3
    const tie = evaluateShotPressure(pressureFrame([shooter, fire]), shooter.id, rules, 2.3)!
    expect(tie.earliest).toMatchObject({ mode: 'direct' })
    expect(tie.earliest?.directTime).toBeCloseTo(2.3)
    expect(tie.earliest?.qTime).toBeCloseTo(2.3)
    expect(tie.earliest?.earliestTime).toBeCloseTo(2.3)
    expect(tie.isRisk).toBe(true)
    expect(shotPressureComparison(tie)).toBe('风险 · 不晚于蓄力完成 0s')
  })

  it('uses projected positions, statuses, cooldowns and all opponents at shot start', () => {
    const document = createDefaultDocument()
    const shooter = document.initialScene.players.find((candidate) => candidate.id === 'blue-water')!
    shooter.position = { x: 16, y: 5 }
    document.actions.push({ id: 'defender-move', type: 'move', actorId: 'red-fire', startTime: 0, duration: 2, path: [{ x: 14.5, y: 5 }, { x: 18, y: 5 }] })
    const frame = projectFrame(document, 2)
    const result = evaluateShotPressure(frame, shooter.id, document.rulesSnapshot, 0.8)!
    expect(result.earliest?.defender.id).toBe('red-fire')
    expect(result.earliest?.gap).toBeCloseTo(2)
  })

  it('recomputes action pressure after status, role, rule, timing and charge edits', () => {
    const document = createDefaultDocument()
    const shooter = document.initialScene.players.find((candidate) => candidate.id === 'blue-water')!
    const defender = document.initialScene.players.find((candidate) => candidate.id === 'red-water')!
    shooter.position = { x: 10, y: 5 }
    defender.position = { x: 13, y: 5 }
    document.initialScene.statuses.push({
      id: 'active-freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 2,
    })
    const shot: ShootAction = {
      id: 'editable-pressure', type: 'shoot', actorId: shooter.id, charge: 'yellow', startTime: 1, duration: 0.8,
      path: [{ ...shooter.position }, { x: 20, y: 5 }],
    }
    document.actions.push(shot)

    expect(evaluateShotActionPressure(document, shot)?.earliest).toMatchObject({ frozenDelay: 1, qTime: 1 })
    defender.role = 'ice'
    expect(evaluateShotActionPressure(document, shot)?.earliest).toMatchObject({ qDuration: 1, qTime: 2 })
    document.rulesSnapshot.roles.ice.q.duration = 0.5
    expect(evaluateShotActionPressure(document, shot)?.earliest).toMatchObject({ qDuration: 0.5, qTime: 1.5 })
    shot.startTime = 2
    shot.duration = 1
    const updated = evaluateShotActionPressure(document, shot)!
    expect(updated.earliest).toMatchObject({ frozenDelay: 0, qTime: 0.5 })
    expect(updated.isRisk).toBe(true)
  })
})
