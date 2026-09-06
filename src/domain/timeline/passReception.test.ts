import { describe, expect, it } from 'vitest'
import { distance, pathLength, pointAlongPath } from '../geometry/geometry'
import { createDefaultDocument } from '../model/createDocument'
import { MAX_PASS_PATH_POINTS } from '../model/passFlight'
import type { PassAction, Vec2 } from '../model/types'
import { passDuration, passPathProgress, passTravelDistance } from './durations'
import { solvePassReception } from './passReception'
import { documentFreezeWindows, projectFrame } from './projectFrame'

describe('pass reception solver', () => {
  it('aims at the moving receiver position at the solved catch time', () => {
    const document = createDefaultDocument()
    const passer = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const receiver = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    passer.position = { x: 0, y: 7 }
    receiver.position = { x: 4, y: 7 }
    document.initialScene.ball = { carrierId: passer.id, position: { ...passer.position }, isFree: false }
    document.initialScene.players.forEach((player) => { player.hasBall = player.id === passer.id })
    document.actions.push({
      id: 'receiver-run',
      type: 'move',
      actorId: receiver.id,
      path: [{ x: 4, y: 7 }, { x: 8, y: 7 }],
      startTime: 0,
      duration: 4,
    })
    const pass: PassAction = {
      id: 'moving-receiver-pass',
      type: 'pass',
      actorId: passer.id,
      targetPlayerId: receiver.id,
      path: [{ ...passer.position }, { ...receiver.position }],
      startTime: 0,
      duration: 0,
    }
    document.actions.push(pass)

    const solved = solvePassReception(document, pass)
    const expectedTime = (15 - Math.sqrt(97)) / 16
    const receiverAtArrival = projectFrame(
      { ...document, actions: document.actions.filter((action) => action.id !== pass.id) },
      solved.arrivalTime,
    ).players.find((player) => player.id === receiver.id)!

    expect(solved.received).toBe(true)
    expect(solved.duration).toBeCloseTo(expectedTime, 4)
    expect(solved.path.at(-1)?.x).toBeCloseTo(receiverAtArrival.position.x, 10)
    expect(solved.path.at(-1)?.y).toBeCloseTo(receiverAtArrival.position.y, 10)
    expect(solved.path.at(-1)?.x).toBeGreaterThan(receiver.position.x)
  })

  it('keeps a free pass landing point authored while moving only its origin', () => {
    const document = createDefaultDocument()
    const pass: PassAction = {
      id: 'free-pass',
      type: 'pass',
      actorId: 'blue-water',
      path: [{ x: 0, y: 0 }, { x: 9, y: 6 }],
      startTime: 0,
      duration: 0,
    }

    const solved = solvePassReception(document, pass)

    expect(solved.received).toBe(false)
    expect(solved.path[0]).toEqual({ x: 5.5, y: 4.7 })
    expect(solved.path.at(-1)).toEqual({ x: 9, y: 6 })
  })

  it('does not create a catch when the named receiver stays beyond maximum range', () => {
    const document = createDefaultDocument()
    const passer = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const receiver = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    passer.position = { x: 0, y: 7 }
    receiver.position = { x: 12, y: 7 }
    const pass: PassAction = {
      id: 'overlong-named-pass',
      type: 'pass',
      actorId: passer.id,
      targetPlayerId: receiver.id,
      path: [{ ...passer.position }, { ...receiver.position }],
      startTime: 0,
      duration: 0,
    }

    const solved = solvePassReception(document, pass)

    expect(solved.received).toBe(false)
    expect(solved.duration).toBeCloseTo(1)
    expect(solved.path.at(-1)).toEqual({ x: 8, y: 7 })
    expect(pathLength(solved.path)).toBeCloseTo(8, 10)
  })
})

function setupPass(target: Vec2 = { x: 6, y: 7 }, receiverId = 'blue-ice') {
  const document = createDefaultDocument()
  const passer = document.initialScene.players.find((player) => player.id === 'blue-water')!
  const receiver = document.initialScene.players.find((player) => player.id === receiverId)!
  passer.position = { x: 2, y: 7 }
  receiver.position = { ...target }
  document.initialScene.players.filter((player) => player.team === 'red').forEach((player, index) => {
    player.position = { x: 18, y: 11 + index }
  })
  const pass: PassAction = {
    id: 'homing-pass', type: 'pass', actorId: passer.id, targetPlayerId: receiver.id,
    path: [{ ...passer.position }, { ...receiver.position }], startTime: 0, duration: 0,
  }
  document.actions.push(pass)
  return { document, pass, passer, receiver }
}

/** Independent tiny-step forward-Euler reference for smooth test trajectories.
 * It never uses the production midpoint or local root solver. The 10-microsecond
 * final contact uncertainty is included in the much tighter-than-pixel bounds. */
function referencePursuit(origin: Vec2, receiverAt: (time: number) => Vec2) {
  const step = 1 / 100_000
  let ball = { ...origin }
  let traveled = 0
  for (let index = 0; index < 100_000; index += 1) {
    const time = index * step
    const target = receiverAt(time)
    const separation = distance(ball, target)
    const nextDistance = 16 * (time + step) - 8 * (time + step) ** 2
    const length = nextDistance - traveled
    if (separation <= length) return { duration: time, endpoint: target, received: true }
    ball = { x: ball.x + (target.x - ball.x) * length / separation, y: ball.y + (target.y - ball.y) * length / separation }
    traveled = nextDistance
  }
  return { duration: 1, endpoint: ball, received: false }
}

describe('homing flight trajectory', () => {
  it.each([4, 8])('preserves exact stationary %s-grid timing and cumulative distance', (length) => {
    const { document, pass } = setupPass({ x: 2 + length, y: 7 })
    const solved = solvePassReception(document, pass)
    expect(solved.received).toBe(true)
    expect(solved.duration).toBeCloseTo(1 - Math.sqrt(1 - length / 8), 7)
    expect(pathLength(solved.path)).toBeCloseTo(length, 8)
    expect(passDuration(solved.path, document.rulesSnapshot)).toBeCloseTo(solved.duration, 7)
  })

  it('curves toward a transverse runner instead of aiming straight at its future catch point', () => {
    const { document, pass, receiver, passer } = setupPass()
    document.actions.unshift({ id: 'cross-run', type: 'move', actorId: receiver.id, startTime: 0, duration: 2, path: [{ x: 6, y: 7 }, { x: 6, y: 9 }] })
    const solved = solvePassReception(document, pass)
    const reference = referencePursuit(passer.position, (time) => ({ x: 6, y: 7 + time }))
    expect(solved.received).toBe(true)
    expect(solved.path.length).toBeGreaterThan(30)
    const first = solved.path[1]!
    const last = solved.path.at(-1)!
    const initialSlope = (first.y - passer.position.y) / (first.x - passer.position.x)
    const finalSlope = (last.y - passer.position.y) / (last.x - passer.position.x)
    expect(initialSlope).toBeLessThan(finalSlope / 20)
    expect(Math.abs(solved.duration - reference.duration)).toBeLessThan(0.0002)
    expect(distance(last, reference.endpoint)).toBeLessThan(0.0002)
    expect(pathLength(solved.path)).toBeCloseTo(passTravelDistance(solved.duration, document.rulesSnapshot), 8)
  })

  it('follows a receiver turning during flight within 0.001 grids of a fine reference', () => {
    const { document, pass, receiver, passer } = setupPass({ x: 8, y: 7 })
    document.actions.unshift(
      { id: 'turn-first', type: 'move', actorId: receiver.id, startTime: 0, duration: 0.2, path: [{ x: 8, y: 7 }, { x: 8, y: 7.2 }] },
      { id: 'turn-second', type: 'move', actorId: receiver.id, startTime: 0.2, duration: 2, path: [{ x: 8, y: 7.2 }, { x: 10, y: 7.2 }] },
    )
    const target = (time: number) => time < 0.2 ? { x: 8, y: 7 + time } : { x: 8 + time - 0.2, y: 7.2 }
    const solved = solvePassReception(document, pass)
    const reference = referencePursuit(passer.position, target)
    expect(solved.received).toBe(true)
    expect(Math.abs(solved.duration - reference.duration)).toBeLessThan(0.0002)
    expect(distance(solved.path.at(-1)!, reference.endpoint)).toBeLessThan(0.001)
    expect(distance(solved.path.at(-1)!, target(solved.duration))).toBeLessThan(1e-9)
  })

  it('drops after 8 cumulative grids when a target starts in range but escapes', () => {
    const { document, pass, receiver } = setupPass({ x: 9.8, y: 7 })
    document.actions.unshift({ id: 'escape', type: 'move', actorId: receiver.id, startTime: 0, duration: 3, path: [{ x: 9.8, y: 7 }, { x: 12.8, y: 7 }] })
    const solved = solvePassReception(document, pass)
    expect(solved.received).toBe(false)
    expect(solved.duration).toBe(1)
    expect(pathLength(solved.path)).toBeCloseTo(8, 10)
    expect(solved.path.at(-1)).toEqual({ x: 10, y: 7 })
    expect(solved.receiverPosition?.x).toBeCloseTo(10.8, 10)
  })

  it('uses cumulative curved travel, not displacement, for an escaping transverse receiver', () => {
    const { document, pass, receiver, passer } = setupPass({ x: 9.99, y: 7 })
    document.actions.unshift({ id: 'escape-cross', type: 'move', actorId: receiver.id, startTime: 0, duration: 2, path: [{ x: 9.99, y: 7 }, { x: 9.99, y: 13 }] })
    const solved = solvePassReception(document, pass)
    const reference = referencePursuit(passer.position, (time) => ({ x: 9.99, y: 7 + 3 * time }))
    expect(solved.received).toBe(false)
    expect(solved.duration).toBe(1)
    expect(pathLength(solved.path)).toBeCloseTo(8, 10)
    expect(distance(passer.position, solved.path.at(-1)!)).toBeLessThan(7.9)
    expect(distance(solved.path.at(-1)!, reference.endpoint)).toBeLessThan(0.001)
  })

  it('keeps the ball continuous through a mid-flight instantaneous Q', () => {
    const { document, pass, receiver } = setupPass({ x: 8, y: 7 }, 'blue-fire')
    const qTime = 0.20317
    document.actions.unshift({ id: 'target-blink', type: 'qMove', actorId: receiver.id, startTime: qTime, duration: 0, path: [{ x: 8, y: 7 }, { x: 8, y: 9.3 }] })
    const solved = solvePassReception(document, pass)
    const rules = document.rulesSnapshot
    const pointAt = (time: number) => pointAlongPath(solved.path, passPathProgress(solved.path, time, solved.duration, rules))
    expect(solved.received).toBe(true)
    expect(pointAt(qTime).x).toBeCloseTo(2 + passTravelDistance(qTime, rules), 8)
    expect(pointAt(qTime).y).toBeCloseTo(7, 9)
    expect(distance(pointAt(qTime - 1e-7), pointAt(qTime + 1e-7))).toBeLessThan(0.00001)
    expect(solved.path.at(-1)).toEqual({ x: 8, y: 9.3 })
    expect(pathLength(solved.path)).toBeCloseTo(passTravelDistance(solved.duration, rules), 8)
  })

  it('keeps a Q-start origin binding while homing to a moving teammate', () => {
    const { document, pass, receiver, passer } = setupPass()
    document.actions.unshift(
      { id: 'launch-q', type: 'qMove', actorId: passer.id, startTime: 0, duration: 0, path: [{ x: 2, y: 7 }, { x: 4, y: 7 }] },
      { id: 'run-cross', type: 'move', actorId: receiver.id, startTime: 0, duration: 2, path: [{ x: 6, y: 7 }, { x: 6, y: 9 }] },
    )
    pass.originKeyframe = { playerId: passer.id, actionId: 'launch-q', edge: 'start' }
    const before = solvePassReception(document, pass)
    pass.originKeyframe.edge = 'end'
    const after = solvePassReception(document, pass)
    expect(before.path[0]).toEqual({ x: 2, y: 7 })
    expect(after.path[0]).toEqual({ x: 4, y: 7 })
    expect(before.duration).toBeGreaterThan(after.duration)
    expect(before.path.length).toBeGreaterThan(2)
    expect(after.path.length).toBeGreaterThan(2)
  })

  it('does not catch a Q whose instant jump crosses over the ball', () => {
    const { document, pass, receiver } = setupPass({ x: 8, y: 7 }, 'blue-fire')
    const qTime = 0.4
    document.actions.unshift({ id: 'cross-ball', type: 'qMove', actorId: receiver.id, startTime: qTime, duration: 0, path: [{ x: 8, y: 7 }, { x: 5.7, y: 7 }] })
    const solved = solvePassReception(document, pass)
    expect(solved.received).toBe(true)
    expect(solved.duration).toBeGreaterThan(qTime + 0.1)
    expect(solved.path.at(-1)).toEqual({ x: 5.7, y: 7 })
  })

  it('ignores stale own/later catch boosts, but keeps an earlier independent reception', () => {
    const { document, pass, receiver } = setupPass()
    document.actions.unshift({ id: 'receiver-run', type: 'move', actorId: receiver.id, startTime: 0, duration: 4, path: [{ x: 6, y: 7 }, { x: 10, y: 7 }] })
    const before = solvePassReception(document, pass)
    document.actions.push(
      { id: 'own-receive', type: 'receive', actorId: receiver.id, sourceActionId: pass.id, startTime: 0, duration: 0 },
      { id: 'later-pass', type: 'pass', actorId: 'blue-fire', targetPlayerId: receiver.id, startTime: 0.01, duration: 0, path: [{ x: 5, y: 7 }, { x: 6, y: 7 }] },
      { id: 'later-receive', type: 'receive', actorId: receiver.id, sourceActionId: 'later-pass', startTime: 0.01, duration: 0 },
    )
    expect(solvePassReception(document, pass)).toEqual(before)
    document.actions.unshift({ id: 'prior-pass', type: 'pass', actorId: 'blue-fire', targetPlayerId: receiver.id, startTime: 0, duration: 0, path: [{ x: 6, y: 7 }, { x: 6, y: 7 }] })
    expect(solvePassReception(document, pass).duration).toBeGreaterThan(before.duration)
  })

  it('uses actual frozen and slowed receiver movement without slowing the ball', () => {
    const { document, pass, receiver } = setupPass()
    document.actions.unshift({ id: 'run', type: 'move', actorId: receiver.id, startTime: 0, duration: 4, path: [{ x: 6, y: 7 }, { x: 10, y: 7 }] })
    const normal = solvePassReception(document, pass)
    document.actions.unshift({ id: 'slow', type: 'status', targetId: receiver.id, status: 'slowed', startTime: 0, duration: 7 })
    const slowed = solvePassReception(document, pass)
    expect(slowed.duration).toBeLessThan(normal.duration)
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 6, y: 7 }
    document.rulesSnapshot.roles.ice.q.facingKnockback = 0
    document.actions.unshift({ id: 'freeze', type: 'qMove', actorId: 'red-ice', startTime: 0, duration: 1, path: [{ x: 6, y: 7 }, { x: 6, y: 8 }] })
    const frozen = solvePassReception(document, pass)
    expect(frozen.duration).toBeCloseTo(1 - Math.sqrt(0.5), 8)
    expect(pathLength(frozen.path)).toBeCloseTo(4, 10)
  })

  it('curves toward an ice-Q dash at the projected dash speed', () => {
    const { document, pass, receiver, passer } = setupPass()
    document.actions.unshift({ id: 'dash', type: 'qMove', actorId: receiver.id, startTime: 0, duration: 1, path: [{ x: 6, y: 7 }, { x: 6, y: 10 }] })
    const solved = solvePassReception(document, pass)
    const reference = referencePursuit(passer.position, (time) => ({ x: 6, y: 7 + 3 * time }))
    expect(solved.received).toBe(true)
    expect(Math.abs(solved.duration - reference.duration)).toBeLessThan(0.0002)
    expect(distance(solved.path.at(-1)!, reference.endpoint)).toBeLessThan(0.001)
  })

  it('follows slowed receiver motion inside an enemy ice field, but retains ball speed', () => {
    const { document, pass, receiver, passer } = setupPass()
    const enemy = document.initialScene.players.find((player) => player.id === 'red-ice')!
    enemy.position = { x: 6, y: 7 }
    document.actions.unshift(
      { id: 'field', type: 'eZone', actorId: enemy.id, center: { ...enemy.position }, radius: 2, startTime: 0, duration: 5 },
      { id: 'run-in-field', type: 'move', actorId: receiver.id, startTime: 0, duration: 2, path: [{ x: 6, y: 7 }, { x: 6, y: 9 }] },
    )
    const solved = solvePassReception(document, pass)
    const reference = referencePursuit(passer.position, (time) => ({ x: 6, y: 7 + 0.5 * time }))
    expect(solved.received).toBe(true)
    expect(Math.abs(solved.duration - reference.duration)).toBeLessThan(0.0002)
    expect(distance(solved.path.at(-1)!, reference.endpoint)).toBeLessThan(0.001)
    expect(pathLength(solved.path)).toBeCloseTo(passTravelDistance(solved.duration, document.rulesSnapshot), 8)
  })

  it('does not teleport the ball when the moving receiver is frozen and knocked back', () => {
    const { document, pass, receiver } = setupPass({ x: 8, y: 7 })
    const enemy = document.initialScene.players.find((player) => player.id === 'red-ice')!
    enemy.position = { x: 8, y: 8 }
    document.actions.unshift(
      { id: 'cross-run', type: 'move', actorId: receiver.id, startTime: 0, duration: 2, path: [{ x: 8, y: 7 }, { x: 8, y: 9 }] },
      { id: 'freezing-dash', type: 'qMove', actorId: enemy.id, startTime: 0.1, duration: 1, path: [{ x: 8, y: 8 }, { x: 8, y: 7 }] },
    )
    const hitTime = documentFreezeWindows(document, receiver.id)[0]!.startsAt
    const solved = solvePassReception(document, pass)
    const pointAt = (time: number) => pointAlongPath(solved.path, passPathProgress(solved.path, time, solved.duration, document.rulesSnapshot))
    expect(hitTime).toBeGreaterThan(0)
    expect(hitTime).toBeLessThan(solved.duration)
    expect(distance(pointAt(hitTime - 1e-7), pointAt(hitTime + 1e-7))).toBeLessThan(0.00001)
    const receiverAtCatch = projectFrame({ ...document, actions: document.actions.filter((action) => action.id !== pass.id) }, solved.arrivalTime).players.find((player) => player.id === receiver.id)!
    expect(distance(solved.path.at(-1)!, receiverAtCatch.position)).toBeLessThan(1e-9)
    expect(pathLength(solved.path)).toBeCloseTo(passTravelDistance(solved.duration, document.rulesSnapshot), 8)
  })

  it('is deterministic and bounded when the input contains many event boundaries', () => {
    const { document, pass } = setupPass({ x: 18, y: 7 })
    for (let index = 0; index < 490; index += 1) {
      document.actions.push({ id: `annotation-${index}`, type: 'annotation', text: '', path: [{ x: 1, y: 1 }, { x: 2, y: 2 }], startTime: (index + 0.23) / 500, duration: 0.00047 })
    }
    const began = performance.now()
    const first = solvePassReception(document, pass)
    const duration = performance.now() - began
    expect(first.path.length).toBeLessThanOrEqual(MAX_PASS_PATH_POINTS)
    expect(first.path).toHaveLength(2)
    expect(pathLength(first.path)).toBeCloseTo(8, 9)
    expect(solvePassReception(document, pass)).toEqual(first)
    expect(duration).toBeLessThan(500)
  })
})
