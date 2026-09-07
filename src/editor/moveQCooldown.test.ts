import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathLength, resolvedMovePath } from '../domain/geometry/geometry'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { MoveAction } from '../domain/model/types'
import { projectFrame } from '../domain/timeline/projectFrame'
import * as projection from '../domain/timeline/projectFrame'
import * as moveTiming from '../domain/timeline/moveTiming'
import { parseTactic, serializeTactic } from '../persistence/tacticFile'
import { useTacticStore } from './useTacticStore'
import { syncFollowMoveTimings } from './locomotionScheduling'

function setup(advanced = false) {
  const document = createDefaultDocument()
  document.rulesSnapshot.roles.water.q.cooldown = 6
  document.actions = [
    { id: 'q', type: 'qMove', actorId: 'blue-water', startTime: 2, duration: 0,
      path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }] },
    { id: 'wait', type: 'wait', actorId: 'blue-water', startTime: 2, duration: 2 },
    { id: 'run', type: 'move', actorId: 'blue-water', startTime: 4, duration: 1,
      path: [{ x: 8, y: 4.7 }, { x: 9, y: 4.7 }] },
    { id: 'after', type: 'wait', actorId: 'blue-water', startTime: 5, duration: 1 },
  ]
  document.stepMarkers.push({ id: 'run-step', time: 4, name: '跑动', note: '', snapshot: structuredClone(document.initialScene) })
  useTacticStore.setState({
    document, selection: { kind: 'action', id: 'run' }, activeStepId: 'run-step', currentTime: 4,
    currentKeyframe: null, boardMode: 'simulation', tool: 'select', showAdvancedTimeline: advanced,
    isPlaying: false, past: [], future: [], notice: null,
  })
}

function run(): MoveAction {
  const action = useTacticStore.getState().document.actions.find((candidate) => candidate.id === 'run')
  if (action?.type !== 'move') throw new Error('Expected run')
  return action
}

function expectBound(start: number, end: number) {
  expect(run()).toMatchObject({ startTime: start, duration: end - start, timingConstraint: { kind: 'qCooldown', sourceActionId: 'q' } })
  expect(pathLength(resolvedMovePath(run()))).toBeCloseTo((end - start) * useTacticStore.getState().document.rulesSnapshot.field.baseMoveSpeed)
}

describe('run until Q cooldown store edits', () => {
  beforeEach(() => setup())
  afterEach(() => vi.restoreAllMocks())

  it.each([false, true])('binds at base speed with undo/redo, save/load and no new Q (advanced=%s)', (advanced) => {
    setup(advanced)
    const before = structuredClone(useTacticStore.getState().document.actions)
    useTacticStore.getState().setMoveTimingQCooldown('run')
    expectBound(4, 8)
    expect(useTacticStore.getState().past).toHaveLength(1)
    expect(useTacticStore.getState().document.actions.filter((action) => action.type === 'qMove')).toHaveLength(1)
    const saved = parseTactic(serializeTactic(useTacticStore.getState().document))
    expect(saved.ok).toBe(true)
    useTacticStore.getState().undo()
    expect(useTacticStore.getState().document.actions).toEqual(before)
    useTacticStore.getState().redo()
    expectBound(4, 8)
    if (!saved.ok) throw new Error(saved.error)
    useTacticStore.getState().openDocument(saved.document)
    expectBound(4, 8)
    expect(projectFrame(useTacticStore.getState().document, 6).players.find((player) => player.id === 'blue-water')?.position.x).toBeCloseTo(10)
  })

  it.each([false, true])('updates cooldown, source timing, base speed and start edits (advanced=%s)', (advanced) => {
    setup(advanced)
    useTacticStore.getState().setMoveTimingQCooldown('run')
    useTacticStore.getState().updateRoleRule('water', 'qCooldown', 7)
    expectBound(4, 9)
    useTacticStore.getState().updateActionTiming('q', 'startTime', 3)
    expectBound(advanced ? 4 : 5, 10)
    useTacticStore.getState().updateActionTiming('run', 'startTime', 6)
    expectBound(6, 10)
    useTacticStore.getState().updateFieldRule('baseMoveSpeed', 0.5)
    expectBound(6, 10)
    expect(parseTactic(serializeTactic(useTacticStore.getState().document)).ok).toBe(true)
  })

  it.each([false, true])('uses role cooldown and survives temporary reflow after Q duration increases (advanced=%s)', (advanced) => {
    setup(advanced)
    useTacticStore.getState().setMoveTimingQCooldown('run')
    useTacticStore.getState().updateRoleRule('water', 'qDuration', 1.5)
    expectBound(advanced ? 4 : 5.5, 8)
    useTacticStore.getState().updateRoleRule('ice', 'qCooldown', 9)
    useTacticStore.getState().setPlayerRole('blue-water', 'ice')
    const q = useTacticStore.getState().document.actions.find((action) => action.id === 'q')!
    expectBound(advanced ? 4 : Math.max(5.5, 2 + q.duration + 2), 11)
  })

  it('locks curve and endpoint edits and lets users switch to manual or keyframe time', () => {
    useTacticStore.getState().setMoveTimingQCooldown('run')
    const before = useTacticStore.getState().document
    useTacticStore.getState().updateActionTiming('run', 'duration', 9)
    expect(useTacticStore.getState().document).toBe(before)
    expect(useTacticStore.getState().notice).toContain('改为手动')
    useTacticStore.getState().setMovePathMode('run', 'curve')
    useTacticStore.getState().updateMoveCurveControl('run', { x: 9, y: 7 })
    expectBound(4, 8)
    useTacticStore.getState().updateActionPathPoint('run', 1, { x: 10, y: 3 })
    expectBound(4, 8)
    useTacticStore.getState().setMoveTimingFixed('run', true)
    expect(run().timingConstraint).toEqual({ kind: 'fixed' })
    useTacticStore.getState().updateActionTiming('run', 'duration', 3)
    expect(run().duration).toBe(3)
    const document = structuredClone(useTacticStore.getState().document)
    document.actions.push({ id: 'other', type: 'wait', actorId: 'red-fire', startTime: 0, duration: 9 })
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingKeyframe('run', { actionId: 'other', playerId: 'red-fire', edge: 'end' })
    expect(run().timingConstraint?.kind).toBe('keyframe')
  })

  it('preserves an explicitly authored run start gap without requiring a wait action', () => {
    const document = structuredClone(useTacticStore.getState().document)
    document.actions = document.actions.filter((action) => action.id !== 'wait')
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingQCooldown('run')
    expectBound(4, 8)
    useTacticStore.getState().updateRoleRule('water', 'qCooldown', 7)
    expectBound(4, 9)
    useTacticStore.getState().updateActionTiming('q', 'startTime', 3)
    expectBound(4, 10)
  })

  it('finishes cascading invalidation after a restored draft reflows a later binding past its cooldown', () => {
    useTacticStore.getState().setMoveTimingQCooldown('run')
    const incoming = structuredClone(useTacticStore.getState().document)
    const first = incoming.actions.find((action) => action.id === 'run')!
    if (first.type !== 'move') throw new Error('Expected first run')
    first.timingConstraint = { kind: 'qCooldown', sourceActionId: 'removed-source' }
    incoming.actions = [
      { id: 'older-q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0,
        path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }] },
      first,
      { id: 'later-run', type: 'move', actorId: 'blue-water', startTime: 5, duration: 1,
        path: [{ x: 12, y: 4.7 }, { x: 13, y: 4.7 }], timingConstraint: { kind: 'qCooldown', sourceActionId: 'older-q' } },
    ]
    // The later binding is valid before fallback expands the preceding chain.
    const later = incoming.actions[2]
    if (later?.type !== 'move') throw new Error('Expected later run')
    expect(moveTiming.resolveMoveQCooldownTarget(incoming, later)?.readyTime).toBe(6)
    useTacticStore.getState().replaceDocument(incoming)
    const actions = useTacticStore.getState().document.actions
    expect(run()).toMatchObject({ startTime: 4, duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(actions.find((action) => action.id === 'later-run')).toMatchObject({ startTime: 8, duration: 1, timingConstraint: { kind: 'fixed' } })
    expect(parseTactic(serializeTactic(useTacticStore.getState().document)).ok).toBe(true)
    expect(useTacticStore.getState().notice).toContain('Q 冷却来源已失效')
  })

  it('keeps the saved duration when a field-clipped arrow loses its Q source', () => {
    setup(true)
    const document = structuredClone(useTacticStore.getState().document)
    const move = document.actions.find((action) => action.id === 'run')
    if (move?.type !== 'move') throw new Error('Expected run')
    document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 16.5, y: 4.7 }
    const source = document.actions.find((action) => action.id === 'q')
    if (source?.type !== 'qMove') throw new Error('Expected source Q')
    source.path = [{ x: 16.5, y: 4.7 }, { x: 19, y: 4.7 }]
    move.path = [{ x: 19, y: 4.7 }, { x: 20, y: 4.7 }]
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingQCooldown('run')
    expect(run().duration).toBe(4)
    expect(pathLength(run().path)).toBeCloseTo(1)
    useTacticStore.getState().deleteAction('q')
    expect(run()).toMatchObject({ duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(pathLength(run().path)).toBeCloseTo(1)
  })

  it('reattaches the bound run origin after an advanced source Q path or role edit', () => {
    setup(true)
    useTacticStore.getState().setMoveTimingQCooldown('run')
    useTacticStore.getState().updateActionPathPoint('q', 1, { x: 6.5, y: 4.7 })
    expectBound(4, 8)
    expect(run().path[0]).toEqual({ x: 6.5, y: 4.7 })
    expect(run().path.at(-1)).toEqual({ x: 10.5, y: 4.7 })
    useTacticStore.getState().setPlayerRole('blue-water', 'fire')
    expect(run().path[0]?.x).toBeCloseTo(7.8)
    expect(useTacticStore.getState().document.stepMarkers.find((step) => step.id === 'run-step')?.snapshot.players
      .find((player) => player.id === 'blue-water')?.position.x).toBeCloseTo(7.8)
  })

  it('refreshes a saved shot origin when binding or retiming its preceding cooldown run', () => {
    setup(true)
    const document = structuredClone(useTacticStore.getState().document)
    document.actions.push({ id: 'shot', type: 'shoot', actorId: 'blue-water', startTime: 8, duration: 1,
      charge: 'yellow', path: [{ x: 9, y: 4.7 }, { x: 20, y: 7 }] })
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingQCooldown('run')
    const shotOrigin = () => {
      const shot = useTacticStore.getState().document.actions.find((action) => action.id === 'shot')
      if (shot?.type !== 'shoot') throw new Error('Expected shot')
      return shot.path[0]
    }
    expect(shotOrigin()).toEqual({ x: 12, y: 4.7 })
    useTacticStore.getState().updateActionTiming('run', 'startTime', 5)
    expect(shotOrigin()).toEqual({ x: 11, y: 4.7 })
  })

  it('reads only the runner position while syncing Q origins and ignores later locomotion', () => {
    const document = structuredClone(useTacticStore.getState().document)
    const move = document.actions.find((action) => action.id === 'run')
    if (move?.type !== 'move') throw new Error('Expected run')
    move.timingConstraint = { kind: 'qCooldown', sourceActionId: 'q' }
    document.actions.push({ id: 'later-q', type: 'qMove', actorId: 'blue-water', startTime: 10, duration: 0,
      path: [{ x: 12, y: 4.7 }, { x: 14.5, y: 4.7 }] })
    const fullFrame = vi.spyOn(projection, 'projectFrame')
    const position = vi.spyOn(projection, 'projectPlayerPosition')
    syncFollowMoveTimings(document)
    expect(move.path[0]).toEqual({ x: 8, y: 4.7 })
    expect(move.path.at(-1)).toEqual({ x: 12, y: 4.7 })
    expect(fullFrame).not.toHaveBeenCalled()
    expect(position).toHaveBeenCalled()
    expect(position.mock.calls.every(([input, playerId, time]) => (
      !input.actions.some((action) => action.id === move.id) && playerId === move.actorId && time === move.startTime
    ))).toBe(true)
  })

  it.each([false, true])('falls back to the last valid manual duration when Q is deleted, with undo (advanced=%s)', (advanced) => {
    setup(advanced)
    useTacticStore.getState().setMoveTimingQCooldown('run')
    useTacticStore.getState().deleteAction('q')
    expect(run()).toMatchObject({ duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(useTacticStore.getState().notice).toContain('Q 冷却来源已失效')
    expect(parseTactic(serializeTactic(useTacticStore.getState().document)).ok).toBe(true)
    useTacticStore.getState().undo()
    expectBound(4, 8)
    useTacticStore.getState().redo()
    expect(run().timingConstraint).toEqual({ kind: 'fixed' })
  })

  it.each([false, true])('preserves duration when start expires or cooldown becomes too short (advanced=%s)', (advanced) => {
    setup(advanced)
    useTacticStore.getState().setMoveTimingQCooldown('run')
    useTacticStore.getState().updateActionTiming('run', 'startTime', 10)
    expect(run()).toMatchObject({ startTime: 10, duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(useTacticStore.getState().notice).toContain('保留 4.00 秒')
    useTacticStore.getState().undo()
    useTacticStore.getState().updateRoleRule('water', 'qCooldown', 1)
    expect(run()).toMatchObject({ duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(useTacticStore.getState().notice).toContain('保留 4.00 秒')
  })

  it('clears a Q-owning frame while keeping the later run and the fallback notice', () => {
    useTacticStore.getState().setMoveTimingQCooldown('run')
    const openingId = useTacticStore.getState().document.stepMarkers[0]!.id
    useTacticStore.getState().clearStepActions(openingId)
    expect(run()).toMatchObject({ duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(useTacticStore.getState().notice).toContain('Q 冷却来源已失效')
    expect(parseTactic(serializeTactic(useTacticStore.getState().document)).ok).toBe(true)
  })

  it.each(['duration', 'keyframe'])('keeps the fallback notice when an earlier run expands via %s', (edit) => {
    const document = structuredClone(useTacticStore.getState().document)
    document.actions = document.actions.map((action) => action.id === 'wait'
      ? { id: 'wait', type: 'move', actorId: 'blue-water', startTime: 2, duration: 2,
        path: [{ x: 8, y: 4.7 }, { x: 10, y: 4.7 }] }
      : action)
    document.actions.push({ id: 'other', type: 'wait', actorId: 'red-fire', startTime: 0, duration: 10 })
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingQCooldown('run')
    if (edit === 'duration') useTacticStore.getState().updateActionTiming('wait', 'duration', 8)
    else useTacticStore.getState().setMoveTimingKeyframe('wait', { playerId: 'red-fire', actionId: 'other', edge: 'end' })
    expect(run()).toMatchObject({ duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(useTacticStore.getState().notice).toContain('Q 冷却来源已失效')
  })

  it('retains fallback and cooldown-conflict notices together for imported overlapping Qs', () => {
    setup(true)
    useTacticStore.getState().setMoveTimingQCooldown('run')
    const document = structuredClone(useTacticStore.getState().document)
    const q = document.actions.find((action) => action.id === 'q')!
    document.actions.push({ ...q, id: 'legacy-overlap', startTime: 2.5 })
    useTacticStore.setState({ document })
    useTacticStore.getState().updateRoleRule('water', 'qCooldown', 1)
    expect(run()).toMatchObject({ duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(useTacticStore.getState().notice).toContain('Q 冷却来源已失效')
    expect(useTacticStore.getState().notice).toContain('规则已修改')
  })

  it('binds same-time instant Q even when imported after the run', () => {
    const document = structuredClone(useTacticStore.getState().document)
    const q = document.actions.find((action) => action.id === 'q')!
    const move = document.actions.find((action) => action.id === 'run')!
    move.startTime = 2
    document.actions = [move, q]
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingQCooldown('run')
    expectBound(2, 8)
    expect(parseTactic(serializeTactic(useTacticStore.getState().document)).ok).toBe(true)
  })

  it('never switches to another source when the bound Q moves into the future', () => {
    setup(true)
    const document = structuredClone(useTacticStore.getState().document)
    const q = document.actions[0]!
    document.actions.push({ ...q, id: 'older-q', startTime: 0 })
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingQCooldown('run')
    useTacticStore.getState().updateActionTiming('q', 'startTime', 10)
    expect(run()).toMatchObject({ duration: 4, timingConstraint: { kind: 'fixed' } })
    expect(useTacticStore.getState().notice).toContain('来源已失效')
  })

  it.each(['missing', 'expired', 'other', 'future'])('rejects an unavailable Q without history or geometry mutation (%s)', (variant) => {
    const document = structuredClone(useTacticStore.getState().document)
    const q = document.actions[0]!
    if (variant === 'missing') document.actions.shift()
    if (variant === 'expired') document.rulesSnapshot.roles.water.q.cooldown = 2
    if (variant === 'other' && q.type === 'qMove') q.actorId = 'red-water'
    if (variant === 'future') q.startTime = 5
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingQCooldown('run')
    expect(useTacticStore.getState().document).toBe(document)
    expect(useTacticStore.getState().past).toEqual([])
    expect(useTacticStore.getState().notice).toContain('没有尚未结束')
  })

  it('does not recompute timing during playback or scrub', () => {
    useTacticStore.getState().setMoveTimingQCooldown('run')
    const resolve = vi.spyOn(moveTiming, 'resolveMoveQCooldownTarget')
    const find = vi.spyOn(moveTiming, 'findMoveQCooldownTarget')
    for (const time of [4, 6, 8, 7, 2, 4]) useTacticStore.getState().setCurrentTime(time)
    expect(resolve).not.toHaveBeenCalled()
    expect(find).not.toHaveBeenCalled()
  })
})
