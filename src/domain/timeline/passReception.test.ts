import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { PassAction } from '../model/types'
import { solvePassReception } from './passReception'
import { projectFrame } from './projectFrame'

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
    expect(solved.path[0]).toEqual({ x: 5.5, y: 7 })
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
    expect(solved.path.at(-1)).toEqual(receiver.position)
  })
})
