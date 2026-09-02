import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { EZoneAction, MoveAction, PassAction, QMoveAction, ShootAction } from '../model/types'
import { evaluateMatchup, evaluateWarnings } from './evaluateRules'

describe('rule assistance', () => {
  it('uses the configured directional default matchup matrix', () => {
    expect(createDefaultDocument().rulesSnapshot.matchups).toEqual({
      water: { water: 1, fire: -2, ice: 1 },
      fire: { water: 0, fire: 0, ice: 1 },
      ice: { water: -1, fire: 0, ice: 1 },
    })
  })

  it.each([
    [3, 'info'],
    [6, 'warning'],
    [9, 'hard'],
  ] as const)('classifies a %s-grid pass as %s', (length, severity) => {
    const document = createDefaultDocument()
    const pass: PassAction = {
      id: `pass-${length}`, type: 'pass', actorId: 'blue-water', startTime: 0, duration: length / 8,
      path: [{ x: 5, y: 5 }, { x: 5 + length, y: 5 }],
    }
    document.actions.push(pass)
    expect(evaluateWarnings(document).find((warning) => warning.actionId === pass.id)?.severity).toBe(severity)
  })

  it('reports a repeated Q inside the configured cooldown window', () => {
    const document = createDefaultDocument()
    const first: QMoveAction = { id: 'q1', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5, y: 5 }, { x: 7, y: 5 }] }
    const second: QMoveAction = { ...first, id: 'q2', startTime: 5, path: [{ x: 7, y: 5 }, { x: 9, y: 5 }] }
    document.actions.push(first, second)
    expect(evaluateWarnings(document).some((warning) => warning.id === 'q-cd-q2')).toBe(true)
  })

  it('reports the shared multiple-Q pass threat level without downgrading its label', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 10.5, y: 7 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 10.5, y: 6.8 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 20, y: 10 }
    const pass: PassAction = {
      id: 'multi-q-pass',
      type: 'pass',
      actorId: 'blue-water',
      startTime: 0,
      duration: 1,
      path: [{ x: 5.5, y: 5 }, { x: 13.5, y: 5 }],
    }
    document.actions.push(pass)

    const warning = evaluateWarnings(document).find((candidate) => candidate.actionId === pass.id)
    expect(warning?.title).toContain('多名')
    expect(warning?.detail).toContain('多人 Q 可达')
  })

  it('keeps hard facts separate from a configurable matchup rating', () => {
    const document = createDefaultDocument()
    const attacker = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const defender = document.initialScene.players.find((player) => player.id === 'red-water')!
    attacker.position = { x: 17, y: 5 }
    defender.position = { x: 18, y: 5 }
    const result = evaluateMatchup(document, 0, attacker.id, defender.id)
    expect(result?.base).toBe(1)
    expect(result?.facts.some((fact) => fact.includes('双方距离'))).toBe(true)
    expect(result?.facts.some((fact) => fact.includes('距防守方球门'))).toBe(true)
    expect(result?.final).not.toBeNull()
  })

  it.each([
    ['blue', 'blue-water', 'red-water', 10.8, 14, false],
    ['blue', 'blue-water', 'red-water', 16, 14, true],
    ['red', 'red-water', 'blue-water', 9.2, 6, false],
    ['red', 'red-water', 'blue-water', 4, 6, true],
  ] as const)(
    'uses goal-side depth for %s attacking separation instead of mutual distance',
    (_team, attackerId, defenderId, attackerX, defenderX, expectedAdvantage) => {
      const document = createDefaultDocument()
      const attacker = document.initialScene.players.find((player) => player.id === attackerId)!
      const defender = document.initialScene.players.find((player) => player.id === defenderId)!
      attacker.position = { x: attackerX, y: 7 }
      defender.position = { x: defenderX, y: 7 }

      const result = evaluateMatchup(document, 0, attacker.id, defender.id)
      const hasSeparationAdvantage = result?.appliedModifiers.some(
        (modifier) => modifier.condition === 'separationAdvantage',
      )

      expect(hasSeparationAdvantage).toBe(expectedAdvantage)
    },
  )

  it('warns when an ice Q target is unreachable and when an enemy runner enters a moving ice zone', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 10, y: 5 }
    const miss: QMoveAction = {
      id: 'miss', type: 'qMove', actorId: 'blue-ice', targetId: 'red-water', startTime: 6, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    }
    const zone: EZoneAction = { id: 'zone', type: 'eZone', actorId: 'blue-ice', center: { x: 10, y: 5 }, radius: 2, startTime: 0, duration: 5 }
    const chase: MoveAction = { id: 'chase', type: 'move', actorId: 'red-water', startTime: 0, duration: 6, path: [{ x: 14.5, y: 5 }, { x: 8.5, y: 5 }] }
    document.actions.push(miss, zone, chase)
    const ids = evaluateWarnings(document).map((warning) => warning.id)
    expect(ids).toContain('ice-q-miss-miss')
    expect(ids).toContain('slow-chase-zone-chase')
  })

  it('warns with authored and effective distances when an enemy Q crosses an ice zone', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 5, y: 5 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 5, y: 5 }
    document.actions.push(
      { id: 'q-slow-zone', type: 'eZone', actorId: 'blue-ice', center: { x: 19, y: 9 }, radius: 2, startTime: 0, duration: 5 },
      { id: 'q-through-zone', type: 'qMove', actorId: 'red-fire', startTime: 1, duration: 0, path: [{ x: 5, y: 5 }, { x: 7.3, y: 5 }] },
    )

    const warning = evaluateWarnings(document).find((candidate) => candidate.id === 'q-slowed-by-e-q-through-zone')
    expect(warning?.title).toBe('Q 经过敌方随身冰圈')
    expect(warning?.detail).toContain('原路径 2.30 格')
    expect(warning?.detail).toContain('实际位移为 1.70 格')
  })

  it('recomputes the ice-Q facing warning when the target turns', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'red-water')!
    target.position = { x: 4.5, y: 7.8 }
    const q: QMoveAction = {
      id: 'facing-q', type: 'qMove', actorId: 'blue-ice', startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    }
    document.actions.push(q)

    target.facing = 90
    expect(evaluateWarnings(document).some((warning) => warning.id === 'ice-facing-facing-q-red-water')).toBe(true)
    target.facing = 270
    expect(evaluateWarnings(document).some((warning) => warning.id === 'ice-facing-facing-q-red-water')).toBe(false)

    target.position = { x: 0, y: 7.3 }
    target.facing = 0
    q.path = [{ x: 3.5, y: 7.3 }, { x: 0.5, y: 7.3 }]
    expect(evaluateWarnings(document).some((warning) => warning.id === 'ice-facing-facing-q-red-water')).toBe(true)
  })

  it('explains a configurable water mirror yellow-charge risk without a reaction parameter', () => {
    const document = createDefaultDocument()
    const shooter = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const defender = document.initialScene.players.find((player) => player.id === 'red-water')!
    shooter.position = { x: 17, y: 7 }
    defender.position = { x: 18.5, y: 7 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 10, y: 0 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 10, y: 14 }
    const shot: ShootAction = { id: 'yellow', type: 'shoot', actorId: shooter.id, charge: 'yellow', startTime: 0, duration: 0.4, path: [{ ...shooter.position }, { x: 20, y: 7 }] }
    document.actions.push(shot)
    const warning = evaluateWarnings(document).find((candidate) => candidate.id === 'water-mirror-yellow-yellow')
    expect(warning?.detail).toContain('配置的进攻方对位等级')
    expect(warning?.detail).toContain('不使用反应时间参数')
    const pressure = evaluateWarnings(document).find((candidate) => candidate.id === 'shoot-pressure-yellow')
    expect(pressure?.title).toContain('最早受击')
    expect(pressure?.detail).toContain('Q逼近')
    expect(pressure?.detail).toContain('攻击环')
  })

  it('keeps the shared pressure warning when a legacy attack also interrupts the shot', () => {
    const document = createDefaultDocument()
    const shooter = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const defender = document.initialScene.players.find((player) => player.id === 'red-fire')!
    shooter.position = { x: 17, y: 5 }
    defender.position = { x: 17.8, y: 5 }
    document.actions.push(
      { id: 'interrupted', type: 'shoot', actorId: shooter.id, charge: 'red', startTime: 0, duration: 0.8, path: [{ ...shooter.position }, { x: 20, y: 5 }] },
      { id: 'legacy-hit', type: 'attack', actorId: defender.id, targetId: shooter.id, startTime: 0.4, duration: 0 },
    )
    const ids = evaluateWarnings(document).map((warning) => warning.id)
    expect(ids).toContain('shoot-interrupted-interrupted')
    expect(ids).toContain('shoot-pressure-interrupted')
  })
})
