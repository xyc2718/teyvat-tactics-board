import { describe, expect, it } from 'vitest'
import type { PlayerState, QMoveAction } from '../model/types'
import { cloneDefaultRules } from './defaultRules'
import { analyzeIceQHits } from './iceQHits'

function player(id: string, team: 'blue' | 'red', x: number, y: number): PlayerState {
  return { id, name: id, team, role: team === 'blue' ? 'ice' : 'water', position: { x, y }, facing: 0, hasBall: false }
}

describe('ice Q hit analysis', () => {
  it('finds multiple opponents across every segment, including a grazing hit', () => {
    const actor = player('ice', 'blue', 0, 0)
    const action: QMoveAction = {
      id: 'corner-q', type: 'qMove', actorId: actor.id, targetId: 'missed-legacy-target', startTime: 2, duration: 1,
      path: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }],
    }
    const hits = analyzeIceQHits(action, actor, [
      actor,
      player('first', 'red', 1.5, 0.5),
      player('second', 'red', 3.5, 2),
      player('safe', 'red', 5, 5),
    ], cloneDefaultRules())

    expect(hits.map((hit) => hit.targetId)).toEqual(['first', 'second'])
    expect(hits[0]?.distance).toBeCloseTo(0.5)
    expect(hits[0]?.pathProgress).toBeCloseTo(0.25)
    expect(hits[0]?.hitTime).toBeCloseTo(2.25)
    expect(hits[1]?.closestPoint).toEqual({ x: 3, y: 2 })
    expect(hits[1]?.hitTime).toBeCloseTo(2 + 5 / 6)
  })

  it('returns no hits when the complete path misses', () => {
    const actor = player('ice', 'blue', 0, 0)
    const action: QMoveAction = { id: 'miss', type: 'qMove', actorId: actor.id, startTime: 0, duration: 1, path: [{ x: 0, y: 0 }, { x: 3, y: 0 }] }
    expect(analyzeIceQHits(action, actor, [actor, player('safe', 'red', 1, 1)], cloneDefaultRules())).toEqual([])
  })
})
