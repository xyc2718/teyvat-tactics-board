import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import { projectFrame } from '../timeline/projectFrame'
import { classifyPassThreat } from './passThreat'

function movePlayer(document: ReturnType<typeof createDefaultDocument>, id: string, x: number, y: number) {
  const player = document.initialScene.players.find((candidate) => candidate.id === id)!
  player.position = { x, y }
}

describe('pass threat classification', () => {
  it('splits exact configured safe and over-max distance boundaries', () => {
    const document = createDefaultDocument()
    const frame = projectFrame(document, 0)
    const segments = classifyPassThreat(
      [{ x: 0, y: 1 }, { x: 10, y: 1 }],
      'blue',
      frame,
      document.rulesSnapshot,
    )

    expect(segments[0]).toMatchObject({ level: 'safe', startDistance: 0, endDistance: 4 })
    expect(segments.at(-1)).toMatchObject({ level: 'drop', startDistance: 8, endDistance: 10 })
  })

  it('distinguishes one Q-reachable opponent, multiple Q opponents, and a direct corridor', () => {
    const document = createDefaultDocument()
    movePlayer(document, 'red-water', 10.5, 7)
    movePlayer(document, 'red-fire', 20, 0)
    movePlayer(document, 'red-ice', 20, 10)
    const path = [{ x: 5.5, y: 5 }, { x: 13.5, y: 5 }]

    let frame = projectFrame(document, 0)
    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'qSingle')).toBe(true)

    movePlayer(document, 'red-fire', 10.5, 6.8)
    frame = projectFrame(document, 0)
    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'qMultiple')).toBe(true)

    movePlayer(document, 'red-water', 10.5, 5.2)
    frame = projectFrame(document, 0)
    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'direct')).toBe(true)
  })

  it('uses Q cooldown and the configured corridor width without a reaction-time input', () => {
    const document = createDefaultDocument()
    movePlayer(document, 'red-water', 11.5, 5.6)
    movePlayer(document, 'red-fire', 20, 0)
    movePlayer(document, 'red-ice', 20, 10)
    document.rulesSnapshot.passing.interceptStartWidth = 0.1
    document.rulesSnapshot.passing.interceptEndWidth = 0.1
    const frame = projectFrame(document, 0)
    frame.cooldowns['red-water']!.q = 5
    const path = [{ x: 5.5, y: 5 }, { x: 13.5, y: 5 }]

    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'baseRisk')).toBe(true)
    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'direct')).toBe(false)

    document.rulesSnapshot.passing.interceptStartWidth = 1
    document.rulesSnapshot.passing.interceptEndWidth = 1
    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'direct')).toBe(true)
  })

  it('preserves every corner and the final endpoint of a multi-point path', () => {
    const document = createDefaultDocument()
    const frame = projectFrame(document, 0)
    const corner = { x: 3.13, y: 1.07 }
    const path = [{ x: 0, y: 1.07 }, corner, { x: 3.13, y: 6.42 }, { x: 8.9, y: 6.42 }]
    const segments = classifyPassThreat(path, 'blue', frame, document.rulesSnapshot)
    const renderedPoints = segments.flatMap((segment) => segment.path)

    expect(renderedPoints).toContainEqual(corner)
    expect(segments[0]?.path[0]).toEqual(path[0])
    expect(segments.at(-1)?.path.at(-1)).toEqual(path.at(-1))
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]?.path[0]).toEqual(segments[index - 1]?.path.at(-1))
    }
  })

  it('handles zero-length and very short paths without inventing extra segments', () => {
    const document = createDefaultDocument()
    const frame = projectFrame(document, 0)
    expect(classifyPassThreat([{ x: 1, y: 1 }, { x: 1, y: 1 }], 'blue', frame, document.rulesSnapshot)).toEqual([])

    const short = classifyPassThreat([{ x: 1, y: 1 }, { x: 1.03, y: 1 }], 'blue', frame, document.rulesSnapshot)
    expect(short).toHaveLength(1)
    expect(short[0]).toMatchObject({ level: 'safe', startDistance: 0 })
    expect(short[0]?.endDistance).toBeCloseTo(0.03)
  })

  it('uses the projected frame, passer team, and configured Q range', () => {
    const document = createDefaultDocument()
    movePlayer(document, 'red-water', 10, 7)
    movePlayer(document, 'red-fire', 20, 0)
    movePlayer(document, 'red-ice', 20, 10)
    const path = [{ x: 5.5, y: 5 }, { x: 13.5, y: 5 }]

    let frame = projectFrame(document, 0)
    document.rulesSnapshot.roles.water.q.maxDistance = 0.1
    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'qSingle')).toBe(false)
    document.rulesSnapshot.roles.water.q.maxDistance = 3
    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'qSingle')).toBe(true)

    document.actions.push({
      id: 'red-step-in',
      type: 'move',
      actorId: 'red-water',
      startTime: 0,
      duration: 2,
      path: [{ x: 10, y: 7 }, { x: 10, y: 5.2 }],
    })
    frame = projectFrame(document, 2)
    expect(classifyPassThreat(path, 'blue', frame, document.rulesSnapshot).some((segment) => segment.level === 'direct')).toBe(true)
    expect(classifyPassThreat(path, 'red', frame, document.rulesSnapshot).some((segment) => segment.opponentIds.includes('red-water'))).toBe(false)
  })
})
