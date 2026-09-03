import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { parseTactic, serializeTactic } from './tacticFile'

describe('tactic file boundary', () => {
  it('creates a centered 20 by 14 default field', () => {
    const document = createDefaultDocument()
    expect(document.rulesSnapshot).toMatchObject({ version: 'teyvat-mvp-2', field: { width: 20, height: 14 } })
    expect(document.initialScene.players.find((player) => player.id === 'blue-fire')?.position.y).toBe(7)
    expect(document.initialScene.ball.position.y).toBe(4.7)
  })

  it('migrates an untouched legacy 20 by 10 field by translating every saved Y coordinate', () => {
    const legacy = createDefaultDocument()
    legacy.rulesSnapshot.version = 'teyvat-mvp-1'
    legacy.rulesSnapshot.field.height = 10
    const shiftSceneBack = (scene: typeof legacy.initialScene) => {
      scene.players.forEach((player) => { player.position.y -= 2 })
      scene.ball.position.y -= 2
    }
    shiftSceneBack(legacy.initialScene)
    legacy.stepMarkers.forEach((step) => shiftSceneBack(step.snapshot))
    legacy.staticMoveArrows.push({ id: 'legacy-arrow', playerId: 'blue-fire', target: { x: 6, y: 6 } })
    legacy.actions.push({
      id: 'legacy-curve',
      type: 'move',
      actorId: 'blue-fire',
      startTime: 0,
      duration: 2,
      path: [{ x: 3.5, y: 2.7 }, { x: 5.5, y: 4 }],
      curveControl: { x: 4.5, y: 2 },
    })

    const result = parseTactic(serializeTactic(legacy))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.rulesSnapshot).toMatchObject({ version: 'teyvat-mvp-2', field: { width: 20, height: 14 } })
    expect(result.document.initialScene.players.find((player) => player.id === 'blue-water')?.position.y).toBe(4.7)
    expect(result.document.staticMoveArrows[0]?.target.y).toBe(8)
    expect(result.document.actions[0]).toMatchObject({
      path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 6 }],
      curveControl: { x: 4.5, y: 4 },
    })
  })

  it('keeps a non-default legacy field height unchanged', () => {
    const custom = createDefaultDocument()
    custom.rulesSnapshot.version = 'teyvat-mvp-1'
    custom.rulesSnapshot.field.height = 12

    const result = parseTactic(serializeTactic(custom))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.document.rulesSnapshot).toMatchObject({ version: 'teyvat-mvp-1', field: { height: 12 } })
  })

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

  it('round-trips fixed and other-player keyframe move timing constraints', () => {
    const source = createDefaultDocument()
    source.actions.push(
      {
        id: 'reference-run', type: 'move', actorId: 'red-fire', startTime: 0, duration: 4,
        path: [{ x: 16.5, y: 7 }, { x: 12.5, y: 7 }], timingConstraint: { kind: 'fixed' },
      },
      {
        id: 'aligned-run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 4,
        path: [{ x: 3.5, y: 7 }, { x: 7.5, y: 7 }],
        timingConstraint: {
          kind: 'keyframe',
          reference: { playerId: 'red-fire', actionId: 'reference-run', edge: 'end' },
        },
      },
    )

    const result = parseTactic(serializeTactic(source))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.document.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'reference-run', timingConstraint: { kind: 'fixed' } }),
      expect.objectContaining({
        id: 'aligned-run',
        timingConstraint: {
          kind: 'keyframe',
          reference: { playerId: 'red-fire', actionId: 'reference-run', edge: 'end' },
        },
      }),
    ]))
  })

  it('rejects dangling and same-player keyframe move timing references', () => {
    const dangling = createDefaultDocument()
    dangling.actions.push({
      id: 'dangling-run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2,
      path: [{ x: 3.5, y: 7 }, { x: 5.5, y: 7 }],
      timingConstraint: {
        kind: 'keyframe',
        reference: { playerId: 'red-fire', actionId: 'missing-action', edge: 'end' },
      },
    })
    expect(parseTactic(serializeTactic(dangling))).toMatchObject({ ok: false })

    const samePlayer = createDefaultDocument()
    samePlayer.actions.push(
      {
        id: 'same-source', type: 'wait', actorId: 'blue-fire', startTime: 2, duration: 1,
      },
      {
        id: 'same-player-run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2,
        path: [{ x: 3.5, y: 7 }, { x: 5.5, y: 7 }],
        timingConstraint: {
          kind: 'keyframe',
          reference: { playerId: 'blue-fire', actionId: 'same-source', edge: 'start' },
        },
      },
    )
    expect(parseTactic(serializeTactic(samePlayer))).toMatchObject({ ok: false })
  })

  it('adds an empty static-arrow collection when importing an older V1 file', () => {
    const legacy = createDefaultDocument() as unknown as Record<string, unknown>
    delete legacy.staticMoveArrows
    const result = parseTactic(JSON.stringify(legacy))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.document.staticMoveArrows).toEqual([])
  })

  it('restores fixed fire-Q semantics when importing an older V1 rule snapshot', () => {
    const legacy = createDefaultDocument() as unknown as {
      rulesSnapshot: { roles: Record<'water' | 'fire' | 'ice', { q: Record<string, unknown> }> }
    }
    delete legacy.rulesSnapshot.roles.water.q.fixedDistance
    delete legacy.rulesSnapshot.roles.fire.q.fixedDistance
    delete legacy.rulesSnapshot.roles.ice.q.fixedDistance

    const result = parseTactic(JSON.stringify(legacy))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.rulesSnapshot.roles.water.q.fixedDistance).toBe(false)
    expect(result.document.rulesSnapshot.roles.fire.q.fixedDistance).toBe(true)
    expect(result.document.rulesSnapshot.roles.ice.q.fixedDistance).toBe(false)
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

  it('round-trips a complete follow contract and rejects broken or circular references', () => {
    const source = createDefaultDocument()
    source.actions.push(
      {
        id: 'saved-target-run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 4,
        path: [{ x: 3.5, y: 7 }, { x: 7.5, y: 7 }],
      },
      {
        id: 'saved-follow', type: 'move', actorId: 'red-fire', startTime: 0, duration: 4,
        path: [{ x: 16.5, y: 7 }, { x: 7.5, y: 7 }], targetPlayerId: 'blue-fire',
        syncActionId: 'saved-target-run', followGap: 1,
      },
    )
    const parsed = parseTactic(serializeTactic(source))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.document.actions[1]).toMatchObject({
      targetPlayerId: 'blue-fire', syncActionId: 'saved-target-run', followGap: 1,
    })

    const incomplete = structuredClone(source)
    const incompleteFollow = incomplete.actions[1]
    if (incompleteFollow?.type === 'move') delete incompleteFollow.syncActionId
    expect(parseTactic(JSON.stringify(incomplete)).ok).toBe(false)

    const circular = structuredClone(source)
    const targetRun = circular.actions[0]
    if (targetRun?.type === 'move') {
      targetRun.targetPlayerId = 'red-fire'
      targetRun.syncActionId = 'saved-follow'
      targetRun.followGap = 1
    }
    expect(parseTactic(JSON.stringify(circular)).ok).toBe(false)
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
