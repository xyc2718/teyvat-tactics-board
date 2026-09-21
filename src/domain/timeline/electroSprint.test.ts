import { describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { MoveAction, PassAction, TacticDocumentV1 } from '../model/types'
import { distance, pathLength, resolvedMovePath } from '../geometry/geometry'
import { electroSprintState, normalizeSprintActions, sprintSpeed, syncSprintPath } from './electroSprint'
import { createPlayerPositionReader, documentFreezeWindows, eZoneSlowSegmentsForMove, projectFrame, projectedMovePath, statusSlowSegmentsForMove } from './projectFrame'
import { normalizeBallActions } from './looseBall'
import { documentTimingKeyframes } from './timingKeyframes'
import { timelineJointTimes } from './keyframes'
import { receiveMoveBoosts } from './movementEffects'
import * as passReception from './passReception'

function setup(): TacticDocumentV1 {
  const document = createDefaultDocument()
  document.initialScene.players.find((player) => player.id === 'blue-ice')!.role = 'electro'
  document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 5, y: 9 }
  return document
}

function sprint(document: TacticDocumentV1, duration = 3.8, startTime = 0): MoveAction {
  const action: MoveAction = { id: `sprint-${startTime}`, type: 'move', sprint: true, actorId: 'blue-ice', startTime, duration,
    path: [{ x: 5, y: 9 }, { x: 5 + duration * sprintSpeed(document.rulesSnapshot.roles.electro), y: 9 }] }
  document.actions.push(action)
  return action
}

describe('Electro E energy and physical movement', () => {
  it('burns uniformly without regeneration during E and regenerates during its cooldown', () => {
    const document = setup()
    sprint(document)
    expect(electroSprintState(document, 'blue-ice', 0).energy).toBe(1)
    expect(electroSprintState(document, 'blue-ice', 1.9)).toMatchObject({ energy: 0.5, active: true, cooldown: 0, maxDistance: 4 })
    expect(electroSprintState(document, 'blue-ice', 3.8)).toMatchObject({ energy: 0, active: false, cooldown: 4 })
    expect(electroSprintState(document, 'blue-ice', 7.8).energy).toBeCloseTo(4 / 15)
    expect(electroSprintState(document, 'blue-ice', 18.8).energy).toBe(1)
    const frame = projectFrame(document, 5.8)
    expect(frame.sprints?.['blue-ice']?.cooldown).toBeCloseTo(2)
    expect(frame.cooldowns['blue-ice']!.e).toBeCloseTo(2)
  })

  it('retains partial energy and limits a subsequent dash to available energy', () => {
    const document = setup()
    sprint(document, 1.9)
    const next = sprint(document, 3.8, 5.9)
    syncSprintPath(document, next)
    expect(next.duration).toBeCloseTo((0.5 + 4 / 15) * 3.8)
    expect(pathLength(next.path)).toBeCloseTo((0.5 + 4 / 15) * 8)
  })

  it('does not apply authored slow, enemy ice zones or transferred reception boosts to E', () => {
    const document = setup()
    const action = sprint(document)
    document.actions.push({ id: 'slow', type: 'status', status: 'slowed', targetId: action.actorId, startTime: 0, duration: 7 },
      { id: 'enemy-zone', type: 'eZone', actorId: 'red-ice', startTime: 0, duration: 10, center: { x: 8, y: 9 }, radius: 20 })
    expect(projectFrame(document, 1.9).players.find((player) => player.id === action.actorId)!.position.x).toBeCloseTo(9)
    expect(eZoneSlowSegmentsForMove(document, action)).toEqual([])
    expect(statusSlowSegmentsForMove(document, action)).toEqual([])
    expect(receiveMoveBoosts(document, action)).toEqual([])
  })

  it('changes a timed E arrow length without slowing, including editable curves at the energy limit', () => {
    const document = setup()
    const action = sprint(document, 1)
    action.duration = 2
    action.timingConstraint = { kind: 'fixed' }
    syncSprintPath(document, action)
    expect(pathLength(resolvedMovePath(action))).toBeCloseTo(2 * 8 / 3.8)
    expect(projectFrame(document, 1).players.find((player) => player.id === action.actorId)!.position.x).toBeCloseTo(5 + 8 / 3.8)
    delete action.timingConstraint
    action.path[1] = { x: 14, y: 9 }
    action.curveControl = { x: 9, y: 5 }
    syncSprintPath(document, action)
    expect(action.curveControl).toBeDefined()
    expect(pathLength(resolvedMovePath(action))).toBeCloseTo(8, 6)
    expect(action.duration).toBeCloseTo(3.8)
  })

  it('stops at freezing, retains energy and never auto resumes after thaw', () => {
    const document = setup()
    const action = sprint(document)
    document.actions.push({ id: 'freeze', type: 'status', status: 'frozen', targetId: action.actorId, startTime: 1, duration: 2 })
    normalizeSprintActions(document)
    expect(action.duration).toBe(1)
    expect(projectFrame(document, 5).players.find((player) => player.id === action.actorId)!.position.x).toBeCloseTo(5 + 8 / 3.8)
    expect(electroSprintState(document, action.actorId, 2).energy).toBeCloseTo(1 - 1 / 3.8 + 1 / 15)
    expect(document.actions.filter((item) => item.type === 'move')).toHaveLength(1)
  })

  it('stops at Q without draining remaining energy and blocks cooldown or carrying starts', () => {
    const document = setup()
    const action = sprint(document)
    document.actions.push({ id: 'q', type: 'qMove', actorId: action.actorId, startTime: 1, duration: 0,
      path: [{ x: 5 + 8 / 3.8, y: 9 }, { x: 6.8 + 8 / 3.8, y: 9 }] })
    normalizeSprintActions(document)
    expect(action.duration).toBe(1)
    expect(electroSprintState(document, action.actorId, 1).cooldown).toBe(4)
    const next = sprint(document, 1, 2)
    expect(normalizeSprintActions(document).notices).toHaveLength(1)
    expect(next.duration).toBe(0)
    const carried = setup()
    carried.initialScene.ball.carrierId = 'blue-ice'
    const forbidden = sprint(carried)
    normalizeSprintActions(carried)
    expect(forbidden.duration).toBe(0)
  })

  it('uses the actual moving-target Ice-Q hit time for energy and cooldown without recursive solves', () => {
    const document = setup()
    const action = sprint(document)
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 7, y: 11 }
    document.actions.push({ id: 'ice-q', type: 'qMove', actorId: 'red-ice', startTime: 0, duration: 1,
      path: [{ x: 7, y: 11 }, { x: 7, y: 8 }] })
    const freeze = documentFreezeWindows(document, action.actorId)[0]!
    expect(freeze.startsAt).toBeGreaterThan(0)
    expect(freeze.startsAt).toBeLessThan(1)
    const raw = projectFrame(document, freeze.startsAt + 0.2)
    expect(raw.sprints?.[action.actorId]?.cooldown).toBeCloseTo(3.8)
    normalizeSprintActions(document)
    expect(action.duration).toBeCloseTo(freeze.startsAt, 7)
    expect(projectFrame(document, 5).sprints?.[action.actorId]?.active).toBe(false)
    expect(document.actions.filter((candidate) => candidate.type === 'move')).toHaveLength(1)
  })

  it('adds own/other-selectable start, stop and cooldown-ready keyframes', () => {
    const document = setup()
    const action = sprint(document, 1.9)
    const events = documentTimingKeyframes(document).filter((event) => 'actionId' in event.reference && event.reference.actionId === action.id)
    expect(events.map((event) => event.label)).toEqual(['雷 E开始', '雷 E结束', '雷 E 冷却结束'])
    expect(events.map((event) => event.time)).toEqual([0, 1.9, 5.9])
    expect(timelineJointTimes(document)).toContain(5.9)
  })
})

describe('exact reception interrupts Electro E', () => {
  function withPass(curved = false) {
    const document = setup()
    const actor = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    document.initialScene.ball.carrierId = actor.id
    document.initialScene.ball.position = { ...actor.position }
    document.initialScene.players.forEach((player) => { player.hasBall = player.id === actor.id })
    const action = sprint(document)
    if (curved) { action.curveControl = { x: 8, y: 6 }; syncSprintPath(document, action) }
    const pass: PassAction = { id: 'pass', type: 'pass', actorId: actor.id, targetPlayerId: action.actorId,
      startTime: 0, duration: 1, path: [{ ...actor.position }, { ...action.path[0]! }] }
    document.actions.push(pass)
    normalizeBallActions(document)
    return { document, action, pass }
  }

  it.each([false, true])('splits at the solved non-keyframe catch and keeps an independent ordinary remainder (curve=%s)', (curved) => {
    const { document, action, pass } = withPass(curved)
    expect(pass.flightOutcome).toBe('received')
    const catchTime = pass.startTime + pass.duration
    const expectedCatch = projectFrame(document, catchTime).players.find((player) => player.id === action.actorId)!.position
    const originalRoute = resolvedMovePath(action)
    const normalized = normalizeSprintActions(document)
    expect(normalized.changed).toBe(true)
    expect(action.duration).toBeCloseTo(catchTime, 8)
    const tail = document.actions.find((item): item is MoveAction => item.type === 'move' && !item.sprint)!
    expect(tail.startTime).toBeCloseTo(catchTime, 8)
    expect(distance(tail.path[0]!, expectedCatch)).toBeLessThan(1e-6)
    expect(tail.path.at(-1)).toEqual(originalRoute.at(-1))
    expect(pathLength(action.path) + pathLength(tail.path)).toBeCloseTo(pathLength(originalRoute), 7)
    expect(tail.timingConstraint).toBeUndefined()
    normalizeBallActions(document)
    expect(normalizeSprintActions(document).changed).toBe(false)
    const frame = projectFrame(document, catchTime + 0.1)
    expect(frame.ball.carrierId).toBe(action.actorId)
    expect(frame.ball.position).toEqual(frame.players.find((player) => player.id === action.actorId)!.position)
    const json = JSON.stringify(document.actions)
    normalizeBallActions(document)
    normalizeSprintActions(document)
    expect(JSON.stringify(document.actions)).toBe(json)
    document.actions = document.actions.filter((item) => item.id !== tail.id)
    normalizeSprintActions(document)
    expect(document.actions.some((item) => item.id === tail.id)).toBe(false)
    document.actions = document.actions.filter((item) => item.type !== 'pass' && item.type !== 'receive')
    normalizeSprintActions(document)
    expect(action.duration).toBeCloseTo(catchTime, 8)
  })

  it('reuses warm player/frame queries without solving flights and protects cached energy from callers', () => {
    const { document, action } = withPass(true)
    normalizeSprintActions(document)
    normalizeBallActions(document)
    const reader = createPlayerPositionReader(document, action.actorId)
    const route = projectedMovePath(document, action)
    const spy = vi.spyOn(passReception, 'solvePassReception')
    const start = performance.now()
    for (let index = 0; index < 90; index += 1) {
      const time = (index % 2 ? index / 90 : 1 - index / 90) * 10
      const frame = projectFrame(document, time)
      expect(reader(time)).toEqual(frame.players.find((player) => player.id === action.actorId)!.position)
      frame.sprints!['blue-ice']!.energy = -10
    }
    expect(performance.now() - start).toBeLessThan(1000)
    expect(spy).not.toHaveBeenCalled()
    expect(projectFrame(document, 0).sprints?.['blue-ice']?.energy).toBe(1)
    expect(projectedMovePath(document, action)).toEqual(route)
    spy.mockRestore()
  })

  it('never duplicates or resurrects an edited/deleted tail when an upstream launch moves closer', () => {
    const { document, action } = withPass()
    normalizeSprintActions(document)
    normalizeBallActions(document)
    const originalStop = action.startTime + action.duration
    const tail = document.actions.find((item): item is MoveAction => item.type === 'move' && !item.sprint)!
    tail.path[tail.path.length - 1] = { x: 15, y: 10 }
    const editedPath = structuredClone(tail.path)
    const passer = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    passer.position = { x: 5, y: 8 }
    document.initialScene.ball.position = { ...passer.position }
    normalizeBallActions(document)
    normalizeSprintActions(document)
    expect(action.duration).toBeLessThan(originalStop)
    expect(document.actions.filter((item) => item.type === 'move' && !item.sprint)).toHaveLength(1)
    expect(tail.path).toEqual(editedPath)
    document.actions = document.actions.filter((item) => item.id !== tail.id)
    passer.position = { x: 5, y: 8.5 }
    document.initialScene.ball.position = { ...passer.position }
    normalizeBallActions(document)
    normalizeSprintActions(document)
    expect(document.actions.filter((item) => item.type === 'move' && !item.sprint)).toHaveLength(0)
    document.actions = document.actions.filter((item) => item.type !== 'pass' && item.type !== 'receive')
    const stoppedDuration = action.duration
    normalizeSprintActions(document)
    expect(action.sprintReceptionSourceId).toBeUndefined()
    expect(action.duration).toBe(stoppedDuration)
  })
})
