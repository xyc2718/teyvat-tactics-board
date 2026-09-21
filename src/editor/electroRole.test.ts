import { beforeEach, describe, expect, it } from 'vitest'
import { pathLength } from '../domain/geometry/geometry'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { RoleId } from '../domain/model/types'
import { evaluateMatchup } from '../domain/rules/evaluateRules'
import { loosePassingRule } from '../domain/rules/loosePassing'
import { validateQStart } from '../domain/rules/qCooldown'
import { passMaxDuration, passTimeForDistance, passTravelDistance } from '../domain/timeline/durations'
import { projectFrameAtKeyframe } from '../domain/timeline/projectFrame'
import { useTacticStore } from './useTacticStore'

function setup(actorId = 'blue-fire') {
  const document = createDefaultDocument()
  document.initialScene.players.find((player) => player.id === actorId)!.role = 'electro'
  document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
  useTacticStore.setState({ document, selection: { kind: 'player', id: actorId },
    tool: 'select', boardMode: 'simulation', activeStepId: document.stepMarkers[0]!.id,
    currentTime: 0, currentKeyframe: null, isPlaying: false, showAdvancedTimeline: false,
    notice: null, past: [], future: [] })
  return document
}

describe('Electro role and new pass calibration', () => {
  beforeEach(() => { setup() })

  it('uses ten grids in three seconds on the same linear-deceleration curve, leaving loose passes unchanged', () => {
    const rules = createDefaultDocument().rulesSnapshot
    expect(rules.passing).toMatchObject({ maxDistance: 10, ballSpeed: 10 / 3, safeDistance: 4 })
    expect(passMaxDuration(rules)).toBe(3)
    expect(passTimeForDistance(10, rules)).toBe(3)
    expect(passTimeForDistance(20, rules)).toBe(3)
    expect(passTimeForDistance(5, rules)).toBeCloseTo(3 * (1 - Math.sqrt(0.5)))
    expect(passTravelDistance(1.5, rules)).toBe(7.5)
    expect(passTravelDistance(4, rules)).toBe(10)
    expect(loosePassingRule(rules)).toEqual({ maxDistance: 6, maxDuration: 3 })
    expect(rules.roles.electro.sprint).toEqual({ maxDistance: 8, maxDuration: 3.8, cooldown: 4, recoveryDuration: 15 })
    expect(rules.roles.electro.e).toBeUndefined()
    expect(rules.roles.electro.attackRadius).toBe(rules.roles.water.attackRadius)
    expect(rules.roles.electro.attackInnerRadius).toBe(rules.roles.water.attackInnerRadius)
  })

  it.each(['blue-fire', 'red-fire'])('authors a fixed instant 1.8-grid Q for %s with distinct edges and ten-second cooldown', (actorId) => {
    const document = setup(actorId)
    const origin = document.initialScene.players.find((player) => player.id === actorId)!.position
    const state = useTacticStore.getState()
    state.setTool('qMove')
    state.createAction(actorId, { x: origin.x + 0.2, y: origin.y })
    const after = useTacticStore.getState().document
    const q = after.actions.find((action) => action.type === 'qMove')!
    expect(q).toMatchObject({ startTime: 0, duration: 0 })
    expect(pathLength(q.path)).toBeCloseTo(1.8)
    expect(after.stepMarkers).toHaveLength(2)
    for (const edge of ['start', 'end'] as const) {
      const frame = projectFrameAtKeyframe(after, 0, { playerId: actorId, actionId: q.id, edge })
      expect(frame.players.find((player) => player.id === actorId)?.position).toEqual(edge === 'start' ? origin : q.path.at(-1))
      expect(frame.cooldowns[actorId]?.q).toBe(edge === 'start' ? 0 : 10)
    }
    expect(validateQStart(after, actorId, 9.99).valid).toBe(false)
    expect(validateQStart(after, actorId, 10).valid).toBe(true)
  })

  it('clips a fixed Q at the field wall and preserves its length on redirect', () => {
    const state = useTacticStore.getState()
    state.moveEntity('blue-fire', { x: 19, y: 7 })
    state.setTool('qMove')
    state.createAction('blue-fire', { x: 19.1, y: 7 })
    let q = useTacticStore.getState().document.actions.find((action) => action.type === 'qMove')!
    expect(q.path.at(-1)).toEqual({ x: 20, y: 7 })
    state.updateActionPathPoint(q.id, 1, { x: 19, y: 7.1 })
    q = useTacticStore.getState().document.actions.find((action) => action.type === 'qMove')!
    expect(pathLength(q.path)).toBeCloseTo(1.8)
    expect(q.path.at(-1)).toEqual({ x: 19, y: 8.8 })
  })

  it.each([
    ['electro', 'water', 0], ['electro', 'fire', 0], ['electro', 'ice', 2], ['electro', 'geo', -1],
    ['water', 'electro', 0], ['fire', 'electro', 0], ['ice', 'electro', -2], ['geo', 'electro', 0],
    ['electro', 'electro', null],
  ] as const)('evaluates %s attacking %s as %s', (attacker: RoleId, defender: RoleId, rating) => {
    const document = createDefaultDocument()
    document.rulesSnapshot.modifiers.forEach((modifier) => { modifier.enabled = false })
    document.initialScene.players[0]!.role = attacker
    document.initialScene.players[3]!.role = defender
    expect(evaluateMatchup(document, 0, document.initialScene.players[0]!.id, document.initialScene.players[3]!.id))
      .toMatchObject({ base: rating, final: rating })
  })
})
