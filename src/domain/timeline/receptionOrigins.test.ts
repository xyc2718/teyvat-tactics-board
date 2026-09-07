import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { LoosePassAction, PassAction, TacticDocumentV1 } from '../model/types'
import { parseTactic, serializeTactic } from '../../persistence/tacticFile'
import { actionEndTime } from './durations'
import { ballActionIsEffective, ballPossessionHistory } from './ballPossession'
import { ballEpisodeAt, ballEpisodeSourceIdAt, ballRelatedActionIds, normalizeBallActions, receptionOriginAt } from './looseBall'
import { looseBallBoostSource, movementReceiveBoostWindowsFor } from './movementEffects'
import { solvePassReception } from './passReception'
import { projectFrame, projectPlayerPosition } from './projectFrame'
import fixture from './fixtures/reception-loose-pass.json'

function receptionDocument() {
  const document = createDefaultDocument()
  document.initialScene.players.forEach((player, index) => {
    player.hasBall = player.id === 'blue-fire'
    player.position = { x: 2 + index, y: 12 }
  })
  for (const [id, x] of [['blue-fire', 2], ['blue-ice', 6], ['blue-water', 9]] as const) {
    document.initialScene.players.find((player) => player.id === id)!.position = { x, y: 3 }
  }
  document.initialScene.ball = { carrierId: 'blue-fire', isFree: false, position: { x: 2, y: 3 } }
  const source: PassAction = { id: 'source', type: 'pass', actorId: 'blue-fire', targetPlayerId: 'blue-ice',
    startTime: 0, duration: 0, path: [{ x: 2, y: 3 }, { x: 6, y: 3 }] }
  document.actions.push(source)
  expect(normalizeBallActions(document).invalidPickups).toEqual([])
  return { document, source }
}

function onward(document: TacticDocumentV1, source: PassAction, type: 'pass' | 'loosePass', offset = 0) {
  const common = { id: 'onward', actorId: 'blue-ice', startTime: actionEndTime(source) + offset, duration: 0,
    originReception: { sourceActionId: source.id, offset }, path: [{ x: 6, y: 3 }, { x: 9, y: 3 }] }
  const action: PassAction | LoosePassAction = type === 'pass' ? { ...common, type, targetPlayerId: 'blue-water' }
    : { ...common, type, aimDirection: { x: 0, y: 1 }, flightOutcome: 'grounded' }
  document.actions.push(action)
  return action
}

describe('ordinary reception origins and valid carrying intervals', () => {
  it.each(['pass', 'loosePass'] as const)('orders exact reception then onward %s under reversed serialization', (type) => {
    const { document, source } = receptionDocument()
    const action = onward(document, source, type)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(action.startTime).toBe(actionEndTime(source))
    expect(projectFrame(document, action.startTime).ball.carrierId).toBeNull()
    expect(projectFrame(document, action.startTime + 0.01).ball.isFree).toBe(true)
    const expected = [action.startTime, action.startTime + 0.1, 4].map((time) => projectFrame(document, time).ball)
    document.actions.reverse()
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    for (const [index, time] of [action.startTime, action.startTime + 0.1, 4].entries()) {
      expect(projectFrame(document, time).ball).toEqual(expected[index])
    }
    const parsed = parseTactic(serializeTactic(document))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.document.actions.find((candidate) => candidate.id === action.id)).toEqual(action)
    expect(ballRelatedActionIds(document, ['source'])).toContain(action.id)
    expect(ballRelatedActionIds(document, [action.id])).not.toContain(source.id)
  })

  it('keeps a delayed moving release at its carrying offset when the source is solved again', () => {
    const { document, source } = receptionDocument()
    const receiveTime = actionEndTime(source)
    document.actions.push({ id: 'carry', type: 'move', actorId: 'blue-ice', startTime: receiveTime,
      duration: 4, path: [{ x: 6, y: 3 }, { x: 10, y: 3 }] })
    const offset = 1
    const action = onward(document, source, 'loosePass', offset)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(action.startTime).toBe(actionEndTime(source) + offset)
    expect(action.path[0]).toEqual(projectPlayerPosition(document, action.actorId, action.startTime))
    expect(action.path[0]!.x).toBeGreaterThan(7)
    document.initialScene.players.find((player) => player.id === 'blue-fire')!.position.x = 3
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(action.startTime).toBe(actionEndTime(source) + offset)
    expect(action.path[0]).toEqual(projectPlayerPosition(document, action.actorId, action.startTime))
    const snapshot = structuredClone(document.actions)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(document.actions).toEqual(snapshot)
  })

  it('identifies only the active reception interval and never restores a previous carrier', () => {
    const { document, source } = receptionDocument()
    const caught = actionEndTime(source)
    expect(receptionOriginAt(document, 'blue-ice', caught - 1e-7)).toBeUndefined()
    expect(receptionOriginAt(document, 'blue-ice', caught)).toEqual({ sourceActionId: source.id, offset: 0 })
    expect(receptionOriginAt(document, 'blue-ice', caught + 1)).toEqual({ sourceActionId: source.id, offset: 1 })
    const first = onward(document, source, 'loosePass')
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(receptionOriginAt(document, 'blue-ice', caught)).toBeUndefined()
    const second: LoosePassAction = { ...first as LoosePassAction, id: 'invalid-second', startTime: caught + 1,
      originReception: { sourceActionId: source.id, offset: 1 } }
    document.actions.push(second)
    expect(normalizeBallActions(document).invalidPickups).toEqual([expect.objectContaining({ actionId: second.id })])
    expect(looseBallBoostSource(document, second.id)).toBeUndefined()
    expect(ballEpisodeSourceIdAt(document, caught + 1.5)).toBe(first.id)
    expect(projectFrame(document, caught + 1.5).ball.isFree).toBe(true)
  })

  it('rejects an early unbound loose release without hiding the later legitimate reception', () => {
    const { document, source } = receptionDocument()
    const action = onward(document, source, 'loosePass')
    delete action.originReception
    action.startTime -= 0.01
    expect(normalizeBallActions(document).invalidPickups).toEqual([expect.objectContaining({ actionId: action.id })])
    expect(action.originReception).toBeUndefined()
    expect(projectFrame(document, actionEndTime(source) + 1).ball.carrierId).toBe('blue-ice')
    expect(looseBallBoostSource(document, action.id)).toBeUndefined()
  })

  it('suppresses a dependent ordinary flight, receipt and boost after ownership ended', () => {
    const { document, source } = receptionDocument()
    const first = onward(document, source, 'loosePass')
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    const second: PassAction = { id: 'invalid-ordinary', type: 'pass', actorId: 'blue-ice', targetPlayerId: 'blue-water',
      startTime: actionEndTime(source) + 1, duration: 0.1, flightOutcome: 'received',
      originReception: { sourceActionId: source.id, offset: 1 }, path: [{ x: 6, y: 3 }, { x: 9, y: 3 }] }
    document.actions.push(second, { id: 'stale-catch', type: 'receive', actorId: 'blue-water', sourceActionId: second.id,
      startTime: actionEndTime(second), duration: 0 })
    expect(projectFrame(document, 2).ball.carrierId).toBeNull()
    expect(movementReceiveBoostWindowsFor(document, 'blue-water', 0, 4)).toEqual([])
    expect(normalizeBallActions(document).invalidPickups).toEqual([expect.objectContaining({ actionId: second.id })])
    expect(document.actions.some((candidate) => candidate.id === 'stale-catch')).toBe(false)
    expect(ballEpisodeSourceIdAt(document, 2)).toBe(first.id)
  })

  it('invalidates downstream intent when the source drops and restores it after the source becomes reachable', () => {
    const { document, source } = receptionDocument()
    const action = onward(document, source, 'loosePass')
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    ice.position.x = 18
    expect(normalizeBallActions(document).invalidPickups).toEqual([expect.objectContaining({ actionId: action.id })])
    expect(source.flightOutcome).toBe('dropped')
    expect(projectFrame(document, 4).ball.isFree).toBe(true)
    expect(looseBallBoostSource(document, action.id)).toBeUndefined()
    ice.position.x = 6
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(action.startTime).toBe(actionEndTime(source))
    expect(projectFrame(document, 4).ball.isFree).toBe(true)
  })
})

describe('shot completion ends reception possession', () => {
  function shotDocument() {
    const { document, source } = receptionDocument()
    document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 13, y: 7 }
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 17, y: 7 }
    document.initialScene.ball.position = { x: 13, y: 7 }
    document.actions.push({ id: 'shot', type: 'shoot', actorId: 'blue-ice', startTime: 1.5, duration: 1,
      charge: 'yellow', path: [{ x: 17, y: 7 }, { x: 20, y: 7 }] })
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    return { document, source }
  }

  it.each(['pass', 'loosePass'] as const)('blocks an existing %s after a completed shot without reviving its source', (type) => {
    const { document, source } = shotDocument()
    const action = onward(document, source, type, 3)
    expect(normalizeBallActions(document).invalidPickups).toEqual([expect.objectContaining({ actionId: action.id })])
    expect(ballActionIsEffective(document, action.id)).toBe(false)
    expect(projectFrame(document, 4).ball.position).toEqual({ x: 20, y: 7 })
    expect(projectFrame(document, 4).ball.carrierId).toBeNull()
    expect(receptionOriginAt(document, 'blue-ice', 3)).toBeUndefined()
    expect(looseBallBoostSource(document, action.id)).toBeUndefined()
    document.actions.reverse()
    expect(normalizeBallActions(document).invalidPickups).toEqual([expect.objectContaining({ actionId: action.id })])
    expect(projectFrame(document, 4).ball.position).toEqual({ x: 20, y: 7 })
  })

  it.each(['interrupted', 'outside'] as const)('retains possession for an %s shot', (outcome) => {
    const { document, source } = shotDocument()
    if (outcome === 'interrupted') {
      document.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 16, y: 7 }
      document.actions.push({ id: 'interrupt', type: 'attack', actorId: 'red-water', targetId: 'blue-ice', startTime: 2, duration: 0 })
    } else {
      document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 6, y: 7 }
      document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 10, y: 7 }
      document.initialScene.ball.position = { x: 6, y: 7 }
    }
    const action = onward(document, source, 'loosePass', 3)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(ballActionIsEffective(document, action.id)).toBe(true)
    expect(projectFrame(document, 3).ball.carrierId).toBe('blue-ice')
    expect(projectFrame(document, 4).shots[0]?.completed).toBe(false)
    expect(projectFrame(document, 4).ball.position).not.toEqual({ x: 20, y: 7 })
  })

  it('invalidates a source edit across shot completion and restores the earlier release on reflow', () => {
    const { document, source } = shotDocument()
    const action = onward(document, source, 'loosePass', 1)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(action.startTime).toBeLessThan(2.5)
    source.startTime = 1
    expect(normalizeBallActions(document).invalidPickups).toEqual([expect.objectContaining({ actionId: action.id })])
    expect(action.startTime).toBeGreaterThan(2.5)
    expect(projectFrame(document, 4).ball.position).toEqual({ x: 20, y: 7 })
    source.startTime = 0
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(ballActionIsEffective(document, action.id)).toBe(true)
  })

  it('processes completion after an intervening catch, and permits a later fresh reception', () => {
    const { document } = shotDocument()
    document.actions.push({ id: 'during-charge', type: 'receive', actorId: 'blue-ice', startTime: 2, duration: 0 })
    expect(projectFrame(document, 2.25).ball.carrierId).toBe('blue-ice')
    expect(projectFrame(document, 2.25).shots[0]?.completed).toBe(false)
    expect(projectFrame(document, 2.5).ball.carrierId).toBeNull()
    document.actions.push({ id: 'later-receive', type: 'receive', actorId: 'blue-ice', startTime: 2.5, duration: 0 })
    document.actions.push({ id: 'later-release', type: 'loosePass', actorId: 'blue-ice', startTime: 4, duration: 3,
      aimDirection: { x: -1, y: 0 }, path: [{ x: 17, y: 7 }, { x: 11, y: 7 }], flightOutcome: 'grounded' })
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(projectFrame(document, 2.5).ball.carrierId).toBe('blue-ice')
    expect(projectFrame(document, 3.5).ball.carrierId).toBe('blue-ice')
    expect(projectFrame(document, 4.5).ball.position.x).toBeLessThan(17)
  })

  it('ends an older free-ball episode when a shot completes', () => {
    const { document, source } = shotDocument()
    const action = onward(document, source, 'loosePass', 1)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(ballEpisodeSourceIdAt(document, 2)).toBe(action.id)
    expect(ballEpisodeAt(document, 2)?.availableUntil).toBe(2.5)
    expect(ballEpisodeSourceIdAt(document, 2.5)).toBeUndefined()
    expect(ballEpisodeAt(document, 3)).toBeUndefined()
  })

  it('invalidates shot history on position changes and reuses it across 90 scrubs', () => {
    const { document, source } = shotDocument()
    const action = onward(document, source, 'loosePass', 3)
    expect(ballActionIsEffective(document, action.id)).toBe(false)
    const cached = ballPossessionHistory(document)
    for (let index = 0; index < 90; index += 1) {
      projectFrame(document, index % 2 ? index / 20 : 5 - index / 20)
      expect(ballPossessionHistory(document)).toBe(cached)
    }
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 10, y: 7 }
    expect(ballActionIsEffective(document, action.id)).toBe(true)
    expect(ballPossessionHistory(document)).not.toBe(cached)
  })
})

describe('reported tactic compatibility', () => {
  function loadFixture() {
    const parsed = parseTactic(JSON.stringify(fixture))
    if (!parsed.ok) throw Error(parsed.error)
    const document = parsed.document
    const action = document.actions.find((candidate): candidate is LoosePassAction => candidate.type === 'loosePass')!
    const source = document.actions.find((candidate): candidate is PassAction => candidate.type === 'pass'
      && candidate.targetPlayerId === action.actorId)!
    return { document, action, source }
  }

  it('does not change upstream homing integration when a downstream loose timestamp is added', () => {
    const { document, action, source } = loadFixture()
    const without = { ...document, actions: document.actions.filter((candidate) => candidate.id !== action.id) }
    expect(solvePassReception(document, source)).toEqual(solvePassReception(without, source))
  })

  it('recovers the evidenced near-coincident editor release, preserves rules and is idempotent', () => {
    const { document, action, source } = loadFixture()
    const rules = structuredClone(document.rulesSnapshot)
    expect(source.startTime + source.duration - action.startTime).toBeCloseTo(0.00028547622844232734, 12)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(action.originReception).toEqual({ sourceActionId: source.id, offset: 0 })
    expect(action.startTime).toBe(actionEndTime(source))
    expect(projectFrame(document, 5.04).ball.isFree).toBe(true)
    expect(document.rulesSnapshot).toEqual(rules)
    const normalized = structuredClone(document.actions)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(document.actions).toEqual(normalized)
    const reversed = structuredClone(document)
    reversed.actions.reverse()
    expect(normalizeBallActions(reversed).invalidPickups).toEqual([])
    expect(projectFrame(reversed, 5.04).ball).toEqual(projectFrame(document, 5.04).ball)
  })

  it('leaves deliberately independent nearby actions unbound', () => {
    const { document, action, source } = loadFixture()
    action.startTime = actionEndTime(source) + 0.0002
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(action.originReception).toBeUndefined()
  })
})

describe('reception origin file boundary', () => {
  it('rejects missing/wrong-actor/circular sources, negative offsets and conflicting origins', () => {
    const { document, source } = receptionDocument()
    const action = onward(document, source, 'loosePass')
    for (const origin of [{ sourceActionId: 'missing', offset: 0 }, { sourceActionId: source.id, offset: -1 }]) {
      action.originReception = origin
      expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    }
    action.originReception = { sourceActionId: source.id, offset: 0 }
    action.actorId = 'blue-water'
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    action.actorId = 'blue-ice'
    action.originPickupActionId = 'missing'
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    document.actions = [source, { id: 'cycle', type: 'pass', actorId: 'blue-ice', targetPlayerId: 'blue-fire',
      startTime: 0, duration: 0, path: [{ x: 6, y: 3 }, { x: 2, y: 3 }], originReception: { sourceActionId: source.id, offset: 0 } }]
    source.originReception = { sourceActionId: 'cycle', offset: 0 }
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    expect(normalizeBallActions(document).invalidPickups).toHaveLength(2)
    expect(projectFrame(document, 2).ball.carrierId).toBe('blue-fire')
  })
})
