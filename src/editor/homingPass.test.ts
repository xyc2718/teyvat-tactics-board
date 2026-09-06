import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { MAX_PASS_PATH_POINTS } from '../domain/model/passFlight'
import { pathLength } from '../domain/geometry/geometry'
import type { PassAction } from '../domain/model/types'
import { actionEndTime } from '../domain/timeline/durations'
import { receiveBoostWindowFor } from '../domain/timeline/movementEffects'
import * as solver from '../domain/timeline/passReception'
import { createPlayerPositionReader, projectFrame, projectPlayerPosition } from '../domain/timeline/projectFrame'
import { parseTactic, serializeTactic } from '../persistence/tacticFile'
import { useTacticStore } from './useTacticStore'

function setup(escape = false) {
  const document = createDefaultDocument()
  const fire = document.initialScene.players.find((player) => player.id === 'blue-fire')!
  const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
  fire.position = { x: 1, y: 4 }
  ice.position = { x: escape ? 8.5 : 6, y: 4 }
  document.initialScene.players.forEach((player) => { player.hasBall = player.id === fire.id })
  document.initialScene.ball = { carrierId: fire.id, position: { ...fire.position }, isFree: false }
  document.actions.push({
    id: 'receiver-run', type: 'move', actorId: ice.id, startTime: 0, duration: 6,
    path: [{ ...ice.position }, escape ? { x: 14.5, y: 4 } : { x: 6, y: 10 }],
  })
  document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
  document.stepMarkers.push({ id: 'step-action', time: 0, name: '步骤 1', note: '', snapshot: structuredClone(document.initialScene) })
  useTacticStore.setState({
    document, tool: 'select', boardMode: 'simulation', activeStepId: 'step-action',
    currentTime: 0, currentKeyframe: null, selection: null, past: [], future: [],
    showAdvancedTimeline: true, isPlaying: false, notice: null,
  })
  useTacticStore.getState().setTool('pass')
  useTacticStore.getState().createAction(fire.id, ice.position, ice.id)
  return currentPass()
}

function currentPass(): PassAction {
  const pass = useTacticStore.getState().document.actions.find((action) => action.type === 'pass')
  if (pass?.type !== 'pass') throw new Error('Missing homing pass')
  return pass
}

afterEach(() => vi.restoreAllMocks())

describe('homing pass editor integration', () => {
  it('stores a curved path and one exact catch, follows the carrier, and allows immediate onward passing', () => {
    const pass = setup()
    let document = useTacticStore.getState().document
    expect(pass.flightOutcome).toBe('received')
    expect(pass.path.length).toBeGreaterThan(2)
    expect(pass.path.length).toBeLessThanOrEqual(MAX_PASS_PATH_POINTS)
    const end = actionEndTime(pass)
    const receives = document.actions.filter((action) => action.type === 'receive' && action.sourceActionId === pass.id)
    expect(receives).toHaveLength(1)
    expect(receives[0]).toMatchObject({ actorId: 'blue-ice', startTime: end, duration: 0 })
    expect(receiveBoostWindowFor(document, 'blue-ice', end)?.start).toBe(end)
    for (const time of [end, end + 0.1, end + 1]) {
      const frame = projectFrame(document, time)
      expect(frame.ball.carrierId).toBe('blue-ice')
      expect(frame.ball.position).toEqual(frame.players.find((player) => player.id === 'blue-ice')?.position)
    }
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-ice', { x: 5.5, y: 4.7 }, 'blue-water')
    document = useTacticStore.getState().document
    const onward = document.actions.find((action) => action.type === 'pass' && action.id !== pass.id)
    expect(onward).toMatchObject({ actorId: 'blue-ice', startTime: end, flightOutcome: 'received' })
    if (onward?.type !== 'pass') throw new Error('Missing immediate onward pass')
    expect(onward.path[0]).toEqual(pass.path.at(-1))
    expect(projectFrame(document, actionEndTime(onward)).ball.carrierId).toBe('blue-water')
  })

  it('drops after the unchanged 8-grid/1-second budget with no catch or boost even after the runner moves on', () => {
    const pass = setup(true)
    const document = useTacticStore.getState().document
    expect(pass.flightOutcome).toBe('dropped')
    expect(pass.duration).toBe(1)
    expect(pathLength(pass.path)).toBeCloseTo(8, 8)
    expect(document.actions.some((action) => action.type === 'receive' && action.sourceActionId === pass.id)).toBe(false)
    expect(receiveBoostWindowFor(document, 'blue-ice', 1)).toBeUndefined()
    for (const time of [1, 2, 5]) {
      expect(projectFrame(document, time).ball).toMatchObject({ isFree: true, carrierId: null, position: pass.path.at(-1) })
    }
    // Even a stale imported linked receive cannot award possession on a miss.
    const stale = structuredClone(document)
    stale.actions.push({ id: 'stale-receive', type: 'receive', sourceActionId: pass.id, actorId: 'blue-ice', startTime: 1, duration: 0 })
    expect(projectFrame(stale, 2).ball.carrierId).toBeNull()
    useTacticStore.getState().replaceDocument(stale)
    expect(useTacticStore.getState().document.actions.some((action) => action.id === 'stale-receive')).toBe(false)
  })

  it('resolves once on relevant edits, not on time scrubbing, and survives undo/export/import', () => {
    setup()
    const before = structuredClone(currentPass())
    const solveSpy = vi.spyOn(solver, 'solvePassReception')
    useTacticStore.getState().createSlowStatus('blue-ice', 0)
    expect(solveSpy).toHaveBeenCalledTimes(1)
    expect(currentPass().path).not.toEqual(before.path)
    const after = structuredClone(currentPass())
    solveSpy.mockClear()
    const document = useTacticStore.getState().document
    for (let index = 0; index < 90; index += 1) {
      const time = ((index * 37) % 91) / 91
      useTacticStore.getState().setCurrentTime(time)
      projectFrame(document, time)
    }
    expect(solveSpy).not.toHaveBeenCalled()
    expect(useTacticStore.getState().document).toBe(document)
    useTacticStore.getState().undo()
    expect(currentPass()).toEqual(before)
    useTacticStore.getState().redo()
    expect(currentPass()).toEqual(after)
    const parsed = parseTactic(serializeTactic(useTacticStore.getState().document))
    if (!parsed.ok) throw new Error(parsed.error)
    useTacticStore.getState().replaceDocument(parsed.document)
    expect(currentPass()).toEqual(after)
  })

  it('invalidates a route when an enemy ice zone changes the receiver trajectory', () => {
    setup()
    const before = structuredClone(currentPass())
    const document = structuredClone(useTacticStore.getState().document)
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 6, y: 4 }
    useTacticStore.setState({ document, currentTime: 0 })
    useTacticStore.getState().createEZone('red-ice')
    expect(currentPass().path).not.toEqual(before.path)
    expect(currentPass().duration).not.toBe(before.duration)
  })

  it('shares immutable solver position reads without leaking frame data', () => {
    setup()
    const document = useTacticStore.getState().document
    const read = createPlayerPositionReader(document, 'blue-ice')
    for (const time of [0, currentPass().duration, 0.77, 2, 6]) {
      expect(read(time)).toEqual(projectPlayerPosition(document, 'blue-ice', time))
    }
    const original = read(0)!
    original.x = 999
    expect(read(0)?.x).not.toBe(999)
  })

  it('reorders Q-bound launches before solving dependent receiver boosts after a timing edit', () => {
    const document = createDefaultDocument()
    const fire = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    const water = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    fire.position = { x: 2, y: 7 }
    water.position = { x: 1, y: 7 }
    ice.position = { x: 6, y: 7 }
    document.actions = [
      { id: 'run', type: 'move', actorId: ice.id, startTime: 0, duration: 4, path: [{ ...ice.position }, { x: 6, y: 11 }] },
      { id: 'launch-q', type: 'qMove', actorId: fire.id, startTime: 2, duration: 0, path: [{ ...fire.position }, { x: 4.3, y: 7 }] },
      { id: 'ordinary-pass', type: 'pass', actorId: water.id, targetPlayerId: ice.id, startTime: 0.5, duration: 0, path: [{ ...water.position }, { ...ice.position }] },
      { id: 'bound-pass', type: 'pass', actorId: fire.id, targetPlayerId: ice.id, startTime: 2, duration: 0, path: [{ x: 4.3, y: 7 }, { ...ice.position }], originKeyframe: { playerId: fire.id, actionId: 'launch-q', edge: 'end' } },
    ]
    useTacticStore.getState().replaceDocument(document)
    useTacticStore.getState().updateActionTiming('launch-q', 'startTime', 0)
    const edited = useTacticStore.getState().document
    const ordinary = edited.actions.find((action) => action.id === 'ordinary-pass')
    const bound = edited.actions.find((action) => action.id === 'bound-pass')
    if (ordinary?.type !== 'pass' || bound?.type !== 'pass') throw new Error('Missing reordered passes')
    expect(bound.startTime).toBe(0)
    expect(actionEndTime(bound)).toBeLessThan(ordinary.startTime)
    const resolved = solver.solvePassReception(edited, ordinary)
    expect(ordinary.path).toEqual(resolved.path)
    expect(ordinary.duration).toBe(resolved.duration)
    expect(projectPlayerPosition(edited, ice.id, actionEndTime(ordinary))?.y).toBeCloseTo(ordinary.path.at(-1)!.y, 8)
  })
})
