import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import { evaluatePlayerSituation } from './playerSituation'

describe('player possession and loose-ball situation', () => {
  it('uses the carrier team to assign attacker and defender roles', () => {
    const document = createDefaultDocument()
    const selected = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const carrier = document.initialScene.players.find((player) => player.id === 'red-fire')!
    selected.position = { x: 10, y: 7 }
    carrier.position = { x: 11, y: 7 }
    document.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 18, y: 3 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 18, y: 11 }
    for (const player of document.initialScene.players) player.hasBall = player.id === carrier.id
    document.initialScene.ball = { carrierId: carrier.id, position: { ...carrier.position }, isFree: false }

    const result = evaluatePlayerSituation(document, 0, selected.id)

    expect(result).toMatchObject({
      kind: 'matchup',
      possessionSource: 'carrier',
      selectedPerspective: 'defending',
      attacker: { id: carrier.id },
      defender: { id: selected.id },
    })
  })

  it('treats a grounded free ball as a race and includes available Q movement', () => {
    const document = createDefaultDocument()
    const selected = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    selected.position = { x: 3.5, y: 4.7 }
    document.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 9.8, y: 4.7 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 18, y: 2 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 18, y: 12 }
    for (const player of document.initialScene.players) player.hasBall = false
    document.initialScene.ball = { carrierId: null, position: { x: 5.8, y: 4.7 }, isFree: true }

    const result = evaluatePlayerSituation(document, 0, selected.id)

    expect(result).toMatchObject({
      kind: 'looseBall',
      outcome: 'ahead',
      selectedArrival: { player: { id: selected.id }, mode: 'q', earliestTime: 0 },
      opponentArrival: { player: { id: 'red-water' }, mode: 'q' },
    })
    if (result?.kind !== 'looseBall') throw new Error('Expected loose-ball situation')
    expect(result.opponentArrival.earliestTime).toBeCloseTo(1.5)
    expect(result.margin).toBeCloseTo(1.5)
  })

  it('keeps the passer team attacking while a valid pass is still flying', () => {
    const document = createDefaultDocument()
    const defender = document.initialScene.players.find((player) => player.id === 'red-fire')!
    const passer = document.initialScene.players.find((player) => player.id === 'blue-water')!
    defender.position = { x: 9, y: 7 }
    document.actions.push({
      id: 'flying-pass',
      type: 'pass',
      actorId: passer.id,
      path: [{ ...passer.position }, { x: 11.5, y: 7 }],
      startTime: 0,
      duration: 0.75,
    })

    const result = evaluatePlayerSituation(document, 0.5, defender.id)

    expect(result).toMatchObject({
      kind: 'matchup',
      possessionSource: 'pass',
      offenseTeam: 'blue',
      selectedPerspective: 'defending',
      defender: { id: defender.id },
    })
  })

  it('starts the loose-ball race once an over-distance pass reaches its maximum range', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'over-distance-pass',
      type: 'pass',
      actorId: 'blue-water',
      path: [{ x: 5.5, y: 7 }, { x: 17.5, y: 7 }],
      startTime: 0,
      duration: 1,
    })

    const result = evaluatePlayerSituation(document, 1.2, 'red-water')

    expect(result?.kind).toBe('looseBall')
  })
})
