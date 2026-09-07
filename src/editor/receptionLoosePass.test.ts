import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { TacticDocumentV1 } from '../domain/model/types'
import { actionEndTime } from '../domain/timeline/durations'
import * as ballActions from '../domain/timeline/looseBall'
import { projectFrame } from '../domain/timeline/projectFrame'
import { parseTactic, serializeTactic } from '../persistence/tacticFile'
import { useTacticStore } from './useTacticStore'

function receivingDocument() {
  const document = createDefaultDocument()
  for (const player of document.initialScene.players) {
    player.hasBall = player.id === 'blue-fire'
    if (player.id === 'blue-fire') player.position = { x: 3, y: 7 }
    if (player.id === 'blue-ice') player.position = { x: 6, y: 7 }
  }
  document.initialScene.ball = { carrierId: 'blue-fire', isFree: false, position: { x: 3, y: 7 } }
  document.actions = [{ id: 'incoming', type: 'pass', actorId: 'blue-fire', targetPlayerId: 'blue-ice',
    startTime: 1, duration: 1, path: [{ x: 3, y: 7 }, { x: 6, y: 7 }] }]
  ballActions.normalizeBallActions(document)
  return document
}

function load(document: TacticDocumentV1, time = 0) {
  useTacticStore.setState({ document, currentTime: time, currentKeyframe: null, selection: null,
    tool: 'select', boardMode: 'simulation', activeStepId: 'action-step', past: [], future: [],
    showAdvancedTimeline: false, isPlaying: false, notice: null, pickupError: null })
}

beforeEach(() => load(receivingDocument()))

describe('release after ordinary reception', () => {
  it('advances the selected future receiver to the exact catch, without editing history', () => {
    const before = useTacticStore.getState()
    const catchTime = actionEndTime(before.document.actions.find((action) => action.id === 'incoming')!)
    before.select({ kind: 'player', id: 'blue-ice' })
    before.setTool('loosePass')
    const state = useTacticStore.getState()
    expect(state.currentTime).toBe(catchTime)
    expect(state.selection).toEqual({ kind: 'player', id: 'blue-ice' })
    expect(state.document).toBe(before.document)
    expect(state.past).toEqual([])
    expect(projectFrame(state.document, state.currentTime).ball.carrierId).toBe('blue-ice')
  })

  it('supports tool-first switching from the current carrier to a future receiver', () => {
    useTacticStore.getState().setTool('loosePass')
    expect(useTacticStore.getState().selection?.id).toBe('blue-fire')
    useTacticStore.getState().chooseActorForTool('blue-ice')
    const state = useTacticStore.getState()
    expect(state.selection?.id).toBe('blue-ice')
    expect(state.currentTime).toBe(actionEndTime(state.document.actions.find((action) => action.id === 'incoming')!))
  })

  it.each(['pass', 'loosePass'] as const)('binds an immediate %s after the catch and preserves export/undo', (tool) => {
    const initial = useTacticStore.getState().document
    const catchTime = actionEndTime(initial.actions.find((action) => action.id === 'incoming')!)
    useTacticStore.setState({ currentTime: catchTime, selection: { kind: 'player', id: 'blue-ice' } })
    useTacticStore.getState().setTool(tool)
    useTacticStore.getState().createAction('blue-ice', { x: 12, y: 7 })
    const state = useTacticStore.getState()
    const release = state.document.actions.find((action) => action.type === tool && action.id !== 'incoming')!
    expect(release).toMatchObject({ startTime: catchTime, originReception: { sourceActionId: 'incoming', offset: 0 } })
    expect(projectFrame(state.document, release.startTime + 0.1).ball.carrierId).toBeNull()
    expect(projectFrame(state.document, actionEndTime(release)).ball.carrierId).toBeNull()
    expect(state.document.actions.filter((action) => action.type === 'receive')).toHaveLength(1)
    const parsed = parseTactic(serializeTactic(state.document))
    expect(parsed.ok).toBe(true)
    useTacticStore.getState().undo()
    expect(useTacticStore.getState().document.actions).toEqual(initial.actions)
    useTacticStore.getState().redo()
    expect(useTacticStore.getState().document.actions).toEqual(state.document.actions)
  })

  it('retains a later running moment and releases from the projected position', () => {
    const document = receivingDocument()
    const caught = actionEndTime(document.actions.find((action) => action.id === 'incoming')!)
    document.actions.push({ id: 'run', type: 'move', actorId: 'blue-ice', startTime: caught, duration: 2,
      path: [{ x: 6, y: 7 }, { x: 8, y: 7 }] })
    ballActions.normalizeBallActions(document)
    const selectedTime = 2.5
    load(document, selectedTime)
    useTacticStore.getState().select({ kind: 'player', id: 'blue-ice' })
    const origin = projectFrame(document, selectedTime).players.find((player) => player.id === 'blue-ice')!.position
    useTacticStore.getState().setTool('loosePass')
    expect(useTacticStore.getState().currentTime).toBe(selectedTime)
    useTacticStore.getState().createAction('blue-ice', { x: 15, y: 10 })
    const release = useTacticStore.getState().document.actions.find((action) => action.type === 'loosePass')!
    expect(release.startTime).toBe(selectedTime)
    expect(release.path[0]).toEqual(origin)
    expect(release.originReception?.offset).toBeCloseTo(selectedTime - caught)
  })

  it('does not substitute another carrier or write an invalid release', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'red-ice' })
    useTacticStore.getState().setTool('loosePass')
    const before = useTacticStore.getState()
    expect(before.selection?.id).toBe('red-ice')
    expect(before.notice).toContain('接到球')
    before.createAction('red-ice', { x: 10, y: 7 })
    expect(useTacticStore.getState().document).toBe(before.document)
    expect(useTacticStore.getState().past).toBe(before.past)
    expect(useTacticStore.getState().future).toBe(before.future)
  })

  it('keeps actor intent on rewind and rejects release before reception', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-ice' })
    useTacticStore.getState().setTool('loosePass')
    useTacticStore.getState().setCurrentTime(0)
    const before = useTacticStore.getState()
    expect(before.selection?.id).toBe('blue-ice')
    before.createAction(null, { x: 12, y: 7 })
    expect(useTacticStore.getState().document).toBe(before.document)
    expect(useTacticStore.getState().notice).toContain('接到球')
  })

  it('cannot release twice, and timing edits cannot precede possession', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-ice' })
    useTacticStore.getState().setTool('loosePass')
    useTacticStore.getState().createAction('blue-ice', { x: 12, y: 7 })
    const before = useTacticStore.getState()
    const release = before.document.actions.find((action) => action.type === 'loosePass')!
    before.setTool('loosePass')
    useTacticStore.getState().createAction('blue-ice', { x: 12, y: 7 })
    expect(useTacticStore.getState().document).toBe(before.document)
    useTacticStore.getState().updateActionTiming(release.id, 'startTime', 0)
    expect(useTacticStore.getState().document).toBe(before.document)
    useTacticStore.getState().updateActionTiming(release.id, 'startTime', 3)
    const updated = useTacticStore.getState().document.actions.find((action) => action.id === release.id)!
    expect(updated.startTime).toBe(3)
    expect(projectFrame(useTacticStore.getState().document, 3.1).ball.carrierId).toBeNull()
  })

  it('does not re-normalize or change document/history while navigating', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-ice' })
    useTacticStore.getState().setTool('loosePass')
    const before = useTacticStore.getState()
    const spy = vi.spyOn(ballActions, 'normalizeBallActions')
    try {
      for (let index = 0; index < 90; index += 1) before.setCurrentTime(index % 2 ? index / 30 : 3 - index / 30)
      expect(spy).not.toHaveBeenCalled()
      expect(useTacticStore.getState().document).toBe(before.document)
      expect(useTacticStore.getState().past).toBe(before.past)
    } finally { spy.mockRestore() }
  })
})
