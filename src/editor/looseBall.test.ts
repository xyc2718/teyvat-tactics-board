import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pathLength } from '../domain/geometry/geometry'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { TacticDocumentV1 } from '../domain/model/types'
import { actionEndTime, passDuration } from '../domain/timeline/durations'
import * as normalization from '../domain/timeline/looseBall'
import { projectFrame } from '../domain/timeline/projectFrame'
import { playerActionKeyframes } from '../domain/timeline/playerKeyframes'
import { parseTactic, serializeTactic } from '../persistence/tacticFile'
import { useTacticStore } from './useTacticStore'

function load(document = createDefaultDocument()) {
  useTacticStore.setState({
    document, tool: 'select', boardMode: 'simulation', activeStepId: document.stepMarkers[0]!.id,
    currentTime: 0, currentKeyframe: null, selection: null, past: [], future: [],
    showAdvancedTimeline: false, isPlaying: false, notice: null, pickupError: null,
  })
}

function freeBallDocument(distance = 1): TacticDocumentV1 {
  const document = createDefaultDocument()
  document.initialScene.players.forEach((player) => { player.hasBall = false })
  document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 5, y: 10 }
  document.initialScene.ball = { carrierId: null, isFree: true, position: { x: 5 + distance, y: 10 } }
  document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
  return document
}

beforeEach(() => load())

describe('loose ball editor commands', () => {
  it('creates a direction-only empty pass and action step even without toolbar preparation', () => {
    useTacticStore.setState({ tool: 'loosePass' })
    useTacticStore.getState().createAction(null, { x: 15.5, y: 4.7 }, 'red-water')
    const state = useTacticStore.getState()
    const pass = state.document.actions.find((action) => action.type === 'loosePass')
    expect(pass).toMatchObject({ actorId: 'blue-water', duration: 3, flightOutcome: 'grounded' })
    expect(pass).not.toHaveProperty('targetPlayerId')
    if (pass?.type !== 'loosePass') throw new Error('Missing empty pass')
    expect(pathLength(pass.path)).toBeCloseTo(6)
    expect(state.document.stepMarkers).toHaveLength(2)
    expect(state.activeStepId).not.toBe('step-opening')
    expect(projectFrame(state.document, 1.5).ball.position.x).toBeCloseTo(10)
    expect(projectFrame(state.document, 3).ball).toMatchObject({ carrierId: null, isFree: true })
  })

  it('rejects a carrier-free empty pass and keeps basic mode timeline-free', () => {
    load(freeBallDocument())
    useTacticStore.setState({ tool: 'loosePass' })
    useTacticStore.getState().createAction('blue-ice', { x: 10, y: 10 })
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    expect(useTacticStore.getState().notice).toContain('持球')
    useTacticStore.setState({ boardMode: 'basic', tool: 'qMove' })
    useTacticStore.getState().createBallPickup('blue-ice')
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
  })

  it('preserves old and customized passing parameters on import and new passes in that tactic', () => {
    for (const oldSpeed of [8, 5.7]) {
      const old = createDefaultDocument()
      old.rulesSnapshot.passing.ballSpeed = oldSpeed
      delete old.rulesSnapshot.loosePassing
      const snapshot = structuredClone(old.rulesSnapshot.passing)
      const parsed = parseTactic(serializeTactic(old))
      if (!parsed.ok) throw new Error('Legacy fixture must load')
      useTacticStore.getState().replaceDocument(parsed.document)
      useTacticStore.getState().setTool('pass')
      useTacticStore.getState().createAction('blue-water', { x: 9.5, y: 4.7 })
      const current = useTacticStore.getState().document
      expect(current.rulesSnapshot.passing).toEqual(snapshot)
      const pass = current.actions.find((action) => action.type === 'pass')!
      expect(pass.duration).toBeCloseTo(passDuration([{ x: 5.5, y: 4.7 }, { x: 9.5, y: 4.7 }], old.rulesSnapshot))
    }
    useTacticStore.getState().newDocument()
    expect(useTacticStore.getState().document.rulesSnapshot.passing.ballSpeed).toBe(4)
  })

  it('runs to a free ball, creates one exact receipt and allows immediate onward passing', () => {
    load(freeBallDocument())
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().chooseActorForTool('blue-ice')
    useTacticStore.getState().createBallPickup('blue-ice')
    let state = useTacticStore.getState()
    const pickup = state.document.actions.find((action) => action.type === 'move')!
    expect(pickup).toMatchObject({ ballTarget: { sourceActionId: null } })
    const receipt = state.document.actions.find((action) => action.type === 'receive')!
    expect(receipt).toMatchObject({ pickupActionId: pickup.id, actorId: 'blue-ice', startTime: actionEndTime(pickup) })
    expect(projectFrame(state.document, receipt.startTime).ball.carrierId).toBe('blue-ice')
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-ice', { x: 5.5, y: 4.7 }, 'blue-water')
    state = useTacticStore.getState()
    const pass = state.document.actions.find((action) => action.type === 'pass')!
    expect(pass).toMatchObject({ startTime: receipt.startTime, originPickupActionId: pickup.id })
    expect(projectFrame(state.document, actionEndTime(pass)).ball.carrierId).toBe('blue-water')
  })

  it('keeps Ice Q editable but rejects non-catching edits atomically', () => {
    load(freeBallDocument())
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().chooseActorForTool('blue-ice')
    useTacticStore.getState().createBallPickup('blue-ice')
    const q = useTacticStore.getState().document.actions.find((action) => action.type === 'qMove')!
    expect(q).toMatchObject({ ballTarget: { sourceActionId: null } })
    useTacticStore.getState().updateActionPathPoint(q.id, 1, { x: 7, y: 10 })
    const valid = useTacticStore.getState()
    expect(valid.pickupError).toBeNull()
    expect(valid.document.actions.find((action) => action.id === q.id)).toMatchObject({ path: [{ x: 5, y: 10 }, { x: 7, y: 10 }] })
    useTacticStore.getState().updateActionPathPoint(q.id, 1, { x: 5.3, y: 10 })
    expect(useTacticStore.getState().pickupError).toBeTruthy()
    expect(useTacticStore.getState().document).toBe(valid.document)
    expect(useTacticStore.getState().past).toBe(valid.past)
    expect(useTacticStore.getState().future).toBe(valid.future)
    useTacticStore.getState().dismissPickupError()
    expect(useTacticStore.getState().pickupError).toBeNull()
  })

  it('saves only the pickup-origin binding when immediately releasing after an instant Q', () => {
    for (const tool of ['pass', 'loosePass'] as const) {
      const document = freeBallDocument()
      document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 5, y: 10 }
      load(document)
      useTacticStore.setState({ tool: 'qMove' })
      useTacticStore.getState().createBallPickup('blue-fire')
      const pickup = useTacticStore.getState().document.actions.find((action) => action.type === 'qMove')!
      useTacticStore.getState().setTool(tool)
      useTacticStore.getState().createAction('blue-fire', { x: 10, y: 10 })
      const current = useTacticStore.getState().document
      const release = current.actions.find((action) => action.type === tool)!
      expect(release).toMatchObject({ originPickupActionId: pickup.id })
      expect(release).not.toHaveProperty('originKeyframe', expect.anything())
      expect(parseTactic(serializeTactic(current)).ok).toBe(true)
    }
  })

  it('does not extend an out-of-range Q, and undo/import retain generated pickup semantics', () => {
    load(freeBallDocument(5))
    useTacticStore.setState({ tool: 'qMove' })
    const before = useTacticStore.getState().document
    useTacticStore.getState().createBallPickup('blue-ice')
    expect(useTacticStore.getState().document).toBe(before)
    expect(useTacticStore.getState().pickupError).toBeTruthy()
    load(freeBallDocument())
    useTacticStore.setState({ tool: 'move' })
    useTacticStore.getState().createBallPickup('blue-ice')
    const created = useTacticStore.getState().document
    const receipt = created.actions.find((action) => action.type === 'receive')!
    expect(playerActionKeyframes(created, 'blue-ice').some((frame) => frame.actionId === receipt.id)).toBe(true)
    useTacticStore.getState().deleteAction(receipt.id)
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    useTacticStore.getState().undo()
    expect(useTacticStore.getState().document.actions).toEqual(created.actions)
    const parsed = parseTactic(serializeTactic(created))
    if (!parsed.ok) throw new Error('Pickup must round-trip')
    useTacticStore.getState().replaceDocument(parsed.document)
    expect(useTacticStore.getState().document.actions.filter((action) => action.type === 'receive')).toHaveLength(1)
  })

  it('does not normalize the document again while scrubbing distinct forward/backward times', () => {
    load(freeBallDocument())
    useTacticStore.setState({ tool: 'move' })
    useTacticStore.getState().createBallPickup('blue-ice')
    const spy = vi.spyOn(normalization, 'normalizeBallActions')
    try {
      for (let index = 0; index < 90; index += 1) {
        useTacticStore.getState().setCurrentTime(index % 2 ? index / 90 : 2 - index / 90)
        projectFrame(useTacticStore.getState().document, useTacticStore.getState().currentTime)
      }
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})
