import { describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { PlayerState, ProjectedFrame } from '../model/types'
import * as projection from '../timeline/projectFrame'
import { passTimeForDistance } from '../timeline/durations'
import { classifyPassThreat, highestPassThreat, PASS_THREAT_LABELS } from './passThreat'
import { createReachTimingEvaluator, evaluateReachTiming } from './reachTime'
import { evaluateShotPressure, shotPressureSummary } from './shotPressure'
import { evaluateWarnings } from './evaluateRules'
import { buildTacticNarrative } from '../narrative/buildTacticNarrative'

function setup() {
  const rules = createDefaultDocument().rulesSnapshot
  const attacker: PlayerState = {
    id: 'attacker', name: '持球者', role: 'fire', team: 'blue',
    position: { x: 0, y: 7 }, facing: 0, hasBall: true,
  }
  const electro: PlayerState = {
    id: 'electro', name: '雷后卫', role: 'electro', team: 'red',
    position: { x: 8, y: 10 }, facing: 180, hasBall: false,
  }
  const frame: ProjectedFrame = {
    players: [attacker, electro], statuses: [], time: 0, shots: [],
    ball: { carrierId: attacker.id, isFree: false, position: { ...attacker.position } },
    cooldowns: { [attacker.id]: { q: 0, e: 0 }, [electro.id]: { q: 10, e: 0 } },
    sprints: { [electro.id]: { energy: 1, cooldown: 0, active: false, maxDuration: 3.8, maxDistance: 8 } },
  }
  return { rules, attacker, electro, frame }
}

describe('Electro snapshot reach analysis', () => {
  it('covers eight grids in 3.8 seconds without applying ordinary boosts or slows', () => {
    const { rules, electro, frame } = setup()
    const result = evaluateReachTiming(frame, electro, 8, rules)
    expect(result).toMatchObject({ mode: 'e', eEnergy: 1, eCooldownAtStart: 0 })
    expect(result.earliestTime).toBeCloseTo(3.8, 10)
    frame.statuses.push(
      { id: 'slow', sourceActionId: 'ice', playerId: electro.id, kind: 'slowed', startsAt: 0, endsAt: 7, separationDelta: -99 },
      { id: 'boost', sourceActionId: 'water', playerId: electro.id, kind: 'boosted', startsAt: 0, endsAt: 7, separationDelta: 99 },
    )
    expect(evaluateReachTiming(frame, electro, 8, rules)).toEqual(result)
    rules.roles.electro.sprint!.maxDuration = 4
    expect(evaluateReachTiming(frame, electro, 8, rules).eTime).toBeCloseTo(4)
  })

  it('uses remaining active energy without regenerating during E', () => {
    const { rules, electro, frame } = setup()
    frame.sprints![electro.id] = { energy: 0.25, cooldown: 0, active: true, maxDuration: 0.95, maxDistance: 2 }
    const result = evaluateReachTiming(frame, electro, 4, rules)
    // Two grids in 0.95s, then two grids of ordinary running.
    expect(result.mode).toBe('e')
    expect(result.eTime).toBeCloseTo(2.95, 10)
    frame.sprints![electro.id]!.active = false
    // Running before starting a fresh E lets that idle energy regenerate.
    expect(evaluateReachTiming(frame, electro, 4, rules).eTime).toBeLessThan(2.95)
  })

  it('overlaps freeze and cooldown with recovery, and credits only post-thaw running', () => {
    const { rules, electro, frame } = setup()
    frame.time = 5
    frame.sprints![electro.id] = { energy: 0, cooldown: 4, active: false, maxDuration: 0, maxDistance: 0 }
    frame.statuses.push({ id: 'freeze', playerId: electro.id, kind: 'frozen', sourceActionId: 'ice', startsAt: 4, endsAt: 7 })
    const reach = evaluateReachTiming(frame, electro, 5, rules)
    expect(reach.frozenDelay).toBe(2)
    expect(reach.eTime).toBeGreaterThan(4)
    expect(reach.eTime).toBeLessThan(reach.directTime)
    expect(reach.eTime).toBeLessThan(6)
    // A not-yet-active status does not falsely make the current frame frozen.
    frame.statuses.push({ id: 'future', playerId: electro.id, kind: 'frozen', sourceActionId: 'future-q', startsAt: 20, endsAt: 40 })
    expect(evaluateReachTiming(frame, electro, 5, rules)).toEqual(reach)
  })

  it('never assumes E while holding the ball, including a stale hasBall mirror', () => {
    const { rules, electro, frame } = setup()
    frame.ball.carrierId = electro.id
    expect(electro.hasBall).toBe(false)
    const reach = evaluateReachTiming(frame, electro, 8, rules)
    expect(reach.eTime).toBe(Infinity)
    expect(reach.qETime).toBe(Infinity)
    expect(reach.mode).toBe('direct')
  })

  it('combines Q and E and does not shorten fixed Q to hit a point or annulus', () => {
    const { rules, electro, frame } = setup()
    frame.cooldowns[electro.id]!.q = 0
    const combined = evaluateReachTiming(frame, electro, 8, rules)
    expect(combined.mode).toBe('qE')
    expect(combined.qETime).toBeCloseTo((8 - 1.8) / (8 / 3.8), 10)
    const point = evaluateReachTiming(frame, electro, 1, rules)
    expect(point.qTime).toBeCloseTo(0.8)
    expect(point.earliestTime).toBeGreaterThan(0)
    const tooClose = evaluateReachTiming(frame, electro, 0.1, rules, { gap: 0.1, innerRadius: 0.2, outerRadius: 1 })
    expect(tooClose.qTime).toBeCloseTo(0.7)
    expect(tooClose.eTime).toBeCloseTo(0.1 / (8 / 3.8))
    expect(evaluateReachTiming(frame, electro, 0, rules, { gap: 0.2, innerRadius: 0.2, outerRadius: 1 }).earliestTime).toBe(0)
  })

  it('uses snapshot speed, permits running to regenerate before a single burst, and ignores another role E state', () => {
    const { rules, electro, frame } = setup()
    const state = frame.sprints![electro.id]!
    state.energy = 0.1
    state.cooldown = 0.6
    rules.field.baseMoveSpeed = 0.8
    const predicted = evaluateReachTiming(frame, electro, 5, rules).eTime
    // Independent discrete strategy enumeration validates the closed form.
    let reference = Infinity
    const sprint = rules.roles.electro.sprint!
    const eSpeed = sprint.maxDistance / sprint.maxDuration
    for (let start = state.cooldown; start <= 7; start += 0.0005) {
      const runDistance = start * rules.field.baseMoveSpeed
      const eBudget = Math.min(1, state.energy + start / sprint.recoveryDuration) * sprint.maxDuration
      const eTime = Math.min(eBudget, Math.max(0, 5 - runDistance) / eSpeed)
      const remainder = Math.max(0, 5 - runDistance - eTime * eSpeed)
      reference = Math.min(reference, start + eTime + remainder / rules.field.baseMoveSpeed)
    }
    expect(predicted).toBeCloseTo(reference, 3)
    electro.role = 'fire'
    expect(evaluateReachTiming(frame, electro, 5, rules).eTime).toBe(Infinity)
    expect(evaluateReachTiming(frame, electro, 5, rules).directTime).toBe(6.25)
  })

  it('adds E pressure using the same attack annulus and shared summary', () => {
    const { rules, attacker, electro, frame } = setup()
    attacker.position = { x: 10, y: 7 }
    electro.position = { x: 13, y: 7 }
    const pressure = evaluateShotPressure(frame, attacker.id, rules, 1)!
    expect(pressure.earliest?.mode).toBe('e')
    expect(pressure.earliest?.earliestTime).toBeCloseTo(0.95)
    expect(pressure.isRisk).toBe(true)
    expect(shotPressureSummary(pressure)).toContain('雷 E 逼近')
    frame.sprints![electro.id]!.cooldown = 4
    expect(evaluateShotPressure(frame, attacker.id, rules, 1)?.isRisk).toBe(false)
  })

  it('credits an actual wall-clipped Q to a ball, but not an interior shortened Q', () => {
    const { rules, electro, frame } = setup()
    electro.position = { x: 19, y: 7 }
    frame.cooldowns[electro.id]!.q = 0
    const wall = evaluateReachTiming(frame, electro, 1, rules, { gap: 1, innerRadius: 0, outerRadius: 0, center: { x: 20, y: 7 } })
    expect(wall.qTime).toBe(0)
    const interior = evaluateReachTiming(frame, electro, 1, rules, { gap: 1, innerRadius: 0, outerRadius: 0, center: { x: 18, y: 7 } })
    expect(interior.qTime).toBeCloseTo(0.8)
  })

  it('consumes actual projected E energy and its stop cooldown', () => {
    const document = createDefaultDocument()
    const defender = document.initialScene.players.find((player) => player.id === 'red-fire')!
    defender.role = 'electro'
    defender.position = { x: 8, y: 10 }
    document.actions.push({ id: 'e', type: 'move', sprint: true, actorId: defender.id,
      startTime: 0, duration: 0.95, path: [{ x: 8, y: 10 }, { x: 10, y: 10 }] })
    const during = projection.projectFrame(document, 0.475)
    const after = projection.projectFrame(document, 0.95)
    expect(during.sprints?.[defender.id]?.energy).toBeCloseTo(0.875)
    expect(after.sprints?.[defender.id]?.energy).toBeCloseTo(0.75)
    expect(after.sprints?.[defender.id]?.cooldown).toBeCloseTo(4)
    during.cooldowns[defender.id]!.q = after.cooldowns[defender.id]!.q = 10
    expect(evaluateReachTiming(during, during.players.find((player) => player.id === defender.id)!, 3, document.rulesSnapshot).mode).toBe('e')
    expect(evaluateReachTiming(after, after.players.find((player) => player.id === defender.id)!, 3, document.rulesSnapshot).mode).toBe('direct')
  })
})

describe('Electro pass interception', () => {
  const path = [{ x: 0, y: 7 }, { x: 10, y: 7 }]

  it('marks E reach distinctly, preserving ordinary short-pass protection', () => {
    const { rules, electro, frame } = setup()
    const segments = classifyPassThreat(path, 'blue', frame, rules)
    expect(segments[0]).toMatchObject({ level: 'safe', startDistance: 0, endDistance: 4 })
    expect(segments.some((segment) => segment.level === 'eSingle' && segment.opponentIds.includes(electro.id))).toBe(true)
    expect(PASS_THREAT_LABELS.eSingle).toContain('雷 E')
    expect(highestPassThreat(classifyPassThreat(path.slice(0, 1).concat({ x: 4, y: 7 }), 'blue', frame, rules))).toBe('safe')
  })

  it('uses the 10-grid / 3-second decelerating ball curve, not a flat speed or stale 2 seconds', () => {
    const { rules, electro, frame } = setup()
    expect(passTimeForDistance(10, rules)).toBeCloseTo(3)
    expect(passTimeForDistance(5, rules)).toBeCloseTo(3 * (1 - Math.sqrt(0.5)))
    electro.position = { x: 10, y: 12.5 }
    rules.passing.interceptStartWidth = rules.passing.interceptEndWidth = 0.1
    expect(classifyPassThreat(path, 'blue', frame, rules).some((segment) => segment.level === 'eSingle')).toBe(true)
    rules.passing.ballSpeed = 5 // Existing saved 10 grids / 2 seconds remains authoritative.
    expect(classifyPassThreat(path, 'blue', frame, rules).some((segment) => segment.level === 'eSingle')).toBe(false)
  })

  it('excludes cooling/frozen/holding E, retaining frozen in-place interception', () => {
    const { rules, electro, frame } = setup()
    frame.sprints![electro.id]!.cooldown = 4
    expect(classifyPassThreat(path, 'blue', frame, rules).some((segment) => segment.level === 'eSingle')).toBe(false)
    frame.sprints![electro.id]!.cooldown = 0
    frame.statuses.push({ id: 'freeze', sourceActionId: 'ice', playerId: electro.id, kind: 'frozen', startsAt: 0, endsAt: 4 })
    expect(classifyPassThreat(path, 'blue', frame, rules).some((segment) => segment.level === 'eSingle')).toBe(false)
    electro.position = { x: 8, y: 7 }
    expect(classifyPassThreat(path, 'blue', frame, rules).some((segment) => segment.level === 'direct')).toBe(true)
    frame.statuses = []
    electro.position = { x: 8, y: 10 }
    frame.ball.carrierId = electro.id
    expect(classifyPassThreat(path, 'blue', frame, rules).some((segment) => segment.level === 'eSingle')).toBe(false)
  })

  it('combines Q and E defenders without falsely labeling all as Q', () => {
    const { rules, frame } = setup()
    frame.players.push({ id: 'water', name: '水', team: 'red', role: 'water', facing: 0, hasBall: false, position: { x: 8, y: 8.5 } })
    frame.cooldowns.water = { q: 0, e: 0 }
    const segments = classifyPassThreat(path, 'blue', frame, rules)
    expect(segments.some((segment) => segment.level === 'eMultiple' && segment.opponentIds.includes('water') && segment.opponentIds.includes('electro'))).toBe(true)
  })

  it('compiles current resources once and never projects the document inside path sampling', () => {
    const { rules, electro, frame } = setup()
    const readStatuses = vi.fn(() => [])
    Object.defineProperty(frame, 'statuses', { configurable: true, get: readStatuses })
    const read = createReachTimingEvaluator(frame, electro, rules)
    for (let i = 0; i < 1000; i += 1) read(i / 100)
    expect(readStatuses).toHaveBeenCalledTimes(1)
    const projectSpy = vi.spyOn(projection, 'projectFrame')
    const dense = Array.from({ length: 1024 }, (_, index) => ({ x: index / 1023 * 10, y: 7 + (index % 2) * 0.001 }))
    const segments = classifyPassThreat(dense, 'blue', frame, rules)
    expect(segments.flatMap((segment) => segment.path).length).toBeLessThan(2100)
    expect(projectSpy).not.toHaveBeenCalled()
    projectSpy.mockRestore()
  })

  it('shares E pass warnings and authored-E narrative labels with the analysis', () => {
    const document = createDefaultDocument()
    const passer = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    const defender = document.initialScene.players.find((player) => player.id === 'red-fire')!
    passer.position = { x: 0, y: 7 }
    defender.role = 'electro'
    defender.position = { x: 8, y: 8.2 }
    document.initialScene.ball = { carrierId: passer.id, isFree: false, position: { ...passer.position } }
    document.initialScene.players.forEach((player) => { player.hasBall = player.id === passer.id })
    document.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 20, y: 0 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 20, y: 14 }
    document.actions.push(
      { id: 'used-q', type: 'qMove', actorId: defender.id, startTime: 0, duration: 0, path: [{ ...defender.position }, { x: 8, y: 10 }] },
      { id: 'pass', type: 'pass', actorId: passer.id, startTime: 0, duration: 3, path },
      { id: 'e', type: 'move', actorId: defender.id, sprint: true, startTime: 0, duration: 0.95, path: [{ x: 8, y: 10 }, { x: 10, y: 10 }] },
    )
    expect(evaluateWarnings(document).find((warning) => warning.id === 'pass-risk-pass')?.detail).toContain('雷 E')
    const narrative = buildTacticNarrative(document)
    expect(narrative.entries.find((entry) => entry.id === 'action-pass')?.detail).toContain('雷 E')
    expect(narrative.entries.find((entry) => entry.id === 'action-e')).toMatchObject({ title: '雷 E · 红方 2' })
    expect(narrative.entries.find((entry) => entry.id === 'action-e')?.detail).toContain('期间不回能')
  })
})
