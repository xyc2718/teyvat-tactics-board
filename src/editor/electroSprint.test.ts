import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { pathLength, resolvedMovePath } from '../domain/geometry/geometry'
import type { MoveAction } from '../domain/model/types'
import { actionEndTime } from '../domain/timeline/durations'
import { electroSprintState } from '../domain/timeline/electroSprint'
import * as normalization from '../domain/timeline/looseBall'
import { projectFrame } from '../domain/timeline/projectFrame'
import { parseTactic, serializeTactic } from '../persistence/tacticFile'
import { useTacticStore } from './useTacticStore'

function setup() {
  const document = createDefaultDocument()
  const actor = document.initialScene.players.find((player) => player.id === 'blue-fire')!
  actor.role = 'electro'; actor.position = { x: 5, y: 7 }
  document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 5, y: 3 }
  document.initialScene.ball.position = { x: 5, y: 3 }
  document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
  useTacticStore.setState({ document, selection: { kind: 'player', id: actor.id }, tool: 'select',
    boardMode: 'simulation', activeStepId: document.stepMarkers[0]!.id, currentTime: 0, currentKeyframe: null,
    past: [], future: [], showAdvancedTimeline: false, isPlaying: false, notice: null, pickupError: null })
  return document
}
function sprint() {
  useTacticStore.getState().setTool('sprint')
  useTacticStore.getState().createAction('blue-fire', { x: 13, y: 7 })
  const action = useTacticStore.getState().document.actions.find((item) => item.type === 'move' && item.sprint)
  if (action?.type !== 'move') throw new Error(`Sprint missing: ${useTacticStore.getState().notice}`)
  return action
}

describe('Electro E editor transactions', () => {
  beforeEach(setup)
  it('creates step 1, caps energy, keeps its own speed and schedules the next E after cooldown', () => {
    const first = sprint()
    expect(first.duration).toBeCloseTo(3.8)
    expect(pathLength(resolvedMovePath(first))).toBeCloseTo(8)
    expect(useTacticStore.getState().document.stepMarkers).toHaveLength(2)
    expect(projectFrame(useTacticStore.getState().document, 1.9).players.find((p) => p.id === 'blue-fire')!.position.x).toBeCloseTo(9)
    useTacticStore.getState().setTool('sprint')
    expect(useTacticStore.getState().currentTime).toBeCloseTo(7.8)
    useTacticStore.getState().createAction('blue-fire', { x: 5, y: 7 })
    const second = useTacticStore.getState().document.actions.filter((a): a is MoveAction => a.type === 'move' && !!a.sprint)[1]!
    expect(second.startTime).toBeCloseTo(7.8)
    expect(pathLength(second.path)).toBeCloseTo(8 * 4 / 15)
  })
  it('changes distance for fixed time, rejects over-budget edits atomically and keeps curve handles', () => {
    const first = sprint()
    useTacticStore.getState().setMovePathMode(first.id, 'curve')
    let action = useTacticStore.getState().document.actions.find((a) => a.id === first.id) as MoveAction
    expect(action.curveControl).toBeDefined()
    useTacticStore.getState().updateActionTiming(first.id, 'duration', 1.9)
    action = useTacticStore.getState().document.actions.find((a) => a.id === first.id) as MoveAction
    expect(action.duration).toBeCloseTo(1.9)
    expect(pathLength(resolvedMovePath(action))).toBeCloseTo(4, 3)
    const before = useTacticStore.getState()
    before.updateActionTiming(first.id, 'duration', 5)
    expect(useTacticStore.getState().document).toBe(before.document)
    expect(useTacticStore.getState().past).toBe(before.past)
    expect(useTacticStore.getState().notice).toContain('能量')
  })
  it('manual stop and Q during E preserve unspent energy and end the sprint', () => {
    const first = sprint()
    useTacticStore.getState().stopSprint(first.id, 1.9)
    let doc = useTacticStore.getState().document
    expect(electroSprintState(doc, 'blue-fire', 1.9)).toMatchObject({ active: false, cooldown: 4 })
    expect(electroSprintState(doc, 'blue-fire', 1.9).energy).toBeCloseTo(.5)
    useTacticStore.getState().undo()
    useTacticStore.setState({ currentTime: 1.9, selection: { kind: 'player', id: 'blue-fire' } })
    useTacticStore.getState().setTool('qMove')
    expect(useTacticStore.getState().currentTime).toBeCloseTo(1.9)
    useTacticStore.getState().createAction('blue-fire', { x: 15, y: 7 })
    doc = useTacticStore.getState().document
    const q = doc.actions.find((a) => a.type === 'qMove')!
    expect(q.startTime).toBeCloseTo(1.9)
    expect(q.path[0]!.x).toBeCloseTo(9)
    expect(actionEndTime(doc.actions.find((a) => a.id === first.id)!)).toBeCloseTo(1.9)
    expect(electroSprintState(doc, 'blue-fire', 1.9).cooldown).toBeCloseTo(4)
  })
  it('solves a moving catch, creates independent tail, keeps deleted tail deleted, and undo restores unsplit E', () => {
    const first = sprint()
    const beforePass = structuredClone(useTacticStore.getState().document)
    useTacticStore.getState().setCurrentTime(0)
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-water', { x: 5, y: 7 }, 'blue-fire')
    let doc = useTacticStore.getState().document
    const pass = doc.actions.find((a) => a.type === 'pass')!
    expect(pass.type === 'pass' && pass.flightOutcome).toBe('received')
    const catchTime = actionEndTime(pass)
    const prefix = doc.actions.find((a) => a.id === first.id) as MoveAction
    const tail = doc.actions.find((a): a is MoveAction => a.type === 'move' && !a.sprint)!
    expect(tail).toBeDefined()
    expect(actionEndTime(prefix)).toBeCloseTo(catchTime, 7)
    expect(tail.startTime).toBeCloseTo(catchTime, 7)
    expect(tail.path[0]!.x).toBeCloseTo(prefix.path.at(-1)!.x, 7)
    expect(projectFrame(doc, catchTime).ball.carrierId).toBe('blue-fire')
    expect(projectFrame(doc, catchTime + .2).ball.position).toEqual(projectFrame(doc, catchTime + .2).players.find((p) => p.id === 'blue-fire')!.position)
    expect(parseTactic(serializeTactic(doc)).ok).toBe(true)
    useTacticStore.getState().undo()
    expect(useTacticStore.getState().document.actions).toEqual(beforePass.actions)
    useTacticStore.getState().redo()
    useTacticStore.getState().deleteAction(tail.id)
    useTacticStore.getState().updateMeta('notes', 'tail remains deleted')
    useTacticStore.getState().updatePassingRule('ballSpeed', 10 / 3)
    doc = useTacticStore.getState().document
    expect(doc.actions.some((a) => a.type === 'move' && !a.sprint)).toBe(false)
    expect((doc.actions.find((a) => a.id === first.id) as MoveAction).duration).toBeCloseTo(catchTime, 6)
    const spy = vi.spyOn(normalization, 'normalizeBallActions')
    for (let i = 0; i < 90; i++) useTacticStore.getState().setCurrentTime(i / 20)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('reflows an existing Q after the independent ordinary tail created by reception', () => {
    sprint()
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-fire', { x: 16, y: 7 })
    useTacticStore.getState().setCurrentTime(0)
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-water', { x: 5, y: 7 }, 'blue-fire')
    const doc = useTacticStore.getState().document
    const tail = doc.actions.find((a): a is MoveAction => a.type === 'move' && !a.sprint)!
    const q = doc.actions.find((a) => a.type === 'qMove')!
    expect(tail).toBeDefined()
    expect(q.startTime).toBeCloseTo(actionEndTime(tail), 7)
    expect(q.path[0]).toEqual(tail.path.at(-1))
    expect(parseTactic(serializeTactic(doc)).ok).toBe(true)
  })
  it('can release an onward pass exactly at the E-interrupting reception frame', () => {
    sprint()
    useTacticStore.getState().setCurrentTime(0)
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-water', { x: 5, y: 7 }, 'blue-fire')
    const firstPass = useTacticStore.getState().document.actions.find((a) => a.type === 'pass')!
    const catchTime = actionEndTime(firstPass)
    useTacticStore.getState().setCurrentTime(catchTime)
    useTacticStore.getState().setTool('pass')
    const receiver = projectFrame(useTacticStore.getState().document, catchTime).players.find((p) => p.id === 'blue-fire')!
    useTacticStore.getState().createAction('blue-fire', { x: 5, y: 3 }, 'blue-water')
    const doc = useTacticStore.getState().document
    const onward = doc.actions.find((a) => a.type === 'pass' && a.id !== firstPass.id)!
    expect(onward).toBeDefined()
    if (onward.type !== 'pass') throw new Error('Expected onward pass')
    expect(onward.startTime).toBeCloseTo(catchTime, 7)
    expect(onward.path[0]).toEqual(receiver.position)
    expect(projectFrame(doc, catchTime + .01).ball.carrierId).toBeNull()
    expect(parseTactic(serializeTactic(doc)).ok).toBe(true)
  })
  it('refuses a carrying sprint without fabricating movement', () => {
    useTacticStore.getState().givePossession('blue-fire')
    useTacticStore.getState().setTool('sprint')
    useTacticStore.getState().createAction('blue-fire', { x: 10, y: 7 })
    expect(useTacticStore.getState().document.actions.filter((a) => a.type === 'move')).toHaveLength(0)
  })
  it('keeps the original curved route up to a manual stop, rather than shrinking its shape', () => {
    const first = sprint()
    useTacticStore.getState().setMovePathMode(first.id, 'curve')
    const before = useTacticStore.getState().document
    const positionAt = (document: typeof before, time: number) => projectFrame(document, time).players.find((player) => player.id === 'blue-fire')!.position
    const stop = positionAt(before, 1)
    const midway = positionAt(before, .5)
    useTacticStore.getState().stopSprint(first.id, 1)
    const after = useTacticStore.getState().document
    expect(positionAt(after, 1).x).toBeCloseTo(stop.x, 7)
    expect(positionAt(after, 1).y).toBeCloseTo(stop.y, 7)
    expect(positionAt(after, .5).x).toBeCloseTo(midway.x, 7)
    expect(positionAt(after, .5).y).toBeCloseTo(midway.y, 7)
    expect(parseTactic(serializeTactic(after)).ok).toBe(true)
  })
  it('starts before a future freeze and stops on impact, while waiting out a currently active freeze', () => {
    const document = structuredClone(useTacticStore.getState().document)
    document.actions.push({ id: 'future-freeze', type: 'status', status: 'frozen', targetId: 'blue-fire', startTime: 1, duration: 2 })
    useTacticStore.setState({ document })
    const first = sprint()
    expect(first.startTime).toBe(0)
    expect(first.duration).toBeCloseTo(1)
    expect(pathLength(first.path)).toBeCloseTo(8 / 3.8)
    expect(projectFrame(useTacticStore.getState().document, 4).sprints?.['blue-fire']?.active).toBe(false)
    const next = setup()
    next.actions.push({ id: 'active-freeze', type: 'status', status: 'frozen', targetId: 'blue-fire', startTime: 0, duration: 2 })
    const afterThaw = sprint()
    expect(afterThaw.startTime).toBe(2)
  })
  it.each([false, true])('round trips an early curved reception and its long sampled ordinary tail (long ID=%s)', (longId) => {
    const document = structuredClone(useTacticStore.getState().document)
    document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 5, y: 6.5 }
    document.initialScene.ball.position = { x: 5, y: 6.5 }
    document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
    useTacticStore.setState({ document })
    const first = sprint()
    const sprintId = longId ? 'e'.repeat(120) : first.id
    if (longId) {
      const renamed = structuredClone(useTacticStore.getState().document)
      renamed.actions.find((action) => action.id === first.id)!.id = sprintId
      renamed.actions.push({ id: `${sprintId.slice(0, 120 - '-after-receive'.length)}-after-receive`, type: 'wait', actorId: 'red-water', startTime: 0, duration: 1 })
      useTacticStore.setState({ document: renamed, selection: null })
    }
    useTacticStore.getState().setMovePathMode(sprintId, 'curve')
    useTacticStore.getState().setCurrentTime(0)
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-water', { x: 5, y: 7 }, 'blue-fire')
    const after = useTacticStore.getState().document
    const tail = after.actions.find((action): action is MoveAction => action.type === 'move' && !action.sprint)!
    expect(tail.path.length).toBeGreaterThan(20)
    expect(tail.id.length).toBeLessThanOrEqual(120)
    if (longId) expect(tail.id.endsWith('-1')).toBe(true)
    expect(parseTactic(serializeTactic(after)).ok).toBe(true)
  })
  it('falls back to the last valid E duration when an independent target moves beyond its energy budget', () => {
    const first = sprint()
    const document = structuredClone(useTacticStore.getState().document)
    document.actions.push({ id: 'independent-wait', type: 'wait', actorId: 'red-water', startTime: 0, duration: 2 })
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingKeyframe(first.id, { playerId: 'red-water', actionId: 'independent-wait', edge: 'end' })
    expect((useTacticStore.getState().document.actions.find((a) => a.id === first.id) as MoveAction).duration).toBeCloseTo(2)
    useTacticStore.getState().updateActionTiming('independent-wait', 'duration', 5)
    const after = useTacticStore.getState().document
    expect(after.actions.find((a) => a.id === 'independent-wait')!.duration).toBe(5)
    expect((after.actions.find((a) => a.id === first.id) as MoveAction).timingConstraint).toEqual({ kind: 'fixed' })
    expect(after.actions.find((a) => a.id === first.id)!.duration).toBeCloseTo(2)
    expect(useTacticStore.getState().notice).toContain('能量')
    expect(useTacticStore.getState().notice).toContain('手动时间')
  })
  it('preserves a legal cooldown gap when an earlier sprint is shortened', () => {
    const first = sprint()
    useTacticStore.getState().setTool('sprint')
    useTacticStore.getState().createAction('blue-fire', { x: 5, y: 7 })
    const second = useTacticStore.getState().document.actions.filter((action) => action.type === 'move' && action.sprint)[1]!
    useTacticStore.getState().updateActionTiming(first.id, 'duration', 1.9)
    const after = useTacticStore.getState().document.actions.find((action) => action.id === second.id)!
    expect(after.startTime).toBeCloseTo(5.9)
    expect(after.duration).toBeGreaterThan(0)
  })
  it('clips a detached timing fallback only when upstream energy no longer supports the old duration', () => {
    const first = sprint()
    useTacticStore.getState().updateActionTiming(first.id, 'duration', 1.9)
    const document = structuredClone(useTacticStore.getState().document)
    document.actions.push(
      { id: 'later-e', type: 'move', sprint: true, actorId: 'blue-fire', startTime: 8, duration: 2,
        path: [{ x: 9, y: 7 }, { x: 13.210526315789474, y: 7 }] },
      { id: 'end-target', type: 'wait', actorId: 'red-water', startTime: 0, duration: 10 },
    )
    useTacticStore.setState({ document })
    useTacticStore.getState().setMoveTimingKeyframe('later-e', { playerId: 'red-water', actionId: 'end-target', edge: 'end' })
    useTacticStore.getState().updateActionTiming(first.id, 'duration', 3.8)
    const after = useTacticStore.getState().document
    const later = after.actions.find((action) => action.id === 'later-e') as MoveAction
    expect(later.startTime).toBe(8)
    expect(later.timingConstraint).toEqual({ kind: 'fixed' })
    expect(later.duration).toBeCloseTo((8 - 3.8) / 15 * 3.8, 6)
    expect(useTacticStore.getState().notice).toContain('能量')
    expect(parseTactic(serializeTactic(after)).ok).toBe(true)
  })
  it('allows an onward pass at the exact E reception keyframe', () => {
    sprint()
    useTacticStore.getState().setCurrentTime(0)
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-water', { x: 5, y: 7 }, 'blue-fire')
    const incoming = useTacticStore.getState().document.actions.find((a) => a.type === 'pass')!
    const catchTime = actionEndTime(incoming)
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-fire', { x: 5, y: 3 }, 'blue-water')
    const document = useTacticStore.getState().document
    const passes = document.actions.filter((a) => a.type === 'pass')
    expect(passes).toHaveLength(2)
    expect(passes[1]!.startTime).toBeCloseTo(catchTime, 8)
    expect(projectFrame(document, catchTime + .01).ball.carrierId).toBeNull()
    expect(parseTactic(serializeTactic(document)).ok).toBe(true)
  })
})
