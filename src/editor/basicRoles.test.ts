import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASIC_ROLE_IDS, basicRoleDisplay, basicRoleRule, effectiveBasicRole } from '../domain/model/basicRoles'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { BasicRoleId } from '../domain/model/types'
import * as passReception from '../domain/timeline/passReception'
import * as projection from '../domain/timeline/projectFrame'
import { loadDraft, parseTactic, serializeTactic } from '../persistence/tacticFile'
import * as locomotion from './locomotionScheduling'
import { useTacticStore } from './useTacticStore'

describe('basic player role edits', () => {
  beforeEach(() => {
    const document = createDefaultDocument()
    useTacticStore.setState({
      document, boardMode: 'basic', selection: null, tool: 'select',
      activeStepId: document.stepMarkers[0]!.id, currentTime: 0, currentKeyframe: null,
      isPlaying: false, showAdvancedTimeline: false, notice: null, past: [], future: [],
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('accepts all six identities for both teams without changing simulation roles', () => {
    for (const id of ['blue-water', 'red-water']) {
      for (const role of BASIC_ROLE_IDS) {
        useTacticStore.getState().setBasicPlayerRole(id, role)
        const document = useTacticStore.getState().document
        const player = document.initialScene.players.find((candidate) => candidate.id === id)!
        expect(effectiveBasicRole(document, player)).toBe(role)
        expect(player.role).toBe('water')
      }
    }
  })

  it('ignores unchanged identities, unknown inputs, and commands outside basic mode', () => {
    useTacticStore.setState({ future: [createDefaultDocument()], notice: '保留提示' })
    const initial = useTacticStore.getState()
    initial.setBasicPlayerRole('blue-water', 'water')
    initial.setBasicPlayerRole('missing-player', 'geo')
    initial.setBasicPlayerRole('blue-water', 'unknown' as BasicRoleId)
    expect(useTacticStore.getState()).toBe(initial)

    initial.setBasicPlayerRole('blue-water', 'geo')
    const changed = useTacticStore.getState()
    changed.setBasicPlayerRole('blue-water', 'geo')
    expect(useTacticStore.getState()).toBe(changed)
    changed.setBoardMode('simulation')
    const simulation = useTacticStore.getState()
    simulation.setBasicPlayerRole('blue-water', 'anemo')
    expect(useTacticStore.getState()).toBe(simulation)
  })

  it('falls back for player IDs that match inherited object properties', () => {
    const document = createDefaultDocument()
    document.basicPlayerRoles = {}
    const player = { ...document.initialScene.players[0]!, id: 'toString' }
    expect(effectiveBasicRole(document, player)).toBe(player.role)
  })

  it.each(['__proto__', 'constructor', 'toString'])('saves an edited legacy player whose ID is %s', (playerId) => {
    const legacy = parseTactic(serializeTactic(createDefaultDocument()).replaceAll('blue-water', playerId))
    expect(legacy.ok).toBe(true)
    if (!legacy.ok) throw new Error(legacy.error)
    const state = useTacticStore.getState()
    state.openDocument(legacy.document)
    state.setBoardMode('basic')
    state.setBasicPlayerRole(playerId, 'electro')

    const document = useTacticStore.getState().document
    expect(document.basicPlayerRoles).toEqual({ [playerId]: 'electro' })
    const parsed = parseTactic(serializeTactic(document))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(Object.hasOwn(parsed.document.basicPlayerRoles!, playerId)).toBe(true)
    expect(effectiveBasicRole(parsed.document, parsed.document.initialScene.players[0]!)).toBe('electro')
    expect(loadDraft()?.basicPlayerRoles).toEqual(document.basicPlayerRoles)
    expect(parseTactic(JSON.stringify({ ...document, basicPlayerRoles: { [playerId]: 'unknown' } })).ok).toBe(false)
    state.undo()
    expect(loadDraft()?.basicPlayerRoles).toBeUndefined()
    state.redo()
    expect(loadDraft()?.basicPlayerRoles).toEqual(document.basicPlayerRoles)
  })

  it('preserves simulation actions, rules, snapshots and projection without solving or reflowing', () => {
    const state = useTacticStore.getState()
    state.setBoardMode('simulation')
    state.setTool('pass')
    state.createAction('blue-water', { x: 3.5, y: 7 }, 'blue-fire')
    expect(useTacticStore.getState().document.actions.some((action) => action.type === 'pass')).toBe(true)
    state.setBoardMode('basic')
    const before = useTacticStore.getState()
    const frame = projection.projectFrame(before.document, 1)
    const solve = vi.spyOn(passReception, 'solvePassReception')
    const reflow = vi.spyOn(locomotion, 'reflowSimpleLocomotion')
    const follow = vi.spyOn(locomotion, 'syncFollowMoveTimings')
    const project = vi.spyOn(projection, 'projectFrame')

    before.setBasicPlayerRole('blue-water', 'electro')

    const after = useTacticStore.getState()
    expect(solve).not.toHaveBeenCalled()
    expect(reflow).not.toHaveBeenCalled()
    expect(follow).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()
    expect(after.document.actions).toEqual(before.document.actions)
    expect(after.document.initialScene).toEqual(before.document.initialScene)
    expect(after.document.stepMarkers).toEqual(before.document.stepMarkers)
    expect(after.document.rulesSnapshot).toEqual(before.document.rulesSnapshot)
    expect(after.past).toHaveLength(before.past.length + 1)
    expect(projection.projectFrame(after.document, 1)).toEqual(frame)
  })

  it('keeps explicit original identities independent across mode switches and simulation edits', () => {
    const state = useTacticStore.getState()
    state.setBasicPlayerRole('blue-water', 'fire')
    state.setBasicPlayerRole('red-fire', 'anemo')
    state.setBoardMode('simulation')
    state.setPlayerRole('blue-water', 'ice')
    state.setBoardMode('basic')
    const document = useTacticStore.getState().document
    expect(document.basicPlayerRoles).toEqual({ 'blue-water': 'fire', 'red-fire': 'anemo' })
    expect(document.initialScene.players.find((player) => player.id === 'blue-water')?.role).toBe('ice')
  })

  it('uses real Geo ranges without converting the independent basic override into a simulation role', () => {
    const state = useTacticStore.getState()
    state.setBasicPlayerRole('blue-water', 'geo')
    state.setBoardMode('simulation')
    expect(useTacticStore.getState().document.initialScene.players[0]!.role).toBe('water')
    state.setPlayerRole('blue-water', 'fire')
    state.setBoardMode('basic')
    const document = useTacticStore.getState().document
    const role = effectiveBasicRole(document, document.initialScene.players[0]!)
    expect(role).toBe('geo')
    const rules = document.rulesSnapshot
    expect(basicRoleDisplay(role, rules)).toMatchObject({ label: '万象', shortLabel: '岩' })
    expect(basicRoleRule(role, rules)).toBe(rules.roles.geo)
    expect(basicRoleRule(role, rules)?.attackRadius).toBe(1.5)
    expect(rules.roles.geo.attackRadius + rules.roles.geo.q.maxDistance).toBe(3.9)
    rules.roles.geo.attackRadius = 1.8
    expect(basicRoleRule(role, rules)?.attackRadius).toBe(1.8)
    expect(basicRoleRule('electro', rules)).toBeUndefined()
    expect(basicRoleRule('anemo', rules)).toBeUndefined()
  })

  it('round-trips drafts, import, undo and redo with one history entry per role edit', () => {
    const state = useTacticStore.getState()
    state.setBasicPlayerRole('blue-water', 'electro')
    expect(useTacticStore.getState().past).toHaveLength(1)
    expect(loadDraft()?.basicPlayerRoles).toEqual({ 'blue-water': 'electro' })
    state.undo()
    expect(useTacticStore.getState().document.basicPlayerRoles).toBeUndefined()
    expect(loadDraft()?.basicPlayerRoles).toBeUndefined()
    state.redo()
    expect(useTacticStore.getState().document.basicPlayerRoles).toEqual({ 'blue-water': 'electro' })
    const parsed = parseTactic(serializeTactic(useTacticStore.getState().document))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    state.openDocument(parsed.document)
    expect(useTacticStore.getState()).toMatchObject({
      boardMode: 'simulation', past: [], future: [], document: { basicPlayerRoles: { 'blue-water': 'electro' } },
    })
    state.setBoardMode('basic')
    state.moveEntity('blue-water', { x: 8, y: 6 })
    state.setTool('move')
    state.createAction('blue-water', { x: 10, y: 6 })
    expect(useTacticStore.getState().document).toMatchObject({
      basicPlayerRoles: { 'blue-water': 'electro' },
      staticMoveArrows: [{ playerId: 'blue-water', target: { x: 10, y: 6 } }], actions: [],
    })
  })

  it('clears overrides on new and reset documents', () => {
    const state = useTacticStore.getState()
    state.setBasicPlayerRole('blue-water', 'geo')
    state.resetTactic()
    expect(useTacticStore.getState().document.basicPlayerRoles).toBeUndefined()
    state.setBoardMode('basic')
    state.setBasicPlayerRole('red-water', 'anemo')
    state.newDocument()
    expect(useTacticStore.getState().document.basicPlayerRoles).toBeUndefined()
    expect(useTacticStore.getState().boardMode).toBe('simulation')
  })
})
