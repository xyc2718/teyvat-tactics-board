import { afterEach, expect, it, vi } from 'vitest'
import { createFollowPerformanceFixture } from '../test/followPerformanceFixture'
import { evaluateWarnings } from '../domain/rules/evaluateRules'
import * as solver from '../domain/timeline/passReception'
import { eZoneSlowSegmentsForMove, projectedMovePath, projectFrame } from '../domain/timeline/projectFrame'
import { useTacticStore } from './useTacticStore'

afterEach(() => vi.restoreAllMocks())

it('keeps the reported complex chase plus five homing passes bounded and reuses them when scrubbing', () => {
  const started = performance.now()
  useTacticStore.getState().replaceDocument(createFollowPerformanceFixture())
  useTacticStore.getState().select({ kind: 'player', id: 'red-fire' })
  useTacticStore.getState().setTool('move')
  useTacticStore.getState().createAction('red-fire', { x: 15, y: 8 }, 'blue-ice')
  for (let index = 0; index < 3; index += 1) {
    const state = useTacticStore.getState()
    const time = index ? state.currentTime : 2
    useTacticStore.setState({ currentTime: time, currentKeyframe: null })
    const frame = projectFrame(state.document, time)
    const carrier = frame.ball.carrierId
    if (!carrier) throw new Error('Missing intermediate carrier')
    const target = frame.players.find((player) => player.id === (carrier === 'blue-ice' ? 'blue-water' : 'blue-ice'))!
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction(carrier, target.position, target.id)
    evaluateWarnings(useTacticStore.getState().document)
  }
  const document = useTacticStore.getState().document
  const passes = document.actions.filter((action) => action.type === 'pass')
  expect(passes).toHaveLength(5)
  expect(passes.every((pass) => pass.flightOutcome === 'received')).toBe(true)
  expect(passes.some((pass) => pass.path.length > 2)).toBe(true)
  // Generous end-to-end CI bound; the former warning-only chase took ~5.8s.
  expect(performance.now() - started).toBeLessThan(5_000)

  const solveSpy = vi.spyOn(solver, 'solvePassReception')
  const scrubStart = performance.now()
  for (let index = 0; index < 90; index += 1) {
    const time = ((index * 37) % 91) / 91 * 7
    useTacticStore.getState().setCurrentTime(time)
    const frame = projectFrame(document, time)
    if (frame.ball.carrierId) {
      expect(frame.ball.position).toEqual(frame.players.find((player) => player.id === frame.ball.carrierId)?.position)
    }
    for (const action of document.actions) {
      if (action.type !== 'move') continue
      projectedMovePath(document, action)
      eZoneSlowSegmentsForMove(document, action)
    }
  }
  expect(solveSpy).not.toHaveBeenCalled()
  expect(performance.now() - scrubStart).toBeLessThan(1_500)
})
