import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { MoveAction, QMoveAction } from '../domain/model/types'
import { DRAFT_STORAGE_KEY, loadDraft, parseTactic, saveDraft, serializeTactic } from './tacticFile'

function fixture() {
  const document = createDefaultDocument()
  document.rulesSnapshot.roles.water.q.cooldown = 6
  const source: QMoveAction = {
    id: 'q', type: 'qMove', actorId: 'blue-water', startTime: 2, duration: 0,
    path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }],
  }
  const move: MoveAction = {
    id: 'run', type: 'move', actorId: 'blue-water', startTime: 4, duration: 4,
    path: [{ x: 8, y: 4.7 }, { x: 12, y: 4.7 }],
    timingConstraint: { kind: 'qCooldown', sourceActionId: source.id },
  }
  document.actions = [source, move]
  return { document, move, source }
}

describe('Q cooldown move file contract', () => {
  afterEach(() => localStorage.removeItem(DRAFT_STORAGE_KEY))

  it('retains the source identity and resolved duration in JSON and local draft round trips', () => {
    const { document, move } = fixture()
    const parsed = parseTactic(serializeTactic(document))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.document.actions.find((action) => action.id === move.id)).toEqual(move)
    saveDraft(document)
    expect(loadDraft()?.actions).toEqual(document.actions)
    const renamed = parseTactic(serializeTactic(document)
      .replace('"id": "q"', '"id": "renamed-q"')
      .replace('"sourceActionId": "q"', '"sourceActionId": "renamed-q"'))
    expect(renamed.ok).toBe(true)
    if (renamed.ok) expect(renamed.document.actions[1]).toHaveProperty('timingConstraint.sourceActionId', 'renamed-q')
  })

  it.each(['missing', 'self', 'other-actor', 'not-q', 'future', 'expired', 'wrong-duration', 'zero-duration', 'negative-duration', 'follow', 'pickup'])('rejects invalid cooldown bindings: %s', (variant) => {
    const { document, move, source } = fixture()
    if (variant === 'missing') move.timingConstraint = { kind: 'qCooldown', sourceActionId: 'missing' }
    if (variant === 'self') move.timingConstraint = { kind: 'qCooldown', sourceActionId: move.id }
    if (variant === 'other-actor') source.actorId = 'red-water'
    if (variant === 'not-q') document.actions[0] = { id: source.id, type: 'wait', actorId: source.actorId, startTime: 2, duration: 0 }
    if (variant === 'future') source.startTime = 5
    if (variant === 'expired') move.startTime = 8
    if (variant === 'wrong-duration') move.duration = 3
    if (variant === 'zero-duration') move.duration = 0
    if (variant === 'negative-duration') move.duration = -1
    if (variant === 'follow') Object.assign(move, { targetPlayerId: 'red-water', syncActionId: 'q', followGap: 1 })
    if (variant === 'pickup') move.ballTarget = { sourceActionId: null }
    expect(parseTactic(JSON.stringify(document)).ok).toBe(false)
  })

  it('rejects a same-time non-instant Q that depends on the run in the actor sequence', () => {
    const { document, move, source } = fixture()
    move.startTime = 2
    move.duration = 6
    source.duration = 7
    const parsed = parseTactic(serializeTactic(document))
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('循环时间参照') })
  })

  it('accepts reversed same-time instant Q and legacy manual/path/keyframe modes', () => {
    const { document, move } = fixture()
    move.startTime = 2
    move.duration = 6
    document.actions.reverse()
    expect(parseTactic(serializeTactic(document)).ok).toBe(true)
    move.timingConstraint = { kind: 'fixed' }
    expect(parseTactic(serializeTactic(document)).ok).toBe(true)
    delete move.timingConstraint
    expect(parseTactic(serializeTactic(document)).ok).toBe(true)
    document.actions.push({ id: 'red-wait', type: 'wait', actorId: 'red-water', startTime: 0, duration: 8 })
    move.timingConstraint = { kind: 'keyframe', reference: { actionId: 'red-wait', playerId: 'red-water', edge: 'end' } }
    expect(parseTactic(serializeTactic(document)).ok).toBe(true)
  })
})
