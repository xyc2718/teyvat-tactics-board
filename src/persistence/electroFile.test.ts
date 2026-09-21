import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { MoveAction, TacticDocumentV1 } from '../domain/model/types'
import { defaultRules } from '../domain/rules/defaultRules'
import { loadDraft, parseTactic, saveDraft, serializeTactic } from './tacticFile'

function roundTrip(document: TacticDocumentV1) {
  const result = parseTactic(serializeTactic(document))
  if (!result.ok) throw Error(result.error)
  return result.document
}

function sprintDocument() {
  const document = createDefaultDocument()
  document.initialScene.players.find((player) => player.id === 'blue-fire')!.role = 'electro'
  document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
  const sprint: MoveAction = {
    id: 'electro-e', type: 'move', actorId: 'blue-fire', sprint: true,
    startTime: 1, duration: 1.9, path: [{ x: 3.5, y: 7 }, { x: 7.5, y: 7 }],
    timingConstraint: { kind: 'fixed' },
  }
  document.actions.push(sprint)
  return { document, sprint }
}

describe('Electro persistence and default migration', () => {
  it('adds only missing Electro parameters to an older four-role document, draft and repeated round trip', () => {
    const document = createDefaultDocument()
    document.rulesSnapshot.roles.geo.q.cooldown = 9
    document.rulesSnapshot.passing = { ...document.rulesSnapshot.passing, maxDistance: 8, ballSpeed: 4 }
    document.rulesSnapshot.matchups.water.fire = null
    document.rulesSnapshot.matchups.ice.water = 0
    document.basicPlayerRoles = { 'blue-water': 'electro' }
    const expectedRules = structuredClone(document.rulesSnapshot)
    Reflect.deleteProperty(document.rulesSnapshot.roles, 'electro')
    Reflect.deleteProperty(document.rulesSnapshot.matchups, 'electro')
    for (const row of Object.values(document.rulesSnapshot.matchups)) Reflect.deleteProperty(row, 'electro')
    const restored = roundTrip(document)
    expect(restored.rulesSnapshot).toEqual(expectedRules)
    expect(restored.basicPlayerRoles).toEqual(document.basicPlayerRoles)
    expect(restored.initialScene).toEqual(document.initialScene)
    saveDraft(document)
    expect(loadDraft()?.rulesSnapshot).toEqual(expectedRules)
    expect(roundTrip(restored).rulesSnapshot).toEqual(expectedRules)
    restored.rulesSnapshot.roles.electro.sprint!.maxDistance = 9
    expect(defaultRules.roles.electro.sprint?.maxDistance).toBe(8)
    expect(roundTrip(document).rulesSnapshot.roles.electro.sprint?.maxDistance).toBe(8)
  })

  it('fills absent row cells while preserving custom, neutral and unevaluated ratings', () => {
    const document = createDefaultDocument()
    document.rulesSnapshot.matchups.electro.ice = null
    document.rulesSnapshot.matchups.electro.geo = 0
    document.rulesSnapshot.matchups.water.electro = 2
    document.rulesSnapshot.matchups.ice.electro = null
    Reflect.deleteProperty(document.rulesSnapshot.matchups.electro, 'fire')
    Reflect.deleteProperty(document.rulesSnapshot.matchups.geo, 'electro')
    const rules = roundTrip(document).rulesSnapshot
    expect(rules.matchups.electro).toEqual({ water: 0, fire: 0, ice: null, geo: 0, electro: null })
    expect(rules.matchups.water.electro).toBe(2)
    expect(rules.matchups.ice.electro).toBeNull()
    expect(rules.matchups.geo.electro).toBe(0)
  })

  it('preserves custom Electro rules and does not install E on an explicit role without it', () => {
    const document = createDefaultDocument()
    const role = document.rulesSnapshot.roles.electro
    role.label = '自定义雷'
    role.q = { ...role.q, maxDistance: 2, fixedDistance: false, cooldown: 0 }
    role.sprint = { maxDistance: 9, maxDuration: 4, cooldown: 0, recoveryDuration: 12 }
    expect(roundTrip(document).rulesSnapshot.roles.electro).toEqual(role)
    delete role.sprint
    expect(roundTrip(document).rulesSnapshot.roles.electro.sprint).toBeUndefined()
    Reflect.deleteProperty(role.q, 'fixedDistance')
    expect(roundTrip(document).rulesSnapshot.roles.electro.q.fixedDistance).toBe(true)
  })

  it('round-trips sprint geometry, timing and a separately editable ordinary tail without persisting energy', () => {
    const { document, sprint } = sprintDocument()
    document.actions.push({ id: 'ordinary-tail', type: 'move', actorId: sprint.actorId,
      startTime: 2.9, duration: 1, path: [{ x: 7.5, y: 7 }, { x: 8.5, y: 7 }] })
    document.basicPlayerRoles = { [sprint.actorId]: 'anemo' }
    const restored = roundTrip(document)
    expect(restored.actions).toEqual(document.actions)
    expect(restored.initialScene.players.find((player) => player.id === sprint.actorId)?.role).toBe('electro')
    expect(restored.basicPlayerRoles).toEqual(document.basicPlayerRoles)
    expect(restored).not.toHaveProperty('sprintStates')
    expect(restored.initialScene).not.toHaveProperty('energy')
  })

  it('preserves an own E-ready wait and rejects missing, wrong-player or wrong-edge event references', () => {
    const { document, sprint } = sprintDocument()
    const reference = { playerId: sprint.actorId, actionId: sprint.id, event: 'eReady' as const, edge: 'end' as const }
    document.actions.push({ id: 'wait-e-ready', type: 'wait', actorId: sprint.actorId,
      startTime: 2.9, duration: 4, timingConstraint: { kind: 'keyframe', reference } })
    expect(roundTrip(document).actions).toEqual(document.actions)
    for (const patch of [{ actionId: 'missing' }, { playerId: 'blue-ice' }, { edge: 'start' }]) {
      const invalid = structuredClone(document)
      const wait = invalid.actions.find((action) => action.type === 'wait')!
      Object.assign(wait.timingConstraint!.reference, patch)
      expect(parseTactic(serializeTactic(invalid)).ok).toBe(false)
    }
  })

  it('round-trips a causal reception stop and rejects missing, non-pass or wrong-actor sources', () => {
    const { document, sprint } = sprintDocument()
    document.actions.push({ id: 'incoming', type: 'pass', actorId: 'blue-water', targetPlayerId: sprint.actorId,
      startTime: 1, duration: 1.9, path: [{ x: 5.5, y: 4.7 }, { x: 7.5, y: 7 }], flightOutcome: 'received' })
    sprint.sprintReceptionSourceId = 'incoming'
    expect(roundTrip(document).actions).toEqual(document.actions)
    for (const source of ['missing', sprint.id]) {
      sprint.sprintReceptionSourceId = source
      expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    }
    sprint.sprintReceptionSourceId = 'incoming'
    const pass = document.actions.find((action) => action.type === 'pass')!
    pass.targetPlayerId = 'blue-ice'
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    pass.targetPlayerId = sprint.actorId
    delete sprint.sprint
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
  })

  it.each([
    null, {}, { maxDistance: 0, maxDuration: 3.8, cooldown: 4, recoveryDuration: 15 },
    { maxDistance: 8, maxDuration: 0, cooldown: 4, recoveryDuration: 15 },
    { maxDistance: 8, maxDuration: 3.8, cooldown: -1, recoveryDuration: 15 },
    { maxDistance: 8, maxDuration: 3.8, cooldown: 4, recoveryDuration: 0 },
    { maxDistance: Infinity, maxDuration: 3.8, cooldown: 4, recoveryDuration: 15 },
    { maxDistance: '8', maxDuration: 3.8, cooldown: 4, recoveryDuration: 15 },
    { maxDistance: 8, maxDuration: 3.8, cooldown: 4, recoveryDuration: 15, energy: 100 },
  ])('rejects malformed explicit sprint rules instead of defaulting %j', (sprint) => {
    const document = createDefaultDocument()
    Object.assign(document.rulesSnapshot.roles.electro, { sprint })
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
  })

  it.each(['wrong-actor', 'no-rule', 'wrong-rule-role', 'over-budget', 'pickup', 'follow', 'false', 'object'])(
    'rejects structurally invalid sprint contracts: %s', (variant) => {
      const { document, sprint } = sprintDocument()
      if (variant === 'wrong-actor') sprint.actorId = 'blue-water'
      if (variant === 'no-rule') delete document.rulesSnapshot.roles.electro.sprint
      if (variant === 'wrong-rule-role') document.rulesSnapshot.roles.fire.sprint = { ...defaultRules.roles.electro.sprint! }
      if (variant === 'over-budget') sprint.duration = 3.80001
      if (variant === 'pickup') sprint.ballTarget = { sourceActionId: null }
      if (variant === 'follow') Object.assign(sprint, { targetPlayerId: 'blue-ice', syncActionId: 'target-run', followGap: 0.5 })
      if (variant === 'false') Object.assign(sprint, { sprint: false })
      if (variant === 'object') Object.assign(sprint, { sprint: { enabled: true } })
      expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    },
  )

  it.each(['role', 'row', 'rating', 'unknown-role'])('rejects malformed explicit Electro %s', (variant) => {
    const document = createDefaultDocument()
    if (variant === 'role') Object.assign(document.rulesSnapshot.roles, { electro: null })
    if (variant === 'row') Object.assign(document.rulesSnapshot.matchups, { electro: null })
    if (variant === 'rating') Object.assign(document.rulesSnapshot.matchups.electro, { ice: 3 })
    if (variant === 'unknown-role') Object.assign(document.initialScene.players[0]!, { role: 'anemo' })
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
  })
})
