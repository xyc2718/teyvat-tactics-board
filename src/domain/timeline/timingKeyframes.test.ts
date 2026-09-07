import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { MoveAction, TacticDocumentV1, TimingTargetReference } from '../model/types'
import { createTimingTargetValidator, documentTimingKeyframes, playerTimingKeyframes, resolveTimingKeyframe, timingTargetUnavailableReason } from './timingKeyframes'
import { parseTactic, serializeTactic } from '../../persistence/tacticFile'

const boostEnd: TimingTargetReference = { playerId: 'blue-water', actionId: 'q', event: 'qBoost', edge: 'end' }
function fixture(): { document: TacticDocumentV1; run: MoveAction } {
  const document = createDefaultDocument()
  const run: MoveAction = { id: 'run', type: 'move', actorId: 'blue-water', startTime: 0, duration: 1,
    path: [{ x: 8, y: 4.7 }, { x: 9, y: 4.7 }] }
  document.actions = [
    { id: 'q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }] }, run,
  ]
  return { document, run }
}

describe('shared timing event catalog and dependencies', () => {
  it('offers own Q boost and cooldown ending without merging instant-Q edges', () => {
    const { document, run } = fixture()
    expect(resolveTimingKeyframe(document, boostEnd)).toMatchObject({ time: 4.3, label: 'Q 后加速结束' })
    expect(timingTargetUnavailableReason(document, run, boostEnd)).toBeNull()
    const events = playerTimingKeyframes(document, run.actorId)
    expect(events.filter((event) => !('event' in event.reference) && 'actionId' in event.reference && event.reference.actionId === 'q')).toHaveLength(2)
    expect(events.find((event) => 'event' in event.reference && event.reference.event === 'qReady')?.time).toBe(7)
    document.rulesSnapshot.roles.water.afterQBoost!.duration = 5
    expect(resolveTimingKeyframe(document, boostEnd)?.time).toBe(5)
    document.initialScene.players[0]!.role = 'fire'
    expect(resolveTimingKeyframe(document, boostEnd)).toBeNull()
  })

  it('uses refresh-clipped Q intervals and rejects the downstream refresh dependency', () => {
    const { document, run } = fixture()
    document.actions.push({ id: 'next-q', type: 'qMove', actorId: run.actorId, startTime: 2, duration: 0,
      path: [{ x: 9, y: 4.7 }, { x: 11, y: 4.7 }] })
    expect(resolveTimingKeyframe(document, boostEnd)).toMatchObject({ time: 2, label: 'Q 后加速刷新', dependencyActionIds: ['q', 'next-q'] })
    expect(timingTargetUnavailableReason(document, run, boostEnd)).toContain('循环')
  })

  it('rejects self/past/downstream and indirect cross-player cycles', () => {
    const { document, run } = fixture()
    document.actions.push({ id: 'later', type: 'wait', actorId: run.actorId, startTime: 1, duration: 2 },
      { id: 'other', type: 'wait', actorId: 'red-fire', startTime: 0, duration: 3,
        timingConstraint: { kind: 'keyframe', reference: { playerId: run.actorId, actionId: 'later', edge: 'end' } } })
    const validate = createTimingTargetValidator(document, run)
    expect(validate({ playerId: run.actorId, actionId: run.id, edge: 'end' })).toContain('循环')
    expect(validate({ playerId: run.actorId, actionId: 'later', edge: 'end' })).toContain('循环')
    expect(validate({ playerId: 'red-fire', actionId: 'other', edge: 'end' })).toContain('循环')
    expect(validate({ playerId: run.actorId, actionId: 'q', edge: 'start' })).toContain('晚于')
  })

  it('binds initial status identity and returns caller-owned events', () => {
    const { document, run } = fixture()
    document.initialScene.statuses.push({ id: 'opening-boost', sourceActionId: 'legacy-source', playerId: run.actorId,
      kind: 'boosted', startsAt: 0, endsAt: 3 })
    const reference: TimingTargetReference = { playerId: run.actorId, statusId: 'opening-boost', event: 'initialStatus', edge: 'end' }
    expect(timingTargetUnavailableReason(document, run, reference)).toBeNull()
    expect(resolveTimingKeyframe(document, reference)?.time).toBe(3)
    documentTimingKeyframes(document)[0]!.time = 100
    expect(documentTimingKeyframes(document)[0]!.time).toBe(0)
    document.initialScene.statuses[0]!.endsAt = 4
    expect(resolveTimingKeyframe(document, reference)?.time).toBe(4)
  })

  it('rejects a freeze target whose hit depends on a run completed before the Q began', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 4, y: 7 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 8, y: 7 }
    const run: MoveAction = { id: 'early-run', type: 'move', actorId: 'red-fire', startTime: 0, duration: 1,
      path: [{ x: 8, y: 7 }, { x: 7, y: 7 }] }
    document.actions = [run, { id: 'later-ice-q', type: 'qMove', actorId: 'blue-ice', startTime: 2, duration: 1,
      path: [{ x: 4, y: 7 }, { x: 7, y: 7 }] }]
    const reference: TimingTargetReference = { playerId: run.actorId, actionId: 'later-ice-q', event: 'freeze', edge: 'end' }
    expect(resolveTimingKeyframe(document, reference)).not.toBeNull()
    expect(timingTargetUnavailableReason(document, run, reference)).toContain('循环')
  })

  it('includes effective received and transferred boost windows with true catch-motion dependencies', () => {
    const document = createDefaultDocument()
    const move: MoveAction = { id: 'ice-run', type: 'move', actorId: 'blue-ice', startTime: 0, duration: 2,
      path: [{ x: 5.5, y: 9.3 }, { x: 7.5, y: 9.3 }] }
    document.actions = [move,
      { id: 'incoming', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice', startTime: 0, duration: 1,
        path: [{ x: 5.5, y: 4.7 }, { x: 6.5, y: 9.3 }], flightOutcome: 'received' },
      { id: 'receipt', type: 'receive', actorId: 'blue-ice', sourceActionId: 'incoming', startTime: 1, duration: 0 },
      { id: 'transfer', type: 'pass', actorId: 'blue-ice', targetPlayerId: 'blue-fire', startTime: 1, duration: 1,
        path: [{ x: 6.5, y: 9.3 }, { x: 3.5, y: 7 }], flightOutcome: 'received' },
      { id: 'transfer-receipt', type: 'receive', actorId: 'blue-fire', sourceActionId: 'transfer', startTime: 2, duration: 0 },
    ]
    const reference: TimingTargetReference = { playerId: 'blue-ice', actionId: 'incoming', event: 'receiveBoost', edge: 'end' }
    expect(resolveTimingKeyframe(document, reference)?.time).toBeCloseTo(5.3)
    expect(timingTargetUnavailableReason(document, move, reference)).toContain('循环')
    expect(resolveTimingKeyframe(document, { playerId: 'blue-fire', actionId: 'transfer', event: 'receiveBoost', edge: 'end' }))
      .toMatchObject({ label: '传递加速结束', time: 6.3 })
    move.startTime = 1
    expect(timingTargetUnavailableReason(document, move, reference)).toBeNull()
  })

  it('does not invent a catch dependency on a friendly ice-zone owner movement', () => {
    const document = createDefaultDocument()
    const owner = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    owner.role = 'ice'
    const run: MoveAction = { id: 'zone-owner-run', type: 'move', actorId: owner.id, startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7 }, { x: 4.5, y: 7 }] }
    document.actions = [run,
      { id: 'friendly-zone', type: 'eZone', actorId: owner.id, startTime: 0, duration: 10, radius: 2,
        center: { x: 3.5, y: 7 } },
      { id: 'incoming', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice', startTime: 0, duration: 1,
        path: [{ x: 5.5, y: 4.7 }, { x: 5.5, y: 9.3 }], flightOutcome: 'received' },
    ]
    const reference: TimingTargetReference = { playerId: 'blue-ice', actionId: 'incoming', event: 'receiveBoost', edge: 'end' }
    expect(resolveTimingKeyframe(document, reference)).not.toBeNull()
    expect(timingTargetUnavailableReason(document, run, reference)).toBeNull()
    owner.team = 'red'
    expect(timingTargetUnavailableReason(document, run, reference)).toContain('循环')
  })

  it('round-trips own-state waits/runs and rejects invalid ownership/cycles without broadening release origins', () => {
    const { document, run } = fixture()
    run.duration = 4.3
    run.timingConstraint = { kind: 'keyframe', reference: boostEnd }
    document.actions.push({ id: 'wait-red', type: 'wait', actorId: 'red-fire', startTime: 2, duration: 2.3,
      timingConstraint: { kind: 'keyframe', reference: boostEnd } })
    expect(parseTactic(serializeTactic(document)).ok).toBe(true)
    const wait = document.actions.at(-1)!
    if (wait.type !== 'wait') throw new Error('wait fixture')
    delete wait.actorId
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    wait.actorId = 'red-fire'
    wait.duration = 2
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    wait.duration = 2.3
    run.timingConstraint.reference = { playerId: 'blue-water', actionId: 'run', edge: 'end' }
    expect(parseTactic(serializeTactic(document)).ok).toBe(false)
    const raw = JSON.parse(serializeTactic(fixture().document))
    raw.actions.push({ id: 'pass', type: 'pass', actorId: 'blue-water', startTime: 0, duration: 1,
      path: [{ x: 8, y: 4.7 }, { x: 9, y: 4.7 }], originKeyframe: boostEnd })
    expect(parseTactic(JSON.stringify(raw)).ok).toBe(false)
  })
})
