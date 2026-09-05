import { describe, expect, it } from 'vitest'
import { createFollowPerformanceFixture } from '../../test/followPerformanceFixture'
import { useTacticStore } from '../../editor/useTacticStore'
import { evaluateWarnings } from '../rules/evaluateRules'
import { actionEndTime } from './durations'
import {
  documentFreezeWindows,
  eZoneSlowSegmentsForMove,
  projectedMovePath,
  projectFrame,
  projectPlayerPosition,
  statusSlowSegmentsForMove,
} from './projectFrame'

function createReportedChase() {
  useTacticStore.getState().replaceDocument(createFollowPerformanceFixture())
  useTacticStore.getState().select({ kind: 'player', id: 'red-fire' })
  useTacticStore.getState().setTool('move')
  useTacticStore.getState().createAction('red-fire', { x: 15, y: 8 }, 'blue-ice')
  const document = useTacticStore.getState().document
  const follow = document.actions.find((action) => action.type === 'move' && action.targetPlayerId === 'blue-ice')
  if (follow?.type !== 'move') throw new Error('The reported chase was not created')
  return { document, follow }
}

describe('reported chase performance and cache lifecycle', () => {
  it('imports, creates, checks, and scrubs the actual tactic without repeating whole-route simulation', () => {
    const started = performance.now()
    const { document, follow } = createReportedChase()
    const freeze = documentFreezeWindows(document, 'red-fire')[0]!
    expect(follow.startTime).toBeCloseTo(freeze.endsAt, 5)
    expect(evaluateWarnings(document)).toBeDefined()
    const route = projectedMovePath(document, follow)
    expect(projectFrame(document, actionEndTime(follow)).players.find((player) => player.id === follow.actorId)?.position)
      .toEqual(route.at(-1))
    // Generous CI limits: the old warning scan alone took ~5.8 seconds.
    expect(performance.now() - started).toBeLessThan(3_000)

    const moves = document.actions.filter((action) => action.type === 'move')
    const scrubStarted = performance.now()
    for (let index = 0; index < 90; index += 1) {
      // Unique, non-grid times in alternating directions exercise playback as
      // well as dragging back through previously computed trajectory samples.
      const progress = ((index * 37) % 91) / 91
      const time = follow.startTime + follow.duration * progress
      const frame = projectFrame(document, time)
      const carrier = frame.players.find((player) => player.id === frame.ball.carrierId)
      if (carrier) expect(frame.ball.position).toEqual(carrier.position)
      for (const action of moves) {
        expect(projectedMovePath(document, action).length).toBeGreaterThan(1)
        eZoneSlowSegmentsForMove(document, action)
        statusSlowSegmentsForMove(document, action)
      }
    }
    expect(performance.now() - scrubStarted).toBeLessThan(1_500)
  })

  it('matches selective positions to full frames at Q, freeze, catch, and follow boundaries', () => {
    const { document, follow } = createReportedChase()
    const times = [0, 0.5, 1, follow.startTime, 3.333, actionEndTime(follow), 7]
    for (const time of times) {
      const frame = projectFrame(document, time)
      for (const player of frame.players) {
        expect(projectPlayerPosition(document, player.id, time)).toEqual(player.position)
      }
    }
  })

  it('invalidates in-place edits, isolates returned data, and survives undo and reimport', () => {
    const { document, follow } = createReportedChase()
    const time = actionEndTime(follow)
    const original = projectFrame(document, time)
    const firstRoute = projectedMovePath(document, follow)
    firstRoute.at(-1)!.x = -999
    const changedFrame = projectFrame(document, time)
    changedFrame.players[0]!.position.x = -999
    changedFrame.ball.position.x = -999
    changedFrame.cooldowns['blue-water']!.q = -999
    expect(projectFrame(document, time)).toEqual(original)
    expect(projectedMovePath(document, follow).at(-1)?.x).not.toBe(-999)

    const target = document.actions.find((action) => action.id === follow.syncActionId)
    if (target?.type !== 'move') throw new Error('Missing target movement')
    target.path.at(-1)!.x -= 3
    const changedRoute = projectedMovePath(document, follow)
    expect(changedRoute.at(-1)).not.toEqual(original.players.find((player) => player.id === follow.actorId)?.position)
    document.rulesSnapshot.field.baseMoveSpeed = 0.2
    expect(projectedMovePath(document, follow).at(-1)).not.toEqual(changedRoute.at(-1))

    useTacticStore.getState().undo()
    expect(useTacticStore.getState().document.actions.some((action) => action.id === follow.id)).toBe(false)
    useTacticStore.getState().redo()
    const restored = useTacticStore.getState().document
    expect(projectFrame(restored, time)).toEqual(projectFrame(structuredClone(restored), time))
    useTacticStore.getState().replaceDocument(createFollowPerformanceFixture())
    expect(useTacticStore.getState().document.actions).toHaveLength(13)
  })
})
