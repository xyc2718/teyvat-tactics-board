import { describe, expect, it } from 'vitest'
import { createInitialScene } from './createDocument'

describe('default formation', () => {
  it('places each fire player centrally near their own goal with water and ice ahead on both sides', () => {
    const scene = createInitialScene()
    const positions = Object.fromEntries(scene.players.map((player) => [player.id, player.position]))

    expect(positions).toMatchObject({
      'blue-fire': { x: 3.5, y: 7 },
      'blue-water': { x: 5.5, y: 4.7 },
      'blue-ice': { x: 5.5, y: 9.3 },
      'red-fire': { x: 16.5, y: 7 },
      'red-water': { x: 14.5, y: 4.7 },
      'red-ice': { x: 14.5, y: 9.3 },
    })
    expect(scene.ball).toMatchObject({ carrierId: 'blue-water', position: { x: 5.85, y: 4.7 } })
  })
})
