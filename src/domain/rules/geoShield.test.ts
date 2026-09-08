import { afterEach, describe, expect, it, vi } from 'vitest'
import * as compiledPaths from '../geometry/compiledPath'
import { distance, pathLength } from '../geometry/geometry'
import { createDefaultDocument } from '../model/createDocument'
import type { LoosePassAction, PassAction, ProjectedFrame, ShootAction, Vec2 } from '../model/types'
import { deceleratingTime, passDuration, passPathProgress, passTimeForDistance } from '../timeline/durations'
import * as projection from '../timeline/projectFrame'
import * as passReception from '../timeline/passReception'
import { createFollowPerformanceFixture } from '../../test/followPerformanceFixture'
import { analyzeActionGeoShield, evaluateGeoShieldReach, geoShieldPassSummary, geoShieldShotSummary } from './geoShield'
import { classifyPassThreat } from './passThreat'
import { evaluateShotActionPressure } from './shotPressure'

function fixture(position: Vec2 = { x: 6, y: 5 }) {
  const document = createDefaultDocument()
  const actor = document.initialScene.players[0]!
  const defender = document.initialScene.players[4]!
  actor.position = { x: 5, y: 5 }
  defender.role = 'geo'
  defender.position = { ...position }
  document.initialScene.ball.position = { ...actor.position }
  const pass: PassAction = {
    id: 'shield-pass', type: 'pass', actorId: actor.id, startTime: 0,
    path: [{ x: 5, y: 5 }, { x: 7, y: 5 }], duration: 0,
  }
  pass.duration = passDuration(pass.path, document.rulesSnapshot)
  document.actions.push(pass)
  const frame: ProjectedFrame = {
    ...structuredClone(document.initialScene), time: 0, shots: [],
    cooldowns: Object.fromEntries(document.initialScene.players.map((player) => [player.id, { q: 0, e: 0 }])),
  }
  const shot: ShootAction = {
    id: 'shield-shot', type: 'shoot', actorId: actor.id, startTime: 0, duration: 0.8,
    charge: 'yellow', path: [{ x: 10, y: 7 }, { x: 20, y: 7 }],
  }
  return { document, actor, defender, pass, shot, frame, rules: document.rulesSnapshot }
}

afterEach(() => vi.restoreAllMocks())

describe('Geo shield reach', () => {
  it('includes the exact shield boundary before freeze and Q cooldown', () => {
    const { defender, frame, rules } = fixture({ x: 5, y: 5 })
    frame.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 20 })
    frame.cooldowns[defender.id]!.q = 30
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 6, y: 5 }], rules)).toMatchObject({ earliestTime: 0, mode: 'inPlace' })
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 6.00001, y: 5 }], rules)!.earliestTime).toBeGreaterThan(20)
  })

  it('does not invent a shortened fixed Q when its landing overshoots the shield', () => {
    const { defender, frame, rules } = fixture({ x: 5, y: 5 })
    const result = evaluateGeoShieldReach(frame, defender, [{ x: 6.1, y: 5 }], rules)!
    expect(result.mode).toBe('direct')
    expect(result.directTime).toBeCloseTo(0.1)
    expect(result.qTime).toBeCloseTo(0.3)
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 6.4, y: 5 }], rules)).toMatchObject({ mode: 'q', earliestTime: 0 })
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 8.4, y: 5 }], rules)!.qTime).toBeCloseTo(0)
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 8.40001, y: 5 }], rules)!.qTime).toBeGreaterThan(0)
  })

  it('allows a field-clipped Q and checks the actual landing at a corner', () => {
    const { defender, frame, rules } = fixture({ x: 0.4, y: 4 })
    const target = { x: 0.4, y: 5.1 }
    const result = evaluateGeoShieldReach(frame, defender, [target], rules)!
    expect(result).toMatchObject({ mode: 'q', earliestTime: 0 })
    defender.position = { x: 0.1, y: 0.1 }
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 1.2, y: 0.1 }], rules)).toMatchObject({ mode: 'q', earliestTime: 0 })
  })

  it.each([0, 20])('requires a legal launch position instead of walking back after an overshooting Q at x=%s', (x) => {
    const { defender, frame, rules } = fixture({ x, y: 5 })
    const target = { x: x === 0 ? 1.3 : 18.7, y: 5 }
    const result = evaluateGeoShieldReach(frame, defender, [target], rules)!
    // A 2.4-grid Q straight inward lands 1.1 grids beyond the target.
    // With the wall behind us, the nearest legal launch is sideways, where
    // the full landing is exactly one shield radius beyond the target.
    const preRun = Math.sqrt((2.4 - 1) ** 2 - 1.3 ** 2)
    expect(result.qTime).toBeCloseTo(preRun)
    expect(result).toMatchObject({ mode: 'direct' })
    expect(result.earliestTime).toBeCloseTo(0.3)
    frame.cooldowns[defender.id]!.q = 0.2
    expect(evaluateGeoShieldReach(frame, defender, [target], rules)!.qTime).toBeCloseTo(preRun)
    frame.cooldowns[defender.id]!.q = 0.8
    expect(evaluateGeoShieldReach(frame, defender, [target], rules)!.qTime).toBeCloseTo(0.8)
  })

  it('lets cooldown elapse during freeze and runs only after thaw while waiting', () => {
    const { defender, frame, rules } = fixture({ x: 5, y: 5 })
    frame.time = 2
    frame.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 1, endsAt: 3.5 })
    frame.cooldowns[defender.id]!.q = 3
    const result = evaluateGeoShieldReach(frame, defender, [{ x: 11, y: 5 }], rules)!
    expect(result.directTime).toBe(6.5)
    expect(result.qTime).toBeCloseTo(4.1)
    expect(result.mode).toBe('q')
    frame.cooldowns[defender.id]!.q = 0.5
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 8, y: 5 }], rules)!.qTime).toBe(1.5)
  })

  it('waits for thaw for direct running, ignores inactive control and uses saved base speed', () => {
    const { defender, frame, rules } = fixture({ x: 5, y: 5 })
    rules.field.baseMoveSpeed = 2
    frame.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 0.4 })
    frame.statuses.push({ id: 'later', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 10, endsAt: 40 })
    frame.cooldowns[defender.id]!.q = 9
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 6.1, y: 5 }], rules)!.directTime).toBeCloseTo(0.45)
  })

  it('can move away or sideways during Q cooldown to avoid fixed-distance overshoot', () => {
    const { defender, frame, rules } = fixture({ x: 5, y: 5 })
    rules.roles.geo.shield!.radius = 0.01
    frame.cooldowns[defender.id]!.q = 0.8
    const result = evaluateGeoShieldReach(frame, defender, [{ x: 7, y: 5 }], rules)!
    expect(result.qTime).toBe(0.8)
    defender.position = { x: 0, y: 5 }
    frame.cooldowns[defender.id]!.q = 0.5
    const sideways = evaluateGeoShieldReach(frame, defender, [{ x: 2, y: 5 }], rules)!
    expect(sideways.qTime).toBeCloseTo(Math.sqrt((2.4 - 0.01) ** 2 - 2 ** 2))
  })

  it('uses finite segment capsules and their radial interval, including both endpoints', () => {
    const { defender, frame, rules } = fixture({ x: 5, y: 5 })
    frame.cooldowns[defender.id]!.q = 9
    expect(evaluateGeoShieldReach(frame, defender, [{ x: 8, y: 5 }, { x: 10, y: 5 }], rules)!.earliestTime).toBe(2)
    frame.cooldowns[defender.id]!.q = 0
    const path = [{ x: 5, y: 6.1 }, { x: 9, y: 6.1 }]
    expect(evaluateGeoShieldReach(frame, defender, path, rules)).toMatchObject({ mode: 'q', earliestTime: 0 })
    expect(evaluateGeoShieldReach(frame, defender, [...path].reverse(), rules)).toEqual(evaluateGeoShieldReach(frame, defender, path, rules))
  })
})

describe('Geo pass route analysis', () => {
  it.each(['pass', 'loosePass'] as const)('does not flag a fast %s just because Q crosses the ball before overshooting', (type) => {
    const { document, pass } = fixture({ x: 0, y: 5 })
    pass.path = [{ x: 1.28, y: 5 }, { x: 1.32, y: 5 }]
    pass.duration = 0.15
    // Calibrate a short loose flight to the same arrival; no freeze/CD excuse.
    document.rulesSnapshot.loosePassing = { maxDistance: 0.04, maxDuration: 0.15 }
    const action = type === 'pass' ? pass : {
      ...pass, type, aimDirection: { x: 1, y: 0 }, flightOutcome: 'grounded' as const,
    }
    expect(analyzeActionGeoShield(document, action).passSegments).toEqual([])
  })

  it('allows shield obstruction within a two-grid otherwise safe pass, including frozen Geo', () => {
    const { document, defender, pass } = fixture()
    document.initialScene.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 20 })
    const result = analyzeActionGeoShield(document, pass)
    expect(result.passSegments).toHaveLength(1)
    expect(result.passSegments[0]).toMatchObject({ kind: 'inPlace', startDistance: 0, endDistance: 2, opponentIds: [defender.id] })
    expect(geoShieldPassSummary(result.passSegments, document.initialScene.players)).toBe(`岩原地护罩 · ${defender.name}`)
    expect(classifyPassThreat(pass.path, 'blue', projection.projectFrame(document, 0), document.rulesSnapshot).every((segment) => segment.level === 'safe')).toBe(true)
    defender.role = 'fire'
    expect(analyzeActionGeoShield(document, pass).passSegments).toEqual([])
  })

  it('filters friendly Geo and absent shield capability before projecting', () => {
    const { document, defender, actor, pass } = fixture()
    defender.role = 'fire'
    actor.role = 'geo'
    const read = vi.spyOn(projection, 'projectFrameAtKeyframe')
    expect(analyzeActionGeoShield(document, pass).passSegments).toEqual([])
    defender.role = 'geo'
    delete document.rulesSnapshot.roles.geo.shield
    expect(analyzeActionGeoShield(document, pass).passSegments).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps overlapping defender IDs and gives the in-place category precedence', () => {
    const { document, defender, pass } = fixture()
    const other = document.initialScene.players[3]!
    other.role = 'geo'
    other.position = { x: 6, y: 7 }
    const result = analyzeActionGeoShield(document, pass)
    expect(result.passSegments.every((segment) => segment.kind === 'inPlace')).toBe(true)
    expect(result.passSegments[0]!.opponentIds).toEqual([defender.id, other.id].sort())
  })

  it('uses exact circle intersections and retains a single tangent contact', () => {
    const { document, defender, pass } = fixture({ x: 6.03, y: 5 })
    document.rulesSnapshot.roles.geo.shield!.radius = 0.003
    document.initialScene.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 10 })
    const result = analyzeActionGeoShield(document, pass).passSegments
    expect(result).toHaveLength(1)
    expect(result[0]!.startDistance).toBeCloseTo(1.027)
    expect(result[0]!.endDistance).toBeCloseTo(1.033)
    defender.position.y = 5.003
    const tangent = analyzeActionGeoShield(document, pass).passSegments
    expect(tangent).toHaveLength(1)
    expect(tangent[0]!.endDistance - tangent[0]!.startDistance).toBeLessThan(1e-6)
  })

  it('includes exact ball-arrival equality and refreshes after a later thaw edit', () => {
    const { document, defender, pass } = fixture({ x: 7, y: 8 })
    const frozen = { id: 'freeze', playerId: defender.id, kind: 'frozen' as const, sourceActionId: 'setup', startsAt: 0, endsAt: pass.duration }
    document.initialScene.statuses.push(frozen)
    const result = analyzeActionGeoShield(document, pass).passSegments
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: 'reachable', startDistance: 2, endDistance: 2 })
    frozen.endsAt += 0.00001
    expect(analyzeActionGeoShield(document, pass).passSegments).toEqual([])
  })

  it('uses nonlinear arc timing on curved routes and preserves all covered vertices', () => {
    const { document, defender, pass } = fixture({ x: 7, y: 8.3 })
    pass.path = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 7, y: 6 }]
    pass.duration = passDuration(pass.path, document.rulesSnapshot)
    document.initialScene.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 0.3 })
    const result = analyzeActionGeoShield(document, pass).passSegments
    expect(result.some((segment) => segment.endDistance === 3)).toBe(true)
    expect(result.every((segment) => segment.startDistance >= 2.1)).toBe(true)
    document.initialScene.statuses = []
    document.rulesSnapshot.roles.geo.shield!.radius = 20
    const covered = analyzeActionGeoShield(document, pass).passSegments
    for (const vertex of pass.path) expect(covered.flatMap((segment) => segment.path)).toContainEqual(vertex)
    expect(covered.at(-1)!.path.at(-1)).toEqual(pass.path.at(-1))
  })

  it('matches authoritative stored ordinary duration as well as old ball-speed calibration', () => {
    const { document, defender, pass } = fixture({ x: 7, y: 8 })
    document.rulesSnapshot.passing.ballSpeed = 8
    pass.duration = passDuration(pass.path, document.rulesSnapshot)
    document.initialScene.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 0.2 })
    expect(analyzeActionGeoShield(document, pass).passSegments).toEqual([])
    pass.duration = 1
    const result = analyzeActionGeoShield(document, pass).passSegments
    expect(result.length).toBeGreaterThan(0)
    const end = result.at(-1)!
    expect(end.endDistance).toBe(2)
    const time = passTimeForDistance(end.endDistance, document.rulesSnapshot)
      / passTimeForDistance(2, document.rulesSnapshot) * pass.duration
    expect(passPathProgress(pass.path, time, pass.duration, document.rulesSnapshot)).toBe(1)
  })

  it('scans loose bounces with loose calibration and clips at pickup duration', () => {
    const { document, defender, pass, rules } = fixture({ x: 0, y: 5 })
    rules.roles.geo.shield!.radius = 0.1
    document.initialScene.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 20 })
    const loose: LoosePassAction = {
      ...pass, type: 'loosePass', aimDirection: { x: -1, y: 0 }, flightOutcome: 'grounded',
      path: [{ x: 2, y: 5 }, { x: 0, y: 5 }, { x: 4, y: 5 }], duration: 3,
    }
    document.actions = [loose]
    const bounce = analyzeActionGeoShield(document, loose).passSegments
    expect(bounce).toHaveLength(1)
    expect(bounce[0]!.path).toContainEqual({ x: 0, y: 5 })
    expect(bounce[0]!.startDistance).toBeCloseTo(1.9)
    expect(bounce[0]!.endDistance).toBeCloseTo(2.1)
    loose.flightOutcome = 'pickedUp'
    loose.duration = deceleratingTime(1, 6, 3)
    expect(analyzeActionGeoShield(document, loose).passSegments).toEqual([])
    // A loose flight's maximum is independent of the ordinary eight-grid rule.
    loose.duration = 3
    rules.passing.maxDistance = 1
    expect(analyzeActionGeoShield(document, loose).passSegments).toEqual(bounce)
  })

  it('uses a custom loose curve rather than ordinary timing and does not extend drop routes', () => {
    const { document, defender, pass, rules } = fixture({ x: 7, y: 8 })
    rules.loosePassing = { maxDistance: 6, maxDuration: 6 }
    document.initialScene.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 0.8 })
    const loose: LoosePassAction = { ...pass, type: 'loosePass', aimDirection: { x: 1, y: 0 }, flightOutcome: 'pickedUp', duration: deceleratingTime(2, 6, 6) }
    expect(analyzeActionGeoShield(document, loose).passSegments.length).toBeGreaterThan(0)
    expect(analyzeActionGeoShield(document, pass).passSegments).toEqual([])
    defender.position = { x: 14, y: 5 }
    document.initialScene.statuses[0]!.endsAt = 20
    pass.path = [{ x: 5, y: 5 }, { x: 17, y: 5 }]
    pass.duration = 2
    expect(analyzeActionGeoShield(document, pass).passSegments.every((segment) => segment.endDistance <= 8)).toBe(true)
  })

  it('projects the action launch time and preserves an instant-Q semantic origin edge', () => {
    const { document, defender, pass } = fixture({ x: 15, y: 8 })
    document.actions.unshift({ id: 'enemy-run', type: 'move', actorId: defender.id, startTime: 0, duration: 1, path: [{ x: 15, y: 8 }, { x: 6, y: 5 }] })
    expect(analyzeActionGeoShield(document, pass).passSegments).toEqual([])
    pass.startTime = 1
    expect(analyzeActionGeoShield(document, pass).passSegments.some((segment) => segment.kind === 'inPlace')).toBe(true)
    const reference = { playerId: pass.actorId, actionId: 'origin-q', edge: 'start' as const }
    pass.originKeyframe = reference
    document.actions.push({ id: reference.actionId, type: 'qMove', actorId: pass.actorId, startTime: 1, duration: 0, path: [{ x: 5, y: 5 }, { x: 8, y: 5 }] })
    const reader = vi.spyOn(projection, 'projectFrameAtKeyframe')
    analyzeActionGeoShield(document, pass)
    expect(reader).toHaveBeenCalledWith(document, 1, reference)
  })
})

describe('independent Geo shot hints', () => {
  it('uses defenders nearest the finite ball route and gives frozen in-place zero', () => {
    const { document, defender, shot } = fixture({ x: 18, y: 8 })
    document.initialScene.statuses.push({ id: 'freeze', playerId: defender.id, kind: 'frozen', sourceActionId: 'setup', startsAt: 0, endsAt: 20 })
    const result = analyzeActionGeoShield(document, shot).shot!
    expect(result).toMatchObject({ defenderId: defender.id, earliestTime: 0, mode: 'inPlace' })
    expect(geoShieldShotSummary(result)).toBe(`岩最早挡球 0s · ${defender.name} 原地护罩`)
    shot.path.reverse()
    expect(analyzeActionGeoShield(document, shot).shot).toEqual(result)
  })

  it('chooses run versus Q separately from the ordinary attack-pressure result', () => {
    const { document, defender, shot, rules } = fixture({ x: 15, y: 9.2 })
    const original = evaluateShotActionPressure(document, shot)
    expect(analyzeActionGeoShield(document, shot).shot).toMatchObject({ defenderId: defender.id, mode: 'q', earliestTime: 0 })
    expect(evaluateShotActionPressure(document, shot)).toEqual(original)
    rules.roles.geo.q.duration = 5
    expect(analyzeActionGeoShield(document, shot).shot!.earliestTime).toBeCloseTo(1.2)
    expect(analyzeActionGeoShield(document, shot).shot!.mode).toBe('direct')
  })

  it('uses full-Q landing rather than crossing an entire short shot route', () => {
    const { document, shot, defender } = fixture({ x: 0, y: 5 })
    shot.path = [{ x: 1.3, y: 4.99 }, { x: 1.3, y: 5.01 }]
    const pressure = evaluateShotActionPressure(document, shot)
    const result = analyzeActionGeoShield(document, shot).shot!
    expect(result).toMatchObject({ defenderId: defender.id, mode: 'direct' })
    expect(result.earliestTime).toBeCloseTo(0.3)
    expect(evaluateShotActionPressure(document, shot)).toEqual(pressure)
    // A longer finite route really does intersect the full-Q landing ring.
    shot.path[1] = { x: 1.3, y: 7 }
    expect(analyzeActionGeoShield(document, shot).shot).toMatchObject({ mode: 'q', earliestTime: 0 })
  })

  it('hides exactly two seconds, shows unrounded just-below-two, and skips red before projection', () => {
    const { document, defender, shot, rules } = fixture({ x: 15, y: 10 })
    rules.roles.geo.q.duration = 9
    expect(analyzeActionGeoShield(document, shot).shot).toBeNull()
    defender.position.y -= 0.00001
    expect(analyzeActionGeoShield(document, shot).shot!.earliestTime).toBeLessThan(2)
    const read = vi.spyOn(projection, 'projectFrameAtKeyframe')
    shot.charge = 'red'
    expect(analyzeActionGeoShield(document, shot).shot).toBeNull()
    expect(read).not.toHaveBeenCalled()
    shot.charge = 'yellow'
    defender.role = 'fire'
    expect(analyzeActionGeoShield(document, shot).shot).toBeNull()
  })

  it('does not extend a shot behind its shooter and uses raw ID ordering for ties', () => {
    const { document, defender, shot, rules } = fixture({ x: 7, y: 7 })
    rules.roles.geo.q.duration = 9
    expect(analyzeActionGeoShield(document, shot).shot).toBeNull()
    defender.position = { x: 15, y: 7 }
    const other = document.initialScene.players[3]!
    other.role = 'geo'
    other.position = { x: 18, y: 7 }
    other.id = 'A-geo'
    expect(analyzeActionGeoShield(document, shot).shot!.defenderId).toBe(other.id)
  })

  it('refreshes from actual prior Q cooldown, control, time and rule changes', () => {
    const { document, defender, shot, rules } = fixture({ x: 12.6, y: 9.2 })
    document.actions.push({ id: 'earlier-geo-q', type: 'qMove', actorId: defender.id, startTime: 0, duration: 0, path: [{ x: 12.6, y: 9.2 }, { x: 15, y: 9.2 }] })
    shot.startTime = 1
    expect(analyzeActionGeoShield(document, shot).shot!.mode).toBe('direct')
    rules.roles.geo.q.cooldown = 0.5
    expect(analyzeActionGeoShield(document, shot).shot).toMatchObject({ mode: 'q', earliestTime: 0 })
    document.actions.push({ id: 'control', type: 'status', targetId: defender.id, status: 'frozen', startTime: 0.5, duration: 2.5 })
    expect(analyzeActionGeoShield(document, shot).shot).toBeNull()
    shot.startTime = 3
    expect(analyzeActionGeoShield(document, shot).shot).toMatchObject({ mode: 'q', earliestTime: 0 })
    const restored = structuredClone(document)
    expect(analyzeActionGeoShield(restored, structuredClone(shot))).toEqual(analyzeActionGeoShield(document, shot))
  })
})

describe('Geo analysis cache and work bounds', () => {
  it('returns owned data, reuses static work and invalidates in-place semantic edits and previews', () => {
    const { document, defender, pass, rules } = fixture()
    const read = vi.spyOn(projection, 'projectFrameAtKeyframe')
    const result = analyzeActionGeoShield(document, pass)
    const expected = structuredClone(result)
    result.passSegments[0]!.path[0]!.x = -100
    result.passSegments[0]!.opponentIds.push('poison')
    expect(analyzeActionGeoShield(document, pass)).toEqual(expected)
    expect(read).toHaveBeenCalledTimes(1)
    document.meta.notes = 'unrelated metadata'
    expect(analyzeActionGeoShield(document, pass)).toEqual(expected)
    expect(read).toHaveBeenCalledTimes(1)
    defender.position.y += 5
    expect(analyzeActionGeoShield(document, pass)).not.toEqual(expected)
    rules.roles.geo.shield!.radius = 20
    const edited = analyzeActionGeoShield(document, pass)
    expect(edited.passSegments.length).toBeGreaterThan(0)
    const fresh = structuredClone(document)
    expect(analyzeActionGeoShield(fresh, fresh.actions[0] as PassAction)).toEqual(edited)
    const preview = [{ x: 5, y: 5 }, { x: 6, y: 5 }]
    expect(analyzeActionGeoShield(document, pass, preview).passSegments.at(-1)!.path.at(-1)).toEqual(preview.at(-1))
    expect(analyzeActionGeoShield(document, pass).passSegments.at(-1)!.path.at(-1)).toEqual(pass.path.at(-1))
  })

  it('keeps at most 128 action entries and expires old preview paths', () => {
    const { document, pass, rules } = fixture()
    rules.roles.geo.shield!.radius = 20
    const read = vi.spyOn(projection, 'projectFrameAtKeyframe')
    analyzeActionGeoShield(document, pass)
    for (let index = 1; index <= 128; index += 1) analyzeActionGeoShield(document, { ...pass, id: `preview-${index}` })
    expect(read).toHaveBeenCalledTimes(129)
    analyzeActionGeoShield(document, pass)
    expect(read).toHaveBeenCalledTimes(130)
  })

  it('bounds subdivisions, compiles once and retains a long route with several Geo defenders', () => {
    const { document, pass, rules } = fixture()
    rules.passing.maxDistance = 10000
    rules.roles.geo.shield!.radius = 30
    for (const player of document.initialScene.players) if (player.team === 'red') player.role = 'geo'
    pass.path = Array.from({ length: 1024 }, (_, index) => ({ x: index % 2 ? 20 : 0, y: index / 1024 * 14 }))
    pass.duration = passDuration(pass.path, rules)
    // Projection owns its own ball geometry; isolate the scanner's compile.
    projection.projectFrame(document, pass.startTime)
    const compile = vi.spyOn(compiledPaths, 'compilePath')
    const result = analyzeActionGeoShield(document, pass)
    expect(compile.mock.calls.filter(([path]) => path === pass.path)).toHaveLength(1)
    const points = result.passSegments.flatMap((segment) => segment.path)
    expect(points.length).toBeLessThan(2 * (1024 + 512 + 2))
    expect(result.passSegments.at(-1)!.endDistance).toBe(10000)
    expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
  })

  it('keeps the real chase/zone fixture finite and does no repeated solving or scanning over 90 scrubs', () => {
    const document = createFollowPerformanceFixture()
    document.initialScene.players.find((player) => player.id === 'red-fire')!.role = 'geo'
    const pass: PassAction = {
      id: 'stress-shield-pass', type: 'pass', actorId: 'blue-fire', startTime: 8, duration: 1,
      path: [{ x: 8, y: 6 }, { x: 9, y: 7 }, { x: 11, y: 7 }],
    }
    document.actions.push(pass)
    const coldStart = performance.now()
    const result = analyzeActionGeoShield(document, pass)
    expect(performance.now() - coldStart).toBeLessThan(5000)
    expect(result.passSegments.every((segment) => Number.isFinite(pathLength(segment.path)))).toBe(true)
    const read = vi.spyOn(projection, 'projectFrameAtKeyframe')
    const compile = vi.spyOn(compiledPaths, 'compilePath')
    const solver = vi.spyOn(passReception, 'solvePassReception')
    for (let index = 0; index < 90; index += 1) {
      // Distinct bidirectional playhead times must not enter action analysis.
      projection.projectFrame(document, (index < 45 ? index : 90 - index) * 0.13)
      expect(analyzeActionGeoShield(document, pass)).toEqual(result)
    }
    expect(read).not.toHaveBeenCalled()
    expect(solver).not.toHaveBeenCalled()
    expect(compile.mock.calls.filter(([path]) => path === pass.path)).toHaveLength(0)
    expect(distance(pass.path[0]!, pass.path.at(-1)!)).toBeGreaterThan(0)
  })
})
