import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { SceneState, TacticAction } from '../model/types'
import { formatStepActionRange, getStepActionOwnership, stepDisplayTime } from './stepActionOwnership'

function marker(id: string, time: number, snapshot: SceneState) {
  return { id, time, name: id, note: '', snapshot: structuredClone(snapshot) }
}

describe('step action ownership', () => {
  it('uses the latest owned action end as a non-opening step display time', () => {
    const document = createDefaultDocument()
    const opening = document.stepMarkers[0]!
    const actionStep = { id: 'action-step', time: 0, name: '步骤 2', note: '', snapshot: structuredClone(document.initialScene) }
    document.stepMarkers.push(actionStep)
    document.actions.push(
      { id: 'short', type: 'wait', actorId: 'blue-water', startTime: 0, duration: 2 },
      { id: 'long', type: 'wait', actorId: 'blue-fire', startTime: 0, duration: 4 },
    )

    expect(stepDisplayTime(document, opening.id)).toBe(0)
    expect(stepDisplayTime(document, actionStep.id)).toBe(4)
    expect(stepDisplayTime(document, 'missing')).toBeNull()
  })

  it('uses sorted first, middle and last half-open intervals with exact boundaries', () => {
    const document = createDefaultDocument()
    const snapshot = document.initialScene
    document.stepMarkers = [marker('last', 10, snapshot), marker('first', 0, snapshot), marker('middle', 5, snapshot)]
    document.actions = [
      { id: 'first-start', type: 'wait', startTime: 0, duration: 0 },
      { id: 'crosses-boundary', type: 'wait', startTime: 4, duration: 4 },
      { id: 'middle-boundary', type: 'wait', startTime: 5, duration: 0 },
      { id: 'middle-end', type: 'wait', startTime: 9.999, duration: 2 },
      { id: 'last-boundary', type: 'wait', startTime: 10, duration: 0 },
      { id: 'last-future', type: 'wait', startTime: 100, duration: 0 },
    ]

    expect(getStepActionOwnership(document, 'first')).toMatchObject({
      startTime: 0, endTime: 5, actionIds: ['first-start', 'crosses-boundary'], count: 2,
    })
    expect(getStepActionOwnership(document, 'middle')).toMatchObject({
      startTime: 5, endTime: 10, actionIds: ['middle-boundary', 'middle-end'], count: 2,
    })
    const last = getStepActionOwnership(document, 'last')!
    expect(last.actionIds).toEqual(['last-boundary', 'last-future'])
    expect(last.endTime).toBe(Number.POSITIVE_INFINITY)
    expect(formatStepActionRange(last)).toBe('动作开始 ≥ 10.00s')
    expect(getStepActionOwnership(document, 'missing')).toBeNull()
  })

  it('owns every semantic action type without reordering IDs', () => {
    const document = createDefaultDocument()
    const base = { startTime: 0, duration: 0 }
    const actions: TacticAction[] = [
      { ...base, id: 'move', type: 'move', actorId: 'blue-water', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] },
      { ...base, id: 'q', type: 'qMove', actorId: 'blue-water', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] },
      { ...base, id: 'pass', type: 'pass', actorId: 'blue-water', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }] },
      { ...base, id: 'receive', type: 'receive', actorId: 'blue-water' },
      { ...base, id: 'possession', type: 'possession', carrierId: null, position: { x: 2, y: 1 } },
      { ...base, id: 'shoot', type: 'shoot', actorId: 'blue-water', charge: 'yellow', path: [{ x: 1, y: 1 }, { x: 20, y: 5 }] },
      { ...base, id: 'attack', type: 'attack', actorId: 'red-water', targetId: 'blue-water' },
      { ...base, id: 'zone', type: 'eZone', actorId: 'blue-ice', center: { x: 2, y: 2 }, radius: 2 },
      { ...base, id: 'status', type: 'status', actorId: 'blue-ice', targetId: 'red-water', status: 'frozen' },
      { ...base, id: 'wait', type: 'wait', actorId: 'blue-water' },
      { ...base, id: 'annotation', type: 'annotation', path: [{ x: 1, y: 1 }, { x: 2, y: 1 }], text: 'note' },
    ]
    document.actions = actions
    const ownership = getStepActionOwnership(document, document.stepMarkers[0]!.id)!
    expect(ownership.actionIds).toEqual(actions.map((action) => action.id))
    expect(ownership.count).toBe(actions.length)
  })

  it('resolves duplicate-time steps stably without assigning an action twice', () => {
    const document = createDefaultDocument()
    const snapshot = document.initialScene
    document.stepMarkers = [
      marker('later', 10, snapshot),
      marker('same-first', 5, snapshot),
      marker('opening', 0, snapshot),
      marker('same-second', 5, snapshot),
    ]
    document.actions = [
      { id: 'before-duplicate', type: 'wait', startTime: 4.999, duration: 10 },
      { id: 'at-duplicate', type: 'wait', startTime: 5, duration: 0 },
      { id: 'after-duplicate', type: 'wait', startTime: 6, duration: 0 },
      { id: 'next-boundary', type: 'wait', startTime: 10, duration: 0 },
    ]

    expect(getStepActionOwnership(document, 'opening')?.actionIds).toEqual(['before-duplicate'])
    expect(getStepActionOwnership(document, 'same-first')).toMatchObject({
      startTime: 5, endTime: 5, actionIds: [], count: 0,
    })
    expect(getStepActionOwnership(document, 'same-second')?.actionIds).toEqual(['at-duplicate', 'after-duplicate'])
    expect(getStepActionOwnership(document, 'later')?.actionIds).toEqual(['next-boundary'])
  })
})
