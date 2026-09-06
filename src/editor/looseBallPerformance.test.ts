import { afterEach, expect, it, vi } from 'vitest'
import { createFollowPerformanceFixture } from '../test/followPerformanceFixture'
import { evaluateWarnings } from '../domain/rules/evaluateRules'
import * as normalization from '../domain/timeline/looseBall'
import * as passSolver from '../domain/timeline/passReception'
import { eZoneSlowSegmentsForMove, projectedMovePath, projectFrame } from '../domain/timeline/projectFrame'
import { useTacticStore } from './useTacticStore'

afterEach(() => vi.restoreAllMocks())

it('bounds cold chase/zone/pass/loose-ball creation and reuses results across 90 distinct scrubs', () => {
  const started = performance.now()
  useTacticStore.getState().replaceDocument(createFollowPerformanceFixture())
  useTacticStore.getState().select({ kind: 'player', id: 'red-fire' })
  useTacticStore.getState().setTool('move')
  useTacticStore.getState().createAction('red-fire', { x: 15, y: 8 }, 'blue-ice')
  useTacticStore.setState({ currentTime: 2, currentKeyframe: null })
  const frame = projectFrame(useTacticStore.getState().document, 2)
  const actor = frame.players.find((player) => player.id === frame.ball.carrierId)!
  expect(actor).toBeTruthy()
  useTacticStore.getState().setTool('loosePass')
  useTacticStore.getState().createAction(actor.id, { x: actor.position.x, y: 14 })
  const flight = useTacticStore.getState().document.actions.find((action) => action.type === 'loosePass')!
  expect(flight).toBeTruthy()
  useTacticStore.setState({ currentTime: flight.startTime + flight.duration, currentKeyframe: null, tool: 'move' })
  useTacticStore.getState().createBallPickup('blue-water')
  const document = useTacticStore.getState().document
  expect(document.actions.some((action) => action.type === 'receive' && action.pickupActionId)).toBe(true)
  evaluateWarnings(document)
  expect(performance.now() - started).toBeLessThan(5_000)
  const normalizeSpy = vi.spyOn(normalization, 'normalizeBallActions')
  const solveSpy = vi.spyOn(passSolver, 'solvePassReception')
  const scrubStart = performance.now()
  for (let index = 0; index < 90; index += 1) {
    const time = ((index * 37) % 91) / 91 * 12
    useTacticStore.getState().setCurrentTime(time)
    const projection = projectFrame(document, time)
    if (projection.ball.carrierId) {
      expect(projection.ball.position).toEqual(projection.players.find((player) => player.id === projection.ball.carrierId)?.position)
    }
    for (const action of document.actions) {
      if (action.type !== 'move') continue
      projectedMovePath(document, action)
      eZoneSlowSegmentsForMove(document, action)
    }
  }
  expect(normalizeSpy).not.toHaveBeenCalled()
  expect(solveSpy).not.toHaveBeenCalled()
  expect(performance.now() - scrubStart).toBeLessThan(1_500)
})
