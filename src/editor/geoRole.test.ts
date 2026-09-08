import { beforeEach, describe, expect, it } from 'vitest'
import { pathLength } from '../domain/geometry/geometry'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { RoleId, TacticDocumentV1 } from '../domain/model/types'
import { evaluateMatchup } from '../domain/rules/evaluateRules'
import { earliestLegalQStart, validateQStart } from '../domain/rules/qCooldown'
import { playerActionKeyframes } from '../domain/timeline/playerKeyframes'
import { effectiveQPath, projectFrame, projectFrameAtKeyframe } from '../domain/timeline/projectFrame'
import { parseTactic, serializeTactic } from '../persistence/tacticFile'
import { useTacticStore } from './useTacticStore'

function setup(actorId = 'blue-water') {
  const document = createDefaultDocument()
  document.initialScene.players.find((player) => player.id === actorId)!.role = 'geo'
  document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
  document.stepMarkers.push({ id: 'editable', time: 0, name: '步骤 2', note: '', snapshot: structuredClone(document.initialScene) })
  useTacticStore.setState({
    document, selection: { kind: 'player', id: actorId }, tool: 'select', boardMode: 'simulation',
    activeStepId: 'editable', currentTime: 0, currentKeyframe: null,
    isPlaying: false, showAdvancedTimeline: false, notice: null, past: [], future: [],
  })
  return document
}

function geoQ(document: TacticDocumentV1 = useTacticStore.getState().document) {
  const action = document.actions.find((candidate) => candidate.type === 'qMove')
  if (!action || action.type !== 'qMove') throw Error('Expected Geo Q')
  return action
}

describe('Geo simulation role', () => {
  beforeEach(() => { setup() })

  it.each(['blue-water', 'red-water'])('authors a full fixed blink for %s and chains a run at the same timestamp', (actorId) => {
    const document = setup(actorId)
    const origin = document.initialScene.players.find((player) => player.id === actorId)!.position
    const state = useTacticStore.getState()
    state.setTool('qMove')
    state.createAction(actorId, { x: origin.x + 0.5, y: origin.y })
    const q = geoQ()
    expect(q).toMatchObject({ actorId, startTime: 0, duration: 0 })
    expect(pathLength(q.path)).toBeCloseTo(2.4)
    expect(useTacticStore.getState().currentKeyframe).toEqual({ playerId: actorId, actionId: q.id, edge: 'end' })
    state.setTool('move')
    state.createAction(actorId, { x: origin.x + 3.4, y: origin.y })
    const after = useTacticStore.getState().document
    const move = after.actions.find((action) => action.type === 'move')!
    expect(move).toMatchObject({ actorId, startTime: 0, duration: 1, path: [q.path.at(-1), { x: origin.x + 3.4, y: origin.y }] })
    const reversed = { ...after, actions: [...after.actions].reverse() }
    expect(projectFrame(reversed, 0.5).players.find((player) => player.id === actorId)?.position.x).toBeCloseTo(origin.x + 2.9)
    expect(projectFrame(after, 0.5).statuses.some((status) => status.sourceActionId === q.id)).toBe(false)
  })

  it('clips only at the field boundary and preserves fixed length while redirecting an existing Q', () => {
    const state = useTacticStore.getState()
    state.moveEntity('blue-water', { x: 19, y: 7 })
    state.setTool('qMove')
    state.createAction('blue-water', { x: 19.1, y: 7 })
    const q = geoQ()
    expect(q.path.at(-1)).toEqual({ x: 20, y: 7 })
    expect(pathLength(q.path)).toBeCloseTo(1)
    state.updateActionPathPoint(q.id, 1, { x: 19, y: 7.1 })
    expect(geoQ().path.at(-1)).toEqual({ x: 19, y: 9.4 })
    expect(pathLength(geoQ().path)).toBeCloseTo(2.4)
  })

  it.each(['start', 'end'] as const)('keeps the %s Q edge through an anchored pass, path edit and file round trip', (edge) => {
    const state = useTacticStore.getState()
    state.setTool('qMove')
    state.createAction('blue-water', { x: 6, y: 4.7 })
    const q = geoQ()
    const reference = { playerId: q.actorId, actionId: q.id, edge }
    const keyframes = playerActionKeyframes(useTacticStore.getState().document, q.actorId)
    expect(keyframes.map((keyframe) => [keyframe.edge, keyframe.time])).toEqual([['end', 0], ['start', 0]])
    state.setTimelineKeyframe(reference)
    const beforePass = useTacticStore.getState().document
    const frame = projectFrameAtKeyframe(beforePass, 0, reference)
    expect(frame.players.find((player) => player.id === q.actorId)?.position).toEqual(edge === 'start' ? q.path[0] : q.path.at(-1))
    expect(frame.cooldowns[q.actorId]?.q).toBe(edge === 'start' ? 0 : 9)
    state.setTool('pass')
    state.createAction(q.actorId, { x: 3.5, y: 7 }, 'blue-fire')
    state.updateActionPathPoint(q.id, 1, { x: 5.5, y: 6 })
    const document = useTacticStore.getState().document
    const pass = document.actions.find((action) => action.type === 'pass')!
    expect(pass.originKeyframe).toEqual(reference)
    expect(pass.path[0]).toEqual(edge === 'start' ? geoQ().path[0] : geoQ().path.at(-1))
    const parsed = parseTactic(serializeTactic(document))
    if (!parsed.ok) throw Error(parsed.error)
    expect(parsed.document.actions).toEqual(document.actions)
    expect(projectFrame(parsed.document, pass.startTime + pass.duration).ball.carrierId).toBe('blue-fire')
  })

  it.each([4, 12])('waits for overlapping freeze and cooldown before the next Q (thaw=%s)', (thaw) => {
    const document = useTacticStore.getState().document
    document.actions.push(
      { id: 'previous-q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0,
        path: [{ x: 5.5, y: 4.7 }, { x: 7.9, y: 4.7 }] },
      { id: 'freeze', type: 'status', targetId: 'blue-water', status: 'frozen', startTime: 1, duration: thaw - 1 },
    )
    useTacticStore.setState({ document, currentTime: 2 })
    const state = useTacticStore.getState()
    state.setTool('qMove')
    expect(useTacticStore.getState().currentTime).toBe(Math.max(thaw, 9))
    state.createAction('blue-water', { x: 9, y: 4.7 })
    const actions = useTacticStore.getState().document.actions.filter((action) => action.type === 'qMove')
    expect(actions).toHaveLength(2)
    expect(actions[1]!.startTime).toBe(Math.max(thaw, 9))
    expect(actions[1]!.path[0]).toEqual(actions[0]!.path.at(-1))
    expect(validateQStart(document, 'blue-water', 9).valid).toBe(true)
    expect(validateQStart(document, 'blue-water', 8.99).valid).toBe(false)
    expect(earliestLegalQStart(document, 'blue-water', 1)).toBe(9)
  })

  it('keeps Geo Q distance inside an enemy Ice field while ordinary running still slows', () => {
    const document = useTacticStore.getState().document
    document.initialScene.players[0]!.position = { x: 5, y: 7 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 6, y: 7 }
    document.actions = [
      { id: 'enemy-field', type: 'eZone', actorId: 'red-ice', startTime: 0, duration: 5, center: { x: 6, y: 7 }, radius: 2 },
      { id: 'geo-q', type: 'qMove', actorId: 'blue-water', startTime: 1, duration: 0, path: [{ x: 5, y: 7 }, { x: 7.4, y: 7 }] },
      { id: 'geo-run', type: 'move', actorId: 'blue-water', startTime: 1, duration: 1, path: [{ x: 7.4, y: 7 }, { x: 8.4, y: 7 }] },
    ]
    expect(pathLength(effectiveQPath(document, geoQ(document)))).toBeCloseTo(2.4)
    expect(projectFrame(document, 1).players[0]!.position).toEqual({ x: 7.4, y: 7 })
    expect(projectFrame(document, 1.5).players[0]!.position.x).toBeCloseTo(7.65)
    expect(document.rulesSnapshot.roles.geo.e).toBeUndefined()
  })

  it('reflows role and rule edits with undo/redo and resets to canonical Geo defaults', () => {
    const state = useTacticStore.getState()
    state.setTool('qMove')
    state.createAction('blue-water', { x: 6, y: 4.7 })
    state.updateRoleRule('geo', 'qDistance', 3)
    expect(pathLength(geoQ().path)).toBeCloseTo(3)
    state.undo()
    expect(pathLength(geoQ().path)).toBeCloseTo(2.4)
    state.redo()
    expect(pathLength(geoQ().path)).toBeCloseTo(3)
    state.setPlayerRole('blue-water', 'fire')
    expect(pathLength(geoQ().path)).toBeCloseTo(2.3)
    state.undo()
    expect(pathLength(geoQ().path)).toBeCloseTo(3)
    state.resetRules()
    expect(pathLength(geoQ().path)).toBeCloseTo(2.4)
    expect(useTacticStore.getState().document.rulesSnapshot.roles.geo.shield?.radius).toBe(1)
    state.resetTactic()
    expect(useTacticStore.getState().document.initialScene.players.map((player) => player.role)).toEqual(['water', 'fire', 'ice', 'water', 'fire', 'ice'])
  })

  it.each([
    ['water', 'geo', -1], ['fire', 'geo', 1], ['ice', 'geo', 0],
    ['geo', 'water', 0], ['geo', 'fire', -1], ['geo', 'ice', 1], ['geo', 'geo', 0],
  ] as const)('evaluates %s attacking %s as %s with modifiers disabled', (attackRole: RoleId, defenseRole: RoleId, rating) => {
    const document = createDefaultDocument()
    document.rulesSnapshot.modifiers.forEach((modifier) => { modifier.enabled = false })
    document.initialScene.players.find((player) => player.id === 'blue-water')!.role = attackRole
    document.initialScene.players.find((player) => player.id === 'red-water')!.role = defenseRole
    expect(evaluateMatchup(document, 0, 'blue-water', 'red-water')).toMatchObject({ base: rating, final: rating })
  })
})
