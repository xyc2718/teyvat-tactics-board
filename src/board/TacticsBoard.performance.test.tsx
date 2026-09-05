import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as projection from '../domain/timeline/projectFrame'
import { useTacticStore } from '../editor/useTacticStore'
import { createFollowPerformanceFixture } from '../test/followPerformanceFixture'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { TacticsBoard } from './TacticsBoard'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('reuses saved route geometry during real timeline scrubs and refreshes after document edits', () => {
  useTacticStore.getState().replaceDocument(createFollowPerformanceFixture())
  useTacticStore.getState().select({ kind: 'player', id: 'red-fire' })
  useTacticStore.getState().setTool('move')
  useTacticStore.getState().createAction('red-fire', { x: 15, y: 8 }, 'blue-ice')
  const route = vi.spyOn(projection, 'projectedMovePath')
  const slow = vi.spyOn(projection, 'eZoneSlowSegmentsForMove')
  const { container } = render(<><TacticsBoard /><TimelinePanel /><InspectorPanel /></>)
  const slider = screen.getByRole('slider', { name: '播放位置' })
  const routeCalls = route.mock.calls.length
  const slowCalls = slow.mock.calls.length
  expect(routeCalls).toBeGreaterThan(0)
  for (const value of [9000, 5000, 3000, 6500, 2000, 4000]) {
    fireEvent.change(slider, { target: { value: String(value) } })
  }
  expect(route).toHaveBeenCalledTimes(routeCalls)
  expect(slow).toHaveBeenCalledTimes(slowCalls)
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
})
