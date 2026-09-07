import { afterEach, describe, expect, it, vi } from 'vitest'
import { pathLength, resolvedMovePath } from '../domain/geometry/geometry'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { MoveAction, TacticDocumentV1, TimingTargetReference, WaitAction } from '../domain/model/types'
import * as projection from '../domain/timeline/projectFrame'
import * as ballActions from '../domain/timeline/looseBall'
import { resolveTimingKeyframe } from '../domain/timeline/timingKeyframes'
import { parseTactic, serializeTactic } from '../persistence/tacticFile'
import { useTacticStore } from './useTacticStore'

function setup(advanced = false) {
  const document = createDefaultDocument()
  document.actions = [
    { id: 'q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0,
      path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }] },
    { id: 'run', type: 'move', actorId: 'blue-water', startTime: 0, duration: 1, path: [{ x: 8, y: 4.7 }, { x: 9, y: 4.7 }] },
    { id: 'wait', type: 'wait', actorId: 'red-fire', startTime: 2, duration: 1 },
    { id: 'after', type: 'move', actorId: 'red-fire', startTime: 3, duration: 1, path: [{ x: 16.5, y: 7 }, { x: 15.5, y: 7 }] },
    { id: 'status', type: 'status', targetId: 'blue-fire', status: 'boosted', startTime: 4, duration: 1 },
  ]
  useTacticStore.setState({ document, showAdvancedTimeline: advanced, boardMode: 'simulation', tool: 'select', selection: null,
    currentTime: 0, currentKeyframe: null, isPlaying: false, activeStepId: document.stepMarkers[0]!.id,
    past: [], future: [], notice: null })
  return document
}
function action<T extends MoveAction | WaitAction>(id: string): T {
  return useTacticStore.getState().document.actions.find((candidate) => candidate.id === id) as T
}
const ownBoost: TimingTargetReference = { playerId: 'blue-water', actionId: 'q', event: 'qBoost', edge: 'end' }
const statusEnd: TimingTargetReference = { playerId: 'blue-fire', actionId: 'status', edge: 'end' }

afterEach(() => vi.restoreAllMocks())
describe('wait and actual-speed timing commands', () => {
  it.each([false, true])('waits from the authored start until a moving event, with manual/undo/roundtrip (advanced=%s)', (advanced) => {
    setup(advanced)
    useTacticStore.getState().setWaitTimingKeyframe('wait', statusEnd)
    expect(action<WaitAction>('wait')).toMatchObject({ startTime: 2, duration: 3, timingConstraint: { kind: 'keyframe', reference: statusEnd } })
    if (!advanced) expect(action<MoveAction>('after').startTime).toBe(5)
    useTacticStore.getState().updateActionTiming('status', 'startTime', 5)
    expect(action<WaitAction>('wait')).toMatchObject({ startTime: 2, duration: 4 })
    if (!advanced) expect(action<MoveAction>('after').startTime).toBe(6)
    useTacticStore.getState().updateActionTiming('wait', 'startTime', 3)
    expect(action<WaitAction>('wait')).toMatchObject({ startTime: 3, duration: 3 })
    const past = useTacticStore.getState().past.length
    useTacticStore.getState().updateActionTiming('wait', 'duration', 100)
    expect(useTacticStore.getState().past).toHaveLength(past)
    const saved = parseTactic(serializeTactic(useTacticStore.getState().document))
    expect(saved.ok).toBe(true)
    useTacticStore.getState().setWaitTimingManual('wait')
    expect(action<WaitAction>('wait').timingConstraint).toBeUndefined()
    expect(action<WaitAction>('wait').duration).toBe(3)
    useTacticStore.getState().undo()
    expect(action<WaitAction>('wait').timingConstraint).toBeDefined()
    useTacticStore.getState().redo()
    expect(action<WaitAction>('wait').timingConstraint).toBeUndefined()
  })

  it.each([false, true])('preserves a removed target as manual wait without deleting the action (advanced=%s)', (advanced) => {
    setup(advanced)
    useTacticStore.getState().setWaitTimingKeyframe('wait', statusEnd)
    useTacticStore.getState().deleteAction('status')
    expect(action<WaitAction>('wait')).toMatchObject({ startTime: 2, duration: 3 })
    expect(action<WaitAction>('wait').timingConstraint).toBeUndefined()
    expect(useTacticStore.getState().notice).toContain('手动')
    useTacticStore.getState().undo()
    expect(action<WaitAction>('wait').timingConstraint).toBeDefined()
  })

  it('allows the actor own boost end and computes real full and partial acceleration exactly once', () => {
    setup()
    useTacticStore.getState().setMoveTimingKeyframe('run', ownBoost)
    expect(action<MoveAction>('run').duration).toBe(4.3)
    expect(pathLength(resolvedMovePath(action<MoveAction>('run')))).toBeCloseTo(5.1, 5)
    const document = useTacticStore.getState().document
    expect(projection.projectPlayerPosition(document, 'blue-water', 2.15)?.x).toBeCloseTo(8 + 2.55, 5)
    useTacticStore.getState().updateRoleExtra('water', 'boostDuration', 6)
    expect(action<MoveAction>('run').duration).toBe(6)
    expect(pathLength(resolvedMovePath(action<MoveAction>('run')))).toBeCloseTo(6.8, 5)
    useTacticStore.getState().setMoveTimingFixed('run', true)
    useTacticStore.getState().updateActionTiming('run', 'duration', 2)
    expect(pathLength(resolvedMovePath(action<MoveAction>('run')))).toBeCloseTo(2 + .8 / 3, 5)
  })

  it('rejects a downstream self keyframe and preserves document/history/draft', () => {
    setup()
    const before = useTacticStore.getState().document
    const save = vi.spyOn(Storage.prototype, 'setItem')
    useTacticStore.getState().setWaitTimingKeyframe('wait', { playerId: 'red-fire', actionId: 'after', edge: 'end' })
    expect(useTacticStore.getState().document).toBe(before)
    expect(useTacticStore.getState().past).toHaveLength(0)
    expect(useTacticStore.getState().notice).toContain('循环')
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects a run binding to its own later freeze outcome before writing history', () => {
    const document = setup(true)
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 4, y: 7 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 8, y: 7 }
    document.actions = [
      { id: 'early-run', type: 'move', actorId: 'red-fire', startTime: 0, duration: 1,
        path: [{ x: 8, y: 7 }, { x: 7, y: 7 }] },
      { id: 'later-ice-q', type: 'qMove', actorId: 'blue-ice', startTime: 2, duration: 1,
        path: [{ x: 4, y: 7 }, { x: 7, y: 7 }] },
    ]
    const save = vi.spyOn(Storage.prototype, 'setItem')
    useTacticStore.getState().setMoveTimingKeyframe('early-run', {
      playerId: 'red-fire', actionId: 'later-ice-q', event: 'freeze', edge: 'end',
    })
    expect(useTacticStore.getState().document).toBe(document)
    expect(useTacticStore.getState().past).toHaveLength(0)
    expect(useTacticStore.getState().notice).toContain('循环时间依赖')
    expect(save).not.toHaveBeenCalled()
  })

  it('falls back to the last valid time when the own role no longer has the referenced boost', () => {
    setup(true)
    useTacticStore.getState().setMoveTimingKeyframe('run', ownBoost)
    useTacticStore.getState().setPlayerRole('blue-water', 'fire')
    expect(action<MoveAction>('run')).toMatchObject({ duration: 4.3, timingConstraint: { kind: 'fixed' } })
    expect(useTacticStore.getState().notice).toContain('手动')
    expect(parseTactic(serializeTactic(useTacticStore.getState().document)).ok).toBe(true)
  })

  it('keeps the fallback notice when editing a reception-bound pass invalidates a wait target', () => {
    const document = setup(true)
    document.actions = [
      { id: 'incoming', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice', startTime: 0, duration: 1,
        path: [{ x: 5.5, y: 4.7 }, { x: 5.5, y: 9.3 }] },
      { id: 'outgoing', type: 'pass', actorId: 'blue-ice', targetPlayerId: 'blue-water', startTime: 2, duration: 1,
        path: [{ x: 5.5, y: 9.3 }, { x: 5.5, y: 4.7 }] },
      { id: 'wait', type: 'wait', actorId: 'red-fire', startTime: 6, duration: 1 },
    ]
    ballActions.normalizeBallActions(document)
    const incoming = document.actions.find((candidate) => candidate.id === 'incoming')!
    const outgoing = document.actions.find((candidate) => candidate.id === 'outgoing')!
    if (outgoing.type !== 'pass') throw new Error('pass fixture')
    outgoing.originReception = { sourceActionId: incoming.id, offset: outgoing.startTime - incoming.startTime - incoming.duration }
    useTacticStore.getState().setWaitTimingKeyframe('wait', {
      playerId: 'blue-water', actionId: 'outgoing', event: 'receiveBoost', edge: 'end',
    })
    expect(action<WaitAction>('wait').timingConstraint).toBeDefined()
    const previousDuration = action<WaitAction>('wait').duration
    useTacticStore.getState().updateActionTiming('outgoing', 'startTime', incoming.startTime + incoming.duration)
    expect(action<WaitAction>('wait').timingConstraint).toBeUndefined()
    expect(action<WaitAction>('wait').duration).toBe(previousDuration)
    expect(useTacticStore.getState().notice).toContain('手动')
  })

  it('normalizes legacy manual timed geometry on import/library open without editing the supplied object', () => {
    const old = setup(true)
    const move = old.actions.find((candidate) => candidate.id === 'run') as MoveAction
    move.duration = 4.3
    move.path[1]!.x = 12.3
    move.timingConstraint = { kind: 'fixed' }
    const snapshot = structuredClone(old)
    useTacticStore.getState().openDocument(old)
    expect(old).toEqual(snapshot)
    expect(pathLength(resolvedMovePath(action<MoveAction>('run')))).toBeCloseTo(5.1, 5)
    useTacticStore.getState().replaceDocument(old)
    expect(pathLength(resolvedMovePath(action<MoveAction>('run')))).toBeCloseTo(5.1, 5)
  })

  it.each(['basic', 'simulation'] as const)('finishes receipt-dependent geometry normalization when importing from %s mode', (boardMode) => {
    setup(false)
    useTacticStore.setState({ boardMode })
    const imported = createDefaultDocument()
    imported.actions = [
      { id: 'ice-run', type: 'move', actorId: 'blue-ice', startTime: 0, duration: 1.5,
        path: [{ x: 5.5, y: 9.3 }, { x: 7, y: 9.3 }], timingConstraint: { kind: 'fixed' } },
      { id: 'incoming', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice', startTime: 0, duration: 1,
        path: [{ x: 5.5, y: 4.7 }, { x: 6.5, y: 9.3 }], flightOutcome: 'received' },
      { id: 'receive', type: 'receive', actorId: 'blue-ice', startTime: 1, duration: 0, sourceActionId: 'incoming' },
      { id: 'authored-gap', type: 'wait', actorId: 'blue-ice', startTime: 5, duration: 1 },
    ]
    const original = structuredClone(imported)
    useTacticStore.getState().replaceDocument(imported)
    const normalized = useTacticStore.getState().document
    const incoming = normalized.actions.find((candidate) => candidate.id === 'incoming')!
    const boost = normalized.rulesSnapshot.roles.ice.receiveBoost!
    const expected = 1.5 + (1.5 - incoming.startTime - incoming.duration) * boost.netSeparationGain / boost.duration
    expect(pathLength(action<MoveAction>('ice-run').path)).toBeCloseTo(expected, 5)
    expect(useTacticStore.getState().boardMode).toBe('simulation')
    expect(action<WaitAction>('authored-gap').startTime).toBe(5)
    expect(imported).toEqual(original)
  })

  it('does not normalize timing or solve flights on labels/notes or 90 time-only scrubs', () => {
    setup(true)
    useTacticStore.getState().setMoveTimingKeyframe('run', ownBoost)
    const geometry = vi.spyOn(projection, 'resolveTimedMoveGeometry')
    const normalize = vi.spyOn(ballActions, 'normalizeBallActions')
    useTacticStore.getState().updateMeta('title', '重命名')
    useTacticStore.getState().updateStepNote(useTacticStore.getState().document.stepMarkers[0]!.id, '测试说明')
    for (let index = 0; index < 90; index += 1) useTacticStore.getState().setCurrentTime((index % 30) / 5)
    expect(geometry).not.toHaveBeenCalled()
    expect(normalize).not.toHaveBeenCalled()
  })

  it('rejects nonconverging timing/physical edits atomically instead of saving partial state', () => {
    setup(true)
    useTacticStore.getState().setMoveTimingKeyframe('run', ownBoost)
    const before = useTacticStore.getState()
    let calls = 0
    vi.spyOn(projection, 'resolveTimedMoveGeometry').mockImplementation((_document: TacticDocumentV1, move: MoveAction) => {
      calls += 1
      return { path: [{ ...move.path[0]! }, { x: calls % 2 ? 9 : 10, y: 4.7 }] }
    })
    useTacticStore.getState().updateRoleExtra('water', 'boostGain', .9)
    expect(useTacticStore.getState().document).toBe(before.document)
    expect(useTacticStore.getState().past).toHaveLength(before.past.length)
    expect(useTacticStore.getState().notice).toContain('未能稳定')
  })

  it('preserves selection and the failure notice when wait creation cannot settle timed geometry', () => {
    setup(true)
    useTacticStore.getState().setMoveTimingKeyframe('run', ownBoost)
    useTacticStore.setState({ tool: 'wait', selection: { kind: 'player', id: 'red-fire' }, currentTime: 2 })
    const before = useTacticStore.getState()
    const save = vi.spyOn(Storage.prototype, 'setItem')
    let calls = 0
    vi.spyOn(projection, 'resolveTimedMoveGeometry').mockImplementation((_document: TacticDocumentV1, move: MoveAction) => {
      calls += 1
      return { path: [{ ...move.path[0]! }, { x: calls % 2 ? 9 : 10, y: 4.7 }] }
    })
    useTacticStore.getState().createWait('red-fire')
    const after = useTacticStore.getState()
    expect(after.document).toBe(before.document)
    expect(after.past).toHaveLength(before.past.length)
    expect(after.selection).toEqual(before.selection)
    expect(after.currentTime).toBe(before.currentTime)
    expect(after.activeStepId).toBe(before.activeStepId)
    expect(after.tool).toBe(before.tool)
    expect(after.notice).toContain('未能稳定')
    expect(save).not.toHaveBeenCalled()
  })

  it('retains ownerless legacy waits unchanged', () => {
    const document = setup()
    document.actions.push({ id: 'legacy-wait', type: 'wait', startTime: 3, duration: 2 })
    useTacticStore.getState().setWaitTimingKeyframe('legacy-wait', ownBoost)
    expect(action<WaitAction>('legacy-wait')).toEqual({ id: 'legacy-wait', type: 'wait', startTime: 3, duration: 2 })
    expect(resolveTimingKeyframe(document, ownBoost)?.time).toBe(4.3)
  })
})
