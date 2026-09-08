import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { BASIC_ROLE_IDS, effectiveBasicRole } from '../domain/model/basicRoles'
import { MAX_PASS_PATH_POINTS } from '../domain/model/passFlight'
import { defaultRules } from '../domain/rules/defaultRules'
import { loadDraft, parseTactic, saveDraft, serializeTactic } from './tacticFile'
import { createBallPickupAction, normalizeBallActions } from '../domain/timeline/looseBall'

describe('tactic file boundary', () => {
  it('adds only missing Geo rules and matchups to a legacy V1 snapshot, including draft recovery', () => {
    const document = createDefaultDocument()
    document.rulesSnapshot.roles.fire.q.maxDistance = 4.6
    document.rulesSnapshot.roles.water.attackRadius = 0
    document.rulesSnapshot.roles.water.attackInnerRadius = 0
    document.rulesSnapshot.passing.ballSpeed = 8
    document.rulesSnapshot.matchups.water.fire = null
    document.rulesSnapshot.matchups.ice.water = 0
    document.basicPlayerRoles = { 'blue-water': 'geo' }
    document.actions.push({ id: 'saved-wait', type: 'wait', actorId: 'blue-fire', startTime: 1, duration: 2 })
    const expected = { ...structuredClone(document), meta: { ...document.meta, updatedAt: expect.any(String) } }
    Reflect.deleteProperty(document.rulesSnapshot.roles, 'geo')
    Reflect.deleteProperty(document.rulesSnapshot.matchups, 'geo')
    for (const row of Object.values(document.rulesSnapshot.matchups)) Reflect.deleteProperty(row, 'geo')

    const parsed = parseTactic(serializeTactic(document))
    if (!parsed.ok) throw Error(parsed.error)
    expect(parsed.document).toEqual(expected)
    saveDraft(document)
    expect(loadDraft()).toEqual(expected)
    parsed.document.rulesSnapshot.roles.geo.q.maxDistance = 5
    parsed.document.rulesSnapshot.roles.geo.shield!.radius = 2
    parsed.document.rulesSnapshot.matchups.geo.water = 2
    expect(defaultRules.roles.geo.q.maxDistance).toBe(2.4)
    expect(defaultRules.roles.geo.shield?.radius).toBe(1)
    expect(defaultRules.matchups.geo.water).toBe(0)
    const second = parseTactic(serializeTactic(document))
    if (!second.ok) throw Error(second.error)
    expect(second.document).toEqual(expected)
  })

  it('fills partial Geo matchup defaults while preserving explicit neutral and null values', () => {
    const document = createDefaultDocument()
    document.rulesSnapshot.matchups.geo.water = null
    document.rulesSnapshot.matchups.geo.fire = 0
    document.rulesSnapshot.matchups.fire.geo = null
    Reflect.deleteProperty(document.rulesSnapshot.matchups.geo, 'ice')
    Reflect.deleteProperty(document.rulesSnapshot.matchups.geo, 'geo')
    Reflect.deleteProperty(document.rulesSnapshot.matchups.water, 'geo')
    const parsed = parseTactic(serializeTactic(document))
    if (!parsed.ok) throw Error(parsed.error)
    expect(parsed.document.rulesSnapshot.matchups).toMatchObject({
      water: { geo: -1 }, fire: { geo: null }, ice: { geo: 0 },
      geo: { water: null, fire: 0, ice: 1, geo: 0 },
    })
    const roundTrip = parseTactic(serializeTactic(parsed.document))
    if (!roundTrip.ok) throw Error(roundTrip.error)
    expect(roundTrip.document.rulesSnapshot).toEqual(parsed.document.rulesSnapshot)
  })

  it('round-trips explicit custom Geo parameters, player roles and independent basic identities', () => {
    const document = createDefaultDocument()
    document.rulesSnapshot.roles.geo = {
      id: 'geo', label: '自定义岩', shortLabel: '岩', attackRadius: 0,
      q: { kind: 'blink', maxDistance: 3.25, fixedDistance: false, cooldown: 0, duration: 0, turnable: true },
      shield: { radius: 1.75 },
    }
    document.initialScene.players[0]!.role = 'geo'
    document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
    document.basicPlayerRoles = { 'blue-water': 'electro' }
    const parsed = parseTactic(serializeTactic(document))
    if (!parsed.ok) throw Error(parsed.error)
    expect(parsed.document).toEqual({ ...document, meta: { ...document.meta, updatedAt: expect.any(String) } })
    delete document.rulesSnapshot.roles.geo.shield
    const withoutShield = parseTactic(serializeTactic(document))
    if (!withoutShield.ok) throw Error(withoutShield.error)
    expect(withoutShield.document.rulesSnapshot.roles.geo.shield).toBeUndefined()
  })

  it.each([
    ['role', null], ['role', {}], ['shield', null], ['shield', {}],
    ['shield', { radius: 0 }], ['shield', { radius: -1 }], ['shield', { radius: Infinity }],
    ['shield', { radius: '1' }], ['shield', { radius: 1, cooldown: 0 }],
    ['row', null], ['row', []], ['rating', 3], ['rating', '0'],
  ])('rejects malformed explicit Geo %s data without defaulting it (%j)', (field, value) => {
    const document = createDefaultDocument()
    if (field === 'role') Object.assign(document.rulesSnapshot.roles, { geo: value })
    if (field === 'shield') Object.assign(document.rulesSnapshot.roles.geo, { shield: value })
    if (field === 'row') Object.assign(document.rulesSnapshot.matchups, { geo: value })
    if (field === 'rating') Object.assign(document.rulesSnapshot.matchups.geo, { fire: value })
    const parsed = parseTactic(serializeTactic(document))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('geo')
  })

  it('still requires the original role and matchup data in a legacy file', () => {
    const document = createDefaultDocument()
    Reflect.deleteProperty(document.rulesSnapshot.matchups.water, 'fire')
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    document.rulesSnapshot.matchups.water.fire = -2
    Reflect.deleteProperty(document.rulesSnapshot.roles, 'ice')
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
  })

  it.each([8, 6.5])('preserves legacy/custom ordinary pass calibration %s without adding a loose-pass block', (speed) => {
    const document = createDefaultDocument()
    document.rulesSnapshot.passing.ballSpeed = speed
    const parsed = parseTactic(serializeTactic(document))
    if (!parsed.ok) throw Error(parsed.error)
    expect(parsed.document.rulesSnapshot.passing.ballSpeed).toBe(speed)
    expect(parsed.document.rulesSnapshot.loosePassing).toBeUndefined()
  })

  it('round-trips an empty flight, pickup trace and generated receive without recalibrating the old pass rule', () => {
    const document = createDefaultDocument()
    document.rulesSnapshot.passing.ballSpeed = 8
    document.actions.push({ id: 'throw', type: 'loosePass', actorId: 'blue-water', aimDirection: { x: 1, y: 0 },
      startTime: 0, duration: 3, path: [{ x: 5.5, y: 4.7 }, { x: 11.5, y: 4.7 }], flightOutcome: 'grounded' })
    normalizeBallActions(document)
    const pickup = createBallPickupAction(document, 'blue-fire', 3, 'move', 'pickup')
    if (!pickup.ok) throw Error(pickup.message)
    document.actions.push(pickup.action)
    normalizeBallActions(document)
    const parsed = parseTactic(serializeTactic(document))
    if (!parsed.ok) throw Error(parsed.error)
    expect(parsed.document.actions).toEqual(document.actions)
    expect(parsed.document.rulesSnapshot.passing.ballSpeed).toBe(8)
    expect(parsed.document.rulesSnapshot.loosePassing).toEqual({ maxDistance: 6, maxDuration: 3 })
  })

  it.each(['unknown-source', 'conflicting-constraint', 'forged-receive', 'cycle', 'nonmonotonic-trace'])('rejects invalid pickup contracts: %s', (variant) => {
    const document = createDefaultDocument()
    document.initialScene.ball = { position: { x: 6, y: 4.7 }, carrierId: null, isFree: true }
    document.initialScene.players.forEach((player) => { player.hasBall = false })
    document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
    const pickup = createBallPickupAction(document, 'blue-water', 0, 'move', 'pickup')
    if (!pickup.ok || pickup.action.type !== 'move') throw Error('fixture')
    document.actions.push(pickup.action)
    normalizeBallActions(document)
    if (variant === 'unknown-source') pickup.action.ballTarget = { sourceActionId: 'missing' }
    if (variant === 'conflicting-constraint') pickup.action.timingConstraint = { kind: 'fixed' }
    if (variant === 'forged-receive') document.actions.find((action) => action.type === 'receive')!.duration = 1
    if (variant === 'nonmonotonic-trace') pickup.action.pickupTrace![1]!.time = 0
    if (variant === 'cycle') {
      pickup.action.ballTarget = { sourceActionId: 'throw' }
      document.actions = document.actions.filter((action) => action.type !== 'receive')
      document.actions.push({ id: 'throw', type: 'loosePass', actorId: 'blue-water', aimDirection: { x: 1, y: 0 }, originPickupActionId: 'pickup',
        startTime: 0, duration: 3, path: [{ x: 5.5, y: 4.7 }, { x: 11.5, y: 4.7 }], flightOutcome: 'grounded' })
    }
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
  })
  it('round-trips all six basic identities while accepting old V1 files without overrides', () => {
    const source = createDefaultDocument()
    const legacy = parseTactic(serializeTactic(source))
    expect(legacy.ok).toBe(true)
    if (!legacy.ok) throw new Error(legacy.error)
    expect(legacy.document.basicPlayerRoles).toBeUndefined()
    legacy.document.initialScene.players.forEach((player) => {
      expect(effectiveBasicRole(legacy.document, player)).toBe(player.role)
    })
    source.basicPlayerRoles = Object.fromEntries(source.initialScene.players.map((player, index) => [player.id, BASIC_ROLE_IDS[index]!]))
    const parsed = parseTactic(serializeTactic(source))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.document.basicPlayerRoles).toEqual(source.basicPlayerRoles)
    expect(parsed.document.initialScene).toEqual(source.initialScene)
    expect(parsed.document.rulesSnapshot).toEqual(source.rulesSnapshot)
  })

  it.each([
    { 'blue-water': 'dendro' },
    { 'unknown-player': 'geo' },
    Object.fromEntries([['__proto__', 'electro']]),
    { constructor: 'anemo' },
    Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`player-${index}`, 'anemo'])),
    ['electro'], null, { 'blue-water': 3 },
  ])('rejects invalid basic role overrides: %j', (basicPlayerRoles) => {
    const result = parseTactic(JSON.stringify({ ...createDefaultDocument(), basicPlayerRoles }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/basicPlayerRoles|基础角色/)
  })

  it('rejects unsupported simulation identities and mismatched role-rule IDs', () => {
    const source = createDefaultDocument()
    expect(parseTactic(serializeTactic(source).replace('"role": "water"', '"role": "electro"')).ok).toBe(false)
    expect(parseTactic(serializeTactic(source).replace('"id": "water"', '"id": "anemo"')).ok).toBe(false)
    expect(parseTactic(serializeTactic(source).replace('"id": "water"', '"id": "geo"')).ok).toBe(false)
  })

  it('round-trips bounded dense pass paths with explicit outcomes and accepts legacy passes', () => {
    const source = createDefaultDocument()
    source.actions.push({
      id: 'curved-pass', type: 'pass', actorId: 'blue-fire', targetPlayerId: 'blue-ice',
      flightOutcome: 'dropped', startTime: 0, duration: 1,
      path: Array.from({ length: MAX_PASS_PATH_POINTS }, (_, index) => ({ x: index / MAX_PASS_PATH_POINTS, y: 4 })),
    })
    const result = parseTactic(serializeTactic(source))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.document.actions).toEqual(source.actions)
    const pass = source.actions[0]
    if (pass?.type !== 'pass') throw new Error('Missing pass')
    pass.path.push({ x: 2, y: 4 })
    expect(parseTactic(serializeTactic(source)).ok).toBe(false)
    pass.path = [{ x: 1, y: 4 }, { x: 6, y: 4 }]
    delete pass.flightOutcome
    expect(parseTactic(serializeTactic(source)).ok).toBe(true)
    expect(parseTactic(serializeTactic(source).replace('"type": "pass"', '"type": "pass", "flightOutcome": "unknown"')).ok).toBe(false)
    pass.flightOutcome = 'received'
    delete pass.targetPlayerId
    expect(parseTactic(serializeTactic(source)).ok).toBe(false)
  })

  it('creates a centered 20 by 14 default field', () => {
    const document = createDefaultDocument()
    expect(document.rulesSnapshot).toMatchObject({ version: 'teyvat-mvp-2', field: { width: 20, height: 14 } })
    expect(document.initialScene.players.find((player) => player.id === 'blue-fire')?.position.y).toBe(7)
    expect(document.initialScene.ball.position.y).toBe(4.7)
  })

  it('migrates the untouched legacy Ice facing penalty to the favorable bonus', () => {
    const legacy = createDefaultDocument()
    const modifier = legacy.rulesSnapshot.modifiers.find((candidate) => candidate.id === 'bad-facing')!
    modifier.label = '冰的面向不利于摆脱'
    modifier.delta = -1

    const result = parseTactic(serializeTactic(legacy))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.rulesSnapshot.modifiers.find((candidate) => candidate.id === 'bad-facing')).toMatchObject({
      label: '冰背面向利于摆脱',
      condition: 'badFacing',
      delta: 1,
    })
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

  it('round-trips a target-only hang-ice status without an applier', () => {
    const source = createDefaultDocument()
    source.actions.push({
      id: 'target-only-slow', type: 'status', targetId: 'red-fire', status: 'slowed',
      startTime: 1.25, duration: 7, separationDelta: -1.2,
    })

    const result = parseTactic(serializeTactic(source))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.document.actions[0]).toMatchObject({
        id: 'target-only-slow', targetId: 'red-fire', status: 'slowed', startTime: 1.25, duration: 7,
      })
      expect(result.document.actions[0]).not.toHaveProperty('actorId')
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

  it('round-trips an instant-Q pass origin keyframe', () => {
    const source = createDefaultDocument()
    source.actions.push(
      {
        id: 'water-q', type: 'qMove', actorId: 'blue-water', startTime: 2, duration: 0,
        path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }],
      },
      {
        id: 'after-q-pass', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-fire',
        originKeyframe: { playerId: 'blue-water', actionId: 'water-q', edge: 'end' },
        startTime: 2, duration: 0.5, path: [{ x: 8, y: 4.7 }, { x: 3.5, y: 7 }],
      },
    )

    const result = parseTactic(serializeTactic(source))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.document.actions.find((action) => action.id === 'after-q-pass')).toMatchObject({
      originKeyframe: { playerId: 'blue-water', actionId: 'water-q', edge: 'end' },
    })
  })

  it('rejects a pass origin that does not resolve to the passer instant Q at that time', () => {
    const source = createDefaultDocument()
    source.actions.push(
      {
        id: 'water-q', type: 'qMove', actorId: 'blue-water', startTime: 2, duration: 0,
        path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }],
      },
      {
        id: 'bad-anchor-pass', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-fire',
        originKeyframe: { playerId: 'blue-water', actionId: 'missing-q', edge: 'end' },
        startTime: 2, duration: 0.5, path: [{ x: 8, y: 4.7 }, { x: 3.5, y: 7 }],
      },
    )
    expect(parseTactic(serializeTactic(source))).toMatchObject({ ok: false })

    const wrongTime = structuredClone(source)
    const pass = wrongTime.actions.find((action) => action.id === 'bad-anchor-pass')
    if (pass?.type !== 'pass') throw new Error('Expected pass')
    pass.originKeyframe = { playerId: 'blue-water', actionId: 'water-q', edge: 'end' }
    pass.startTime = 3
    expect(parseTactic(serializeTactic(wrongTime))).toMatchObject({ ok: false })
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

  it('restores fixed Fire/Geo Q semantics when the snapshot omits the distance flag', () => {
    const legacy = createDefaultDocument() as unknown as {
      rulesSnapshot: { roles: Record<'water' | 'fire' | 'ice' | 'geo', { q: Record<string, unknown> }> }
    }
    delete legacy.rulesSnapshot.roles.water.q.fixedDistance
    delete legacy.rulesSnapshot.roles.fire.q.fixedDistance
    delete legacy.rulesSnapshot.roles.ice.q.fixedDistance
    delete legacy.rulesSnapshot.roles.geo.q.fixedDistance

    const result = parseTactic(JSON.stringify(legacy))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.rulesSnapshot.roles.water.q.fixedDistance).toBe(false)
    expect(result.document.rulesSnapshot.roles.fire.q.fixedDistance).toBe(true)
    expect(result.document.rulesSnapshot.roles.ice.q.fixedDistance).toBe(false)
    expect(result.document.rulesSnapshot.roles.geo.q.fixedDistance).toBe(true)
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
