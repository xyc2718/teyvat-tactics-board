import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as projection from '../domain/timeline/projectFrame'
import * as passThreat from '../domain/rules/passThreat'
import * as passReception from '../domain/timeline/passReception'
import * as geoShield from '../domain/rules/geoShield'
import { createDefaultDocument } from '../domain/model/createDocument'
import * as timingKeyframes from '../domain/timeline/timingKeyframes'
import { useTacticStore } from '../editor/useTacticStore'
import { createFollowPerformanceFixture } from '../test/followPerformanceFixture'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { TacticsBoard } from './TacticsBoard'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('shows the actual timed boost distance and reuses its geometry during scrubbing', () => {
  const document = createDefaultDocument()
  document.actions.push(
    { id: 'timed-q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }] },
    { id: 'actual-speed-run', type: 'move', actorId: 'blue-water', startTime: 0, duration: 5,
      path: [{ x: 8, y: 4.7 }, { x: 13, y: 4.7 }], timingConstraint: { kind: 'fixed' } },
  )
  useTacticStore.getState().replaceDocument(document)
  useTacticStore.setState({ selection: { kind: 'action', id: 'actual-speed-run' }, currentTime: 0, currentKeyframe: null, isPlaying: false, tool: 'select' })
  const boosts = vi.spyOn(projection, 'timedMoveBoosts')
  const geometry = vi.spyOn(projection, 'resolveTimedMoveGeometry')
  const catalog = vi.spyOn(timingKeyframes, 'documentTimingKeyframes')
  const { container } = render(<><TacticsBoard /><TimelinePanel /><InspectorPanel /></>)
  const boost = container.querySelector('.water-q-boost-segment')
  expect(boost).not.toBeNull()
  const [endX, endY] = boost!.getAttribute('points')!.split(' ').at(-1)!.split(',').map(Number)
  // Full 4.3s boosted section: x = 8 + 4.3 + 0.8 = 13.1 grids.
  expect(endX).toBeCloseTo(655, 2)
  expect(endY).toBeCloseTo(235, 2)
  expect(screen.getByText(/4.30s.*Q 后加速结束/)).toBeInTheDocument()
  boosts.mockClear()
  geometry.mockClear()
  catalog.mockClear()
  const before = useTacticStore.getState().document
  const past = useTacticStore.getState().past
  const slider = screen.getByRole('slider', { name: '播放位置' })
  for (const value of [1000, 4000, 7500, 6000, 9500, 3000]) fireEvent.change(slider, { target: { value: String(value) } })
  expect(boosts).not.toHaveBeenCalled()
  expect(geometry).not.toHaveBeenCalled()
  // Store navigation may read cached joints; static catalog is not requested again.
  expect(catalog).not.toHaveBeenCalled()
  expect(useTacticStore.getState().document).toBe(before)
  expect(useTacticStore.getState().past).toBe(past)
})

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

it.each([{ timed: false, geo: false }, { timed: true, geo: false }, { timed: true, geo: true }])('reuses saved route geometry during real timeline scrubs and refreshes after document edits (timed=$timed, geo=$geo)', ({ timed, geo }) => {
  const fixture = createFollowPerformanceFixture()
  const fixtureRun = fixture.actions.find((action) => action.type === 'move' && action.actorId === 'blue-ice')
  if (fixtureRun?.type !== 'move') throw new Error('Missing fixture target run')
  if (timed) fixtureRun.timingConstraint = { kind: 'fixed' }
  useTacticStore.getState().replaceDocument(fixture)
  expect(useTacticStore.getState().document.actions.find((action) => action.id === fixtureRun.id)).toBeDefined()
  useTacticStore.getState().select({ kind: 'player', id: 'red-fire' })
  useTacticStore.getState().setTool('move')
  useTacticStore.getState().createAction('red-fire', { x: 15, y: 8 }, 'blue-ice')
  if (geo) {
    const document = structuredClone(useTacticStore.getState().document)
    for (const player of document.initialScene.players) {
      if (player.id === 'red-water' || player.id === 'red-fire') player.role = 'geo'
    }
    document.actions.push({
      id: 'geo-bounced-flight', type: 'loosePass', actorId: 'blue-ice', startTime: 8, duration: 3,
      aimDirection: { x: 1, y: 0 }, flightOutcome: 'grounded',
      path: [{ x: 17, y: 10 }, { x: 20, y: 10 }, { x: 17, y: 10 }],
    })
    // Keep the resolved chase/zone/flight fixture; shield analysis is advisory.
    useTacticStore.setState({ document })
  }
  const route = vi.spyOn(projection, 'projectedMovePath')
  const slow = vi.spyOn(projection, 'eZoneSlowSegmentsForMove')
  const classification = vi.spyOn(passThreat, 'classifyPassThreat')
  const corridor = vi.spyOn(passThreat, 'buildPassCorridor')
  const solver = vi.spyOn(passReception, 'solvePassReception')
  const timedSolver = vi.spyOn(projection, 'resolveTimedMoveGeometry')
  const shield = vi.spyOn(geoShield, 'analyzeActionGeoShield')
  const { container } = render(<><TacticsBoard /><TimelinePanel /><InspectorPanel /></>)
  const slider = screen.getByRole('slider', { name: '播放位置' })
  const routeCalls = route.mock.calls.length
  const slowCalls = slow.mock.calls.length
  const classificationCalls = classification.mock.calls.length
  const corridorCalls = corridor.mock.calls.length
  const solverCalls = solver.mock.calls.length
  const timedSolverCalls = timedSolver.mock.calls.length
  const shieldCalls = shield.mock.calls.length
  if (geo) expect(shieldCalls).toBeGreaterThan(0)
  expect(routeCalls).toBeGreaterThan(0)
  expect(classificationCalls).toBeGreaterThan(0)
  expect(corridorCalls).toBeGreaterThan(0)
  for (const value of Array.from({ length: timed ? 90 : 6 }, (_, index) => (index * 1543 + 9000) % 10000)) {
    fireEvent.change(slider, { target: { value: String(value) } })
  }
  if (geo) {
    // Paused slider inputs snap to keyframes. Also exercise ninety unique
    // projected times, so a small fixture joint catalog cannot hide work.
    const projectedTimes = new Set<number>()
    for (let index = 0; index < 90; index += 1) {
      const time = ((index * 37) % 90) / 10 + 0.001
      act(() => { useTacticStore.setState({ currentTime: time, currentKeyframe: null }) })
      projectedTimes.add(useTacticStore.getState().currentTime)
    }
    expect(projectedTimes.size).toBe(90)
  }
  expect(route).toHaveBeenCalledTimes(routeCalls)
  expect(slow).toHaveBeenCalledTimes(slowCalls)
  expect(classification).toHaveBeenCalledTimes(classificationCalls)
  expect(corridor).toHaveBeenCalledTimes(corridorCalls)
  expect(solver).toHaveBeenCalledTimes(solverCalls)
  expect(timedSolver).toHaveBeenCalledTimes(timedSolverCalls)
  expect(shield).toHaveBeenCalledTimes(shieldCalls)
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
  if (geo) expect(shield.mock.calls.length).toBeGreaterThan(shieldCalls)
})
