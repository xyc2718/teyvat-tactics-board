import { describe, expect, it } from 'vitest'
import { pathLength } from '../geometry/geometry'
import { createDefaultDocument } from '../model/createDocument'
import type { LoosePassAction, MoveAction, PassAction, QMoveAction } from '../model/types'
import { passDuration, passTravelDistance } from './durations'
import { ballRelatedActionIds, createBallPickupAction, normalizeBallActions } from './looseBall'
import { loosePassJointTimes, loosePassPosition, reflectedFlight } from './loosePass'
import { looseBallBoostSource, movementReceiveBoostWindowsFor } from './movementEffects'
import { projectFrame, projectedMovePath } from './projectFrame'

function freeDocument() {
  const document = createDefaultDocument()
  document.initialScene.ball = { position: { x: 8, y: 3 }, carrierId: null, isFree: true }
  document.initialScene.players.forEach((player, index) => {
    player.hasBall = false
    player.position = { x: 1 + index * 2, y: 12 }
  })
  document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 6, y: 3 }
  document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 6, y: 3 }
  return document
}

function setCarrier(document: ReturnType<typeof freeDocument>, actorId = 'blue-fire') {
  const actor = document.initialScene.players.find((player) => player.id === actorId)!
  document.initialScene.players.forEach((player) => { player.hasBall = player.id === actorId })
  document.initialScene.ball = { carrierId: actorId, isFree: false, position: { ...actor.position } }
}

describe('loose flight calibration and reflections', () => {
  it('uses six grids in three seconds and changes only newly created regular-pass defaults', () => {
    const rules = createDefaultDocument().rulesSnapshot
    const result = reflectedFlight({ x: 2, y: 3 }, { x: 1, y: 0 }, rules)
    const action: LoosePassAction = { id: 'flight', type: 'loosePass', actorId: 'blue-fire', startTime: 0, aimDirection: { x: 1, y: 0 }, ...result }
    expect(result.duration).toBe(3)
    expect(pathLength(result.path)).toBe(6)
    expect(loosePassPosition(action, 1.5, rules)).toEqual({ x: 6.5, y: 3 })
    expect(passTravelDistance(1, rules)).toBe(6)
    expect(passDuration([{ x: 0, y: 0 }, { x: 4, y: 0 }], rules)).toBeCloseTo(2 * (1 - Math.sqrt(0.5)))
    const legacy = structuredClone(rules)
    legacy.passing.ballSpeed = 8
    expect(passDuration([{ x: 0, y: 0 }, { x: 8, y: 0 }], legacy)).toBe(1)
  })

  it('reflects at walls and corners without restarting time, but stops at a goal opening', () => {
    const rules = createDefaultDocument().rulesSnapshot
    const result = reflectedFlight({ x: 19, y: 3 }, { x: 1, y: 0 }, rules)
    expect(result.path).toEqual([{ x: 19, y: 3 }, { x: 20, y: 3 }, { x: 15, y: 3 }])
    expect(result.duration).toBe(3)
    const action: LoosePassAction = { id: 'flight', type: 'loosePass', actorId: 'blue-fire', startTime: 2, aimDirection: { x: 1, y: 0 }, ...result }
    expect(loosePassJointTimes(action, rules)[0]).toBeCloseTo(2 + 3 * (1 - Math.sqrt(5 / 6)))
    expect(reflectedFlight({ x: 20, y: 0 }, { x: 1, y: -1 }, rules).path.at(-1)).toEqual({ x: 20 - 6 / Math.sqrt(2), y: 6 / Math.sqrt(2) })
    const goal = reflectedFlight({ x: 19, y: 7 }, { x: 1, y: 0 }, rules)
    expect(goal.flightOutcome).toBe('goal')
    expect(goal.path.at(-1)).toEqual({ x: 20, y: 7 })
    expect(goal.duration).toBeLessThan(3)
  })
})

describe('explicit ball pickup causality', () => {
  it('runs to a resting ball, creates an exact receipt and keeps the ball attached afterwards', () => {
    const document = freeDocument()
    const result = createBallPickupAction(document, 'blue-fire', 0, 'move', 'pickup-run')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    document.actions.push(result.action)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(result.action.duration).toBeCloseTo(2)
    const receive = document.actions.find((action) => action.type === 'receive')!
    expect(projectFrame(document, receive.startTime - 1e-7).ball.carrierId).toBeNull()
    expect(projectFrame(document, receive.startTime).ball.carrierId).toBe('blue-fire')
    document.actions.push({ id: 'after', type: 'move', actorId: 'blue-fire', startTime: receive.startTime, duration: 2, path: [{ x: 8, y: 3 }, { x: 10, y: 3 }] })
    expect(projectFrame(document, receive.startTime + 1).ball.position).toEqual({ x: 9, y: 3 })
    expect(projectedMovePath(document, result.action as MoveAction).length).toBeGreaterThan(2)
  })

  it('preserves full fire Q and supports adjustable ice Q while rejecting a path missing the ball', () => {
    const document = freeDocument()
    const result = createBallPickupAction(document, 'blue-fire', 0, 'qMove', 'fire-pickup')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(pathLength(result.action.path)).toBeCloseTo(2.3)
    document.actions.push(result.action)
    normalizeBallActions(document)
    expect(projectFrame(document, 0).ball).toMatchObject({ carrierId: 'blue-fire', position: { x: 8.3, y: 3 } })
    const iceDocument = freeDocument()
    const ice = createBallPickupAction(iceDocument, 'blue-ice', 0, 'qMove', 'ice-pickup')
    expect(ice.ok).toBe(true)
    if (!ice.ok) return
    iceDocument.actions.push(ice.action)
    expect(normalizeBallActions(iceDocument).invalidPickups).toEqual([])
    expect(iceDocument.actions.find((action) => action.type === 'receive')!.startTime).toBeCloseTo(2 / 3)
    ice.action.path[1] = { x: 8.5, y: 3 }
    expect(normalizeBallActions(iceDocument).invalidPickups).toEqual([])
    expect(iceDocument.actions.find((action) => action.type === 'receive')!.startTime).toBeCloseTo(0.8)
    ice.action.path[1] = { x: 7.5, y: 3 }
    expect(normalizeBallActions(iceDocument).invalidPickups[0]?.actionId).toBe('ice-pickup')
    expect(iceDocument.actions.some((action) => action.type === 'receive')).toBe(false)
  })

  it('pursues a flying rebound and caches its resolved trace for scrubbing', () => {
    const document = freeDocument()
    const fire = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    fire.position = { x: 19, y: 3 }
    setCarrier(document)
    const flight: LoosePassAction = { id: 'throw', type: 'loosePass', actorId: fire.id, startTime: 0, duration: 3,
      aimDirection: { x: 1, y: 0 }, path: [fire.position, { x: 20, y: 3 }], flightOutcome: 'grounded' }
    document.actions.push(flight)
    normalizeBallActions(document)
    const result = createBallPickupAction(document, 'blue-ice', 0.5, 'move', 'chase')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    document.actions.push(result.action)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    const stored = JSON.stringify(document.actions)
    for (let index = 0; index < 90; index += 1) projectFrame(document, index / 10)
    expect(JSON.stringify(document.actions)).toBe(stored)
    expect(projectFrame(document, 30).ball.carrierId).toBe('blue-ice')
  })

  it('truncates an intercepted flight at contact and restores its full aim after pickup deletion', () => {
    const document = freeDocument()
    document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 6, y: 3 }
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 9, y: 3 }
    setCarrier(document)
    const flight: LoosePassAction = { id: 'throw', type: 'loosePass', actorId: 'blue-fire', startTime: 0, duration: 3,
      path: [{ x: 6, y: 3 }, { x: 12, y: 3 }], aimDirection: { x: 1, y: 0 }, flightOutcome: 'grounded' }
    document.actions.push(flight)
    normalizeBallActions(document)
    const pickup = createBallPickupAction(document, 'blue-ice', 0.1, 'move', 'pickup')
    if (!pickup.ok) throw Error(pickup.message)
    document.actions.push(pickup.action)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(flight.flightOutcome).toBe('pickedUp')
    expect(flight.duration).toBeLessThan(3)
    expect(pathLength(flight.path)).toBeLessThan(6)
    const original = structuredClone(document.actions)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(document.actions).toEqual(original)
    document.actions = document.actions.filter((action) => !ballRelatedActionIds(document, ['pickup']).has(action.id))
    normalizeBallActions(document)
    expect(flight.flightOutcome).toBe('grounded')
    expect(flight.duration).toBe(3)
    expect(pathLength(flight.path)).toBe(6)
  })

  it('retains exact immediate re-pass links across repeat normalization and source movement', () => {
    const document = freeDocument()
    const result = createBallPickupAction(document, 'blue-fire', 0, 'move', 'pickup')
    if (!result.ok) throw Error(result.message)
    document.actions.push(result.action)
    normalizeBallActions(document)
    const receive = document.actions.find((action) => action.type === 'receive')!
    const pass: PassAction = { id: 'next-pass', type: 'pass', actorId: 'blue-fire', targetPlayerId: 'blue-water', originPickupActionId: 'pickup',
      startTime: receive.startTime, duration: 0, path: [{ x: 8, y: 3 }, { x: 5, y: 3 }] }
    document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 5, y: 3 }
    document.actions.push(pass)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    const first = structuredClone(document.actions)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(document.actions).toEqual(first)
    document.initialScene.ball.position.x = 9
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(pass.startTime).toBeCloseTo(3)
    expect(pass.path[0]!.x).toBeCloseTo(9)
    expect(projectFrame(document, actionEnd(pass)).ball.carrierId).toBe('blue-water')
    expect(ballRelatedActionIds(document, ['pickup'])).toContain('next-pass')
  })

  it('reports simultaneous contenders without selecting an array-order winner', () => {
    const document = freeDocument()
    for (const [id, actorId] of [['one', 'blue-fire'], ['two', 'blue-ice']] as const) {
      const result = createBallPickupAction(document, actorId, 0, 'move', id)
      if (!result.ok) throw Error(result.message)
      document.actions.push(result.action)
    }
    expect(normalizeBallActions(document).invalidPickups).toHaveLength(2)
    expect(document.actions.some((action) => action.type === 'receive')).toBe(false)
    document.actions.reverse()
    expect(normalizeBallActions(document).invalidPickups).toHaveLength(2)
  })

  it('moves a contiguous pickup-to-Q chain when the ball moves but keeps a detached action time', () => {
    const document = freeDocument()
    const result = createBallPickupAction(document, 'blue-fire', 0, 'move', 'pickup')
    if (!result.ok) throw Error(result.message)
    document.actions.push(result.action)
    normalizeBallActions(document)
    const end = result.action.startTime + result.action.duration
    const q: QMoveAction = { id: 'following-q', type: 'qMove', actorId: 'blue-fire', startTime: end, duration: 0, path: [{ x: 8, y: 3 }, { x: 10.3, y: 3 }] }
    const detached: MoveAction = { id: 'detached', type: 'move', actorId: 'blue-fire', startTime: 20, duration: 2, path: [{ x: 10.3, y: 3 }, { x: 12.3, y: 3 }] }
    document.actions.push(q, detached)
    document.initialScene.ball.position.x = 9
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    expect(q.startTime).toBeCloseTo(3)
    expect(q.path[0]).toEqual({ x: 9, y: 3 })
    expect(pathLength(q.path)).toBeCloseTo(2.3)
    expect(detached.startTime).toBe(20)
    expect(projectFrame(document, q.startTime).ball.position.x).toBeCloseTo(11.3)
  })

  it('invalidates downstream re-pass ownership and boosts if an upstream pickup becomes unreachable', () => {
    const document = freeDocument()
    const result = createBallPickupAction(document, 'blue-fire', 0, 'qMove', 'pickup')
    if (!result.ok) throw Error(result.message)
    document.actions.push(result.action)
    normalizeBallActions(document)
    const pass: PassAction = { id: 'after', type: 'pass', actorId: 'blue-fire', targetPlayerId: 'blue-ice', originPickupActionId: 'pickup',
      startTime: 0, duration: 0, path: [{ x: 8.3, y: 3 }, { x: 6, y: 3 }] }
    document.actions.push(pass)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    document.initialScene.ball.position.x = 14
    expect(normalizeBallActions(document).invalidPickups).toHaveLength(2)
    expect(document.actions.some((action) => action.type === 'receive')).toBe(false)
    expect(projectFrame(document, 20).ball.carrierId).toBeNull()
    expect(movementReceiveBoostWindowsFor(document, 'blue-ice', 0, 20)).toEqual([])
  })

  it('rejects Q pickup during cooldown/freeze, and cannot sweep a moving ball at a different time', () => {
    const document = freeDocument()
    document.actions.push({ id: 'prior-q', type: 'qMove', actorId: 'blue-fire', startTime: 0, duration: 0, path: [{ x: 6, y: 3 }, { x: 8.3, y: 3 }] })
    expect(createBallPickupAction(document, 'blue-fire', 1, 'qMove', 'new').ok).toBe(false)
    document.actions = [{ id: 'frozen', type: 'status', status: 'frozen', targetId: 'blue-fire', startTime: 0, duration: 2 }]
    expect(createBallPickupAction(document, 'blue-fire', 0, 'qMove', 'new').ok).toBe(false)
    expect(createBallPickupAction(document, 'blue-fire', 0, 'move', 'new').ok).toBe(false)
    document.actions = []
    const fire = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    fire.position = { x: 8, y: 3 }
    setCarrier(document)
    const flight: LoosePassAction = { id: 'away', type: 'loosePass', actorId: fire.id, startTime: 0, duration: 3,
      path: [{ x: 8, y: 3 }, { x: 14, y: 3 }], aimDirection: { x: 1, y: 0 }, flightOutcome: 'grounded' }
    const q: QMoveAction = { id: 'miss', type: 'qMove', actorId: 'blue-ice', startTime: 0, duration: 1,
      path: [{ x: 6, y: 3 }, { x: 9, y: 3 }], ballTarget: { sourceActionId: flight.id } }
    document.actions.push(flight, q)
    expect(normalizeBallActions(document).invalidPickups).toHaveLength(1)
    expect(document.actions.some((action) => action.type === 'receive')).toBe(false)
  })

  it('solves a synchronous ice Q catch after a wall bounce, including the exact bounce boundary', () => {
    const document = freeDocument()
    document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 19, y: 3 }
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 18.5, y: 3 }
    setCarrier(document)
    const flight: LoosePassAction = { id: 'throw', type: 'loosePass', actorId: 'blue-fire', startTime: 0, duration: 3,
      path: [{ x: 19, y: 3 }, { x: 15, y: 3 }], aimDirection: { x: 1, y: 0 }, flightOutcome: 'grounded' }
    document.actions.push(flight)
    normalizeBallActions(document)
    const bounceTime = loosePassJointTimes(flight, document.rulesSnapshot)[0]!
    const result = createBallPickupAction(document, 'blue-ice', 0, 'qMove', 'pickup')
    if (!result.ok) throw Error(result.message)
    document.actions.push(result.action)
    expect(normalizeBallActions(document).invalidPickups).toEqual([])
    const receive = document.actions.find((action) => action.type === 'receive')!
    expect(receive.startTime).toBeGreaterThan(bounceTime)
    expect(receive.startTime).toBeLessThan(1)
    expect(result.action.duration).toBe(1)
    expect(projectFrame(document, receive.startTime).ball.carrierId).toBe('blue-ice')
  })

  it('rejects pickup when a freeze interrupts a non-instant Q before the contact', () => {
    const document = freeDocument()
    document.actions.push({ id: 'mid-freeze', type: 'status', targetId: 'blue-ice', status: 'frozen', startTime: 0.5, duration: 1.75 })
    const result = createBallPickupAction(document, 'blue-ice', 0, 'qMove', 'pickup')
    expect(result.ok).toBe(false)
    expect(document.actions).toHaveLength(1)
  })
})

function actionEnd(action: PassAction | QMoveAction) { return action.startTime + action.duration }

describe('marked ice empty passes', () => {
  it.each([false, true])('only marks an already boosted ice launch (eligible=%s), refreshed after long ground waiting', (eligible) => {
    const document = freeDocument()
    const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    ice.position = { x: 5, y: 3 }
    if (!eligible) setCarrier(document, ice.id)
    if (eligible) document.actions.push({ id: 'prior', type: 'pass', actorId: 'blue-water', targetPlayerId: ice.id,
      startTime: 0, duration: 0, path: [{ x: 5, y: 3 }, { x: 5, y: 3 }], flightOutcome: 'received' })
    document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 5, y: 3 }
    const flight: LoosePassAction = { id: 'ice-throw', type: 'loosePass', actorId: ice.id, startTime: 1, duration: 3,
      aimDirection: { x: 1, y: 0 }, path: [ice.position, { x: 11, y: 3 }], flightOutcome: 'grounded' }
    document.actions.push(flight)
    normalizeBallActions(document)
    expect(!!looseBallBoostSource(document, flight.id)).toBe(eligible)
    document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 10, y: 3 }
    const result = createBallPickupAction(document, 'blue-fire', 20, 'move', 'pickup')
    if (!result.ok) throw Error(result.message)
    document.actions.push(result.action)
    normalizeBallActions(document)
    const receive = document.actions.find((action) => action.type === 'receive' && action.pickupActionId)!
    expect(flight.duration).toBe(3)
    expect(flight.flightOutcome).toBe('grounded')
    const boosts = movementReceiveBoostWindowsFor(document, 'blue-fire', 0, 30)
    expect(boosts).toHaveLength(eligible ? 1 : 0)
    if (eligible) expect(boosts[0]!.end - receive.startTime).toBeCloseTo(4.3)
  })

  it('does not give an unmarked ball the ice receiver fallback and never transfers the mark to opponents', () => {
    for (const opponent of [false, true]) {
      const document = freeDocument()
      const actorId = opponent ? 'red-ice' : 'blue-ice'
      document.initialScene.players.find((player) => player.id === actorId)!.position = { x: 6, y: 3 }
      const result = createBallPickupAction(document, actorId, 0, 'move', 'pickup')
      if (!result.ok) throw Error(result.message)
      document.actions.push(result.action)
      normalizeBallActions(document)
      expect(movementReceiveBoostWindowsFor(document, actorId, 0, 20)).toEqual([])
      expect(projectFrame(document, result.action.duration).statuses.filter((status) => status.kind === 'boosted')).toEqual([])
    }
  })
})
