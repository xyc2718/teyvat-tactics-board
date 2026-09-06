import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as projection from '../domain/timeline/projectFrame'
import * as passThreat from '../domain/rules/passThreat'
import * as passReception from '../domain/timeline/passReception'
import { createDefaultDocument } from '../domain/model/createDocument'
import { useTacticStore } from '../editor/useTacticStore'
import { createFollowPerformanceFixture } from '../test/followPerformanceFixture'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { TacticsBoard } from './TacticsBoard'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('draws a failed homing pass only to its actual landing point with a curved corridor and outcome', () => {
  const document = createDefaultDocument()
  document.view.analysis = true
  document.actions.push({
    id: 'dropped-curve', type: 'pass', actorId: 'blue-fire', targetPlayerId: 'blue-ice',
    startTime: 0, duration: 1, flightOutcome: 'dropped',
    path: [{ x: 1, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 4 }],
  })
  // A rendering fixture: preserve the already resolved flight, without invoking
  // command normalization that would solve the stationary fixture target again.
  useTacticStore.setState({
    document, selection: { kind: 'action', id: 'dropped-curve' }, currentTime: 0,
    isPlaying: false, boardMode: 'simulation', tool: 'select',
  })
  const { container } = render(<><TacticsBoard /><InspectorPanel /></>)
  expect(container.querySelector('.pass-landing')).toHaveAttribute('transform', 'translate(300 200)')
  expect(container.querySelector('.intercept-cone')?.getAttribute('points')?.split(' ')).toHaveLength(6)
  const routes = [...container.querySelectorAll('.pass-threat-segment')]
  expect(routes.at(-1)?.getAttribute('points')?.split(' ').at(-1)).toBe('300,200')
  expect(routes.filter((route) => route.hasAttribute('marker-end'))).toHaveLength(1)
  expect(container.querySelectorAll('.pass-landing')).toHaveLength(1)
  expect(screen.getByText(/未接到：已耗尽飞行距离/)).toBeInTheDocument()
})

it('reuses saved route geometry during real timeline scrubs and refreshes after document edits', () => {
  useTacticStore.getState().replaceDocument(createFollowPerformanceFixture())
  useTacticStore.getState().select({ kind: 'player', id: 'red-fire' })
  useTacticStore.getState().setTool('move')
  useTacticStore.getState().createAction('red-fire', { x: 15, y: 8 }, 'blue-ice')
  const route = vi.spyOn(projection, 'projectedMovePath')
  const slow = vi.spyOn(projection, 'eZoneSlowSegmentsForMove')
  const classification = vi.spyOn(passThreat, 'classifyPassThreat')
  const corridor = vi.spyOn(passThreat, 'buildPassCorridor')
  const solver = vi.spyOn(passReception, 'solvePassReception')
  const { container } = render(<><TacticsBoard /><TimelinePanel /><InspectorPanel /></>)
  const slider = screen.getByRole('slider', { name: '播放位置' })
  const routeCalls = route.mock.calls.length
  const slowCalls = slow.mock.calls.length
  const classificationCalls = classification.mock.calls.length
  const corridorCalls = corridor.mock.calls.length
  const solverCalls = solver.mock.calls.length
  expect(routeCalls).toBeGreaterThan(0)
  expect(classificationCalls).toBeGreaterThan(0)
  expect(corridorCalls).toBeGreaterThan(0)
  for (const value of [9000, 5000, 3000, 6500, 2000, 4000]) {
    fireEvent.change(slider, { target: { value: String(value) } })
  }
  expect(route).toHaveBeenCalledTimes(routeCalls)
  expect(slow).toHaveBeenCalledTimes(slowCalls)
  expect(classification).toHaveBeenCalledTimes(classificationCalls)
  expect(corridor).toHaveBeenCalledTimes(corridorCalls)
  expect(solver).toHaveBeenCalledTimes(solverCalls)
  expect(container.querySelectorAll('.player-token').length).toBe(6)
  act(() => {
    const document = structuredClone(useTacticStore.getState().document)
    const target = document.actions.find((action) => action.type === 'move' && action.actorId === 'blue-ice')
    if (target?.type !== 'move') throw new Error('Missing target run')
    target.path.at(-1)!.x -= 1
    useTacticStore.setState({ document })
  })
  expect(route.mock.calls.length).toBeGreaterThan(routeCalls)
  expect(slow.mock.calls.length).toBeGreaterThan(slowCalls)
  expect(classification.mock.calls.length).toBeGreaterThan(classificationCalls)
  expect(corridor.mock.calls.length).toBeGreaterThan(corridorCalls)
})
