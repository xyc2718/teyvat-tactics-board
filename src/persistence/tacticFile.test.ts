import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { parseTactic, serializeTactic } from './tacticFile'

describe('tactic file boundary', () => {
  it('round-trips a V1 document with its rule snapshot', () => {
    const source = createDefaultDocument()
    source.meta.title = '冻射演示'
    source.rulesSnapshot.passing.maxDistance = 7.75
    source.staticMoveArrows.push({ id: 'basic-blue-water', playerId: 'blue-water', target: { x: 9, y: 4 } })
    const result = parseTactic(serializeTactic(source))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.document.meta.title).toBe('冻射演示')
      expect(result.document.rulesSnapshot.passing.maxDistance).toBe(7.75)
      expect(result.document.rulesSnapshot.roles.water.attackInnerRadius).toBe(0.2)
      expect(result.document.rulesSnapshot.roles.ice.e?.slowMultiplier).toBe(0.5)
      expect(result.document.rulesSnapshot.roles.ice.e?.qDistanceMultiplier).toBe(0.7)
      expect(result.document.staticMoveArrows).toEqual(source.staticMoveArrows)
      expect(result.document.schemaVersion).toBe(1)
    }
  })

  it('adds an empty static-arrow collection when importing an older V1 file', () => {
    const legacy = createDefaultDocument() as unknown as Record<string, unknown>
    delete legacy.staticMoveArrows
    const result = parseTactic(JSON.stringify(legacy))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.document.staticMoveArrows).toEqual([])
  })

  it('defaults legacy ice-zone speed and Q rules and rejects multipliers above normal', () => {
    const legacy = createDefaultDocument() as unknown as { rulesSnapshot: { roles: { ice: { e?: Record<string, unknown> } } } }
    delete legacy.rulesSnapshot.roles.ice.e?.slowMultiplier
    delete legacy.rulesSnapshot.roles.ice.e?.qDistanceMultiplier
    const parsed = parseTactic(JSON.stringify(legacy))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.document.rulesSnapshot.roles.ice.e?.slowMultiplier).toBe(0.5)
      expect(parsed.document.rulesSnapshot.roles.ice.e?.qDistanceMultiplier).toBe(0.7)
    }

    const invalid = createDefaultDocument()
    invalid.rulesSnapshot.roles.ice.e!.slowMultiplier = 1.1
    expect(parseTactic(JSON.stringify(invalid)).ok).toBe(false)
    invalid.rulesSnapshot.roles.ice.e!.slowMultiplier = 0.5
    invalid.rulesSnapshot.roles.ice.e!.qDistanceMultiplier = 1.1
    expect(parseTactic(JSON.stringify(invalid)).ok).toBe(false)
  })

  it('rejects duplicate, missing-player and out-of-field static arrows', () => {
    const duplicate = createDefaultDocument()
    duplicate.staticMoveArrows = [
      { id: 'one', playerId: 'blue-water', target: { x: 8, y: 5 } },
      { id: 'two', playerId: 'blue-water', target: { x: 9, y: 5 } },
    ]
    expect(parseTactic(JSON.stringify(duplicate)).ok).toBe(false)

    const missing = createDefaultDocument()
    missing.staticMoveArrows = [{ id: 'missing', playerId: 'unknown', target: { x: 8, y: 5 } }]
    expect(parseTactic(JSON.stringify(missing)).ok).toBe(false)

    const outside = createDefaultDocument()
    outside.staticMoveArrows = [{ id: 'outside', playerId: 'blue-water', target: { x: 21, y: 5 } }]
    expect(parseTactic(JSON.stringify(outside)).ok).toBe(false)
  })

  it('preserves legacy attack actions used by shot-interruption playback', () => {
    const source = createDefaultDocument()
    source.actions.push({
      id: 'legacy-attack',
      type: 'attack',
      actorId: 'red-fire',
      targetId: 'blue-water',
      startTime: 0.5,
      duration: 0,
    })

    const result = parseTactic(serializeTactic(source))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.document.actions[0]).toEqual(source.actions[0])
  })

  it('round-trips an optional adjustable run curve while keeping straight V1 moves valid', () => {
    const source = createDefaultDocument()
    source.actions.push({
      id: 'curved-move', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2.2,
      path: [{ x: 3.5, y: 2.7 }, { x: 5.5, y: 2.7 }], curveControl: { x: 4.5, y: 3.7 },
    })
    const parsed = parseTactic(serializeTactic(source))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.document.actions[0]).toEqual(source.actions[0])

    const outside = structuredClone(source)
    const move = outside.actions[0]
    if (move?.type === 'move') move.curveControl = { x: 21, y: 5 }
    expect(parseTactic(JSON.stringify(outside)).ok).toBe(false)
  })

  it('rejects unknown versions and malformed content without replacing data', () => {
    expect(parseTactic('{"schemaVersion":2}')).toEqual({ ok: false, error: '暂不支持战术文件版本 2。' })
    expect(parseTactic('not json').ok).toBe(false)
  })

  it('rejects negative or non-finite step and action times at the file boundary', () => {
    const negativeAction = createDefaultDocument()
    negativeAction.actions.push({ id: 'negative', type: 'wait', startTime: -1, duration: 0 })
    expect(parseTactic(JSON.stringify(negativeAction)).ok).toBe(false)

    const negativeStep = createDefaultDocument()
    negativeStep.stepMarkers[0]!.time = -1
    expect(parseTactic(JSON.stringify(negativeStep)).ok).toBe(false)

    const nonFiniteAction = createDefaultDocument()
    nonFiniteAction.actions.push({ id: 'non-finite', type: 'wait', startTime: 1, duration: 0 })
    const source = serializeTactic(nonFiniteAction).replace('"startTime": 1', '"startTime": 1e999')
    expect(parseTactic(source).ok).toBe(false)
  })

  it('sanitizes user-visible text on import', () => {
    const source = createDefaultDocument()
    source.meta.title = '<b>战术</b>'
    const result = parseTactic(JSON.stringify(source))
    expect(result.ok && result.document.meta.title).toBe('b战术/b')
  })

  it('normalizes imported facings and rejects non-finite facings', () => {
    const source = createDefaultDocument()
    source.initialScene.players[0]!.facing = -90
    source.stepMarkers[0]!.snapshot.players[0]!.facing = 721
    const normalized = parseTactic(serializeTactic(source))
    expect(normalized.ok).toBe(true)
    if (normalized.ok) {
      expect(normalized.document.initialScene.players[0]?.facing).toBe(270)
      expect(normalized.document.stepMarkers[0]?.snapshot.players[0]?.facing).toBe(1)
    }

    const nonFinite = serializeTactic(createDefaultDocument()).replace('"facing": 0', '"facing": 1e999')
    expect(parseTactic(nonFinite).ok).toBe(false)
  })

  it('rejects broken player references and inconsistent possession state', () => {
    const brokenAction = createDefaultDocument()
    brokenAction.actions.push({ id: 'bad', type: 'receive', actorId: 'missing-player', startTime: 1, duration: 0 })
    expect(parseTactic(JSON.stringify(brokenAction)).ok).toBe(false)

    const brokenBall = createDefaultDocument()
    brokenBall.initialScene.ball.carrierId = 'blue-fire'
    expect(parseTactic(JSON.stringify(brokenBall)).ok).toBe(false)
  })
})
