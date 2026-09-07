import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { MoveAction, WaitAction } from '../domain/model/types'
import { pathLength } from '../domain/geometry/geometry'
import { projectFrame } from '../domain/timeline/projectFrame'
import * as timingKeyframes from '../domain/timeline/timingKeyframes'
import { useTacticStore } from '../editor/useTacticStore'
import { InspectorPanel } from './InspectorPanel'
import { TimelinePanel } from '../timeline/TimelinePanel'

function prepare(type: 'wait' | 'move' = 'wait', advanced = false) {
  const document = createDefaultDocument()
  const action: WaitAction | MoveAction = type === 'wait'
    ? { id: 'timed-action', type: 'wait', actorId: 'blue-water', startTime: 1, duration: 1 }
    : {
        id: 'timed-action', type: 'move', actorId: 'blue-water', startTime: 1, duration: 1,
        path: [{ x: 8, y: 4.7 }, { x: 9, y: 4.7 }], timingConstraint: { kind: 'fixed' },
      }
  document.actions.push(
    { id: 'own-q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }] },
    action,
    { id: 'independent-wait', type: 'wait', actorId: 'red-fire', startTime: 0, duration: 5 },
  )
  document.stepMarkers.push({ id: 'action-step', time: 0, name: '步骤 1', note: '', snapshot: structuredClone(document.initialScene) })
  useTacticStore.setState({
    document, selection: { kind: 'action', id: action.id }, currentTime: 1, currentKeyframe: null,
    activeStepId: 'action-step', boardMode: 'simulation', tool: 'select', isPlaying: false,
    showAdvancedTimeline: advanced, past: [], future: [], notice: null,
  })
}

function timedAction() {
  const action = useTacticStore.getState().document.actions.find((candidate) => candidate.id === 'timed-action')
  if (action?.type !== 'wait' && action?.type !== 'move') throw new Error('Expected timed action')
  return action
}

describe('shared wait and run keyframe picker', () => {
  beforeEach(() => prepare())
  afterEach(cleanup)
  afterEach(() => vi.restoreAllMocks())

  it('defaults to self, identifies all six roles, and waits until own boost ends', () => {
    render(<InspectorPanel />)
    const trigger = screen.getByRole('button', { name: '等待到关键帧' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '选择等待结束关键帧' })
    const tabs = within(dialog).getAllByRole('tab')
    expect(tabs).toHaveLength(6)
    expect(within(dialog).getByRole('tab', { name: '蓝方 1 · 水·水灵（自己）' })).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog).getByRole('tab', { name: '蓝方 3 · 冰·霜役' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /等待结束.*2.00s/ })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: /加速结束.*4.30s/ }))
    expect(timedAction()).toMatchObject({ startTime: 1, duration: 3.3, timingConstraint: { kind: 'keyframe' } })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(screen.getByRole('spinbutton', { name: /等待时长/ })).toBeDisabled()
    expect(screen.getByText(/蓝方 1 · 水·水灵 · .*加速结束.*4.30s/)).toBeInTheDocument()
    const frame = projectFrame(useTacticStore.getState().document, 3)
    expect(frame.players.find((player) => player.id === 'blue-water')?.position).toEqual({ x: 8, y: 4.7 })
    fireEvent.click(screen.getByRole('button', { name: '改为手动时间' }))
    expect(timedAction().timingConstraint).toBeUndefined()
    expect(screen.getByRole('spinbutton', { name: /等待时长/ })).toBeEnabled()
    expect(timedAction().duration).toBeCloseTo(3.3)
  })

  it.each([false, true])('updates other-player waiting bindings and locks derived durations (advanced=%s)', (advanced) => {
    prepare('wait', advanced)
    render(<><InspectorPanel /><TimelinePanel /></>)
    fireEvent.click(screen.getByRole('button', { name: '等待到关键帧' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('tab', { name: '红方 2 · 火·蛮牛' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '等待结束5.00s' }))
    expect(timedAction()).toMatchObject({ startTime: 1, duration: 4 })
    if (advanced) expect(screen.getByTitle('由所选关键帧自动解算')).toBeDisabled()
    act(() => useTacticStore.getState().updateActionTiming('independent-wait', 'duration', 6))
    expect(timedAction()).toMatchObject({ startTime: 1, duration: 5 })
    act(() => useTacticStore.getState().undo())
    expect(timedAction().duration).toBeCloseTo(4)
    act(() => useTacticStore.getState().redo())
    expect(timedAction().duration).toBeCloseTo(5)
  })

  it('aligns a run to its own boost end using actual speed and keeps role labels live', () => {
    prepare('move')
    render(<InspectorPanel />)
    fireEvent.click(screen.getByRole('button', { name: '选择关键帧' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /加速结束.*4.30s/ }))
    const action = timedAction()
    if (action.type !== 'move') throw new Error('Expected move')
    expect(action.startTime).toBe(1)
    expect(action.duration).toBeCloseTo(3.3)
    expect(pathLength(action.path)).toBeCloseTo(3.3 + 3.3 / 4.3 * 0.8)
    act(() => {
      const document = structuredClone(useTacticStore.getState().document)
      document.initialScene.players.find((player) => player.id === 'blue-water')!.name = '持球队员'
      useTacticStore.setState({ document })
    })
    expect(screen.getByText(/持球队员 · 水·水灵 · .*加速结束/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '更换关键帧' }))
    expect(within(screen.getByRole('dialog')).getByRole('tab', { name: '持球队员 · 水·水灵（自己）' })).toHaveAttribute('aria-selected', 'true')
  })

  it('cancels with Escape, restores focus and leaves document/history unchanged', () => {
    render(<InspectorPanel />)
    const before = useTacticStore.getState().document
    const trigger = screen.getByRole('button', { name: '等待到关键帧' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: '关闭关键帧选择' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(useTacticStore.getState().document).toBe(before)
    expect(useTacticStore.getState().past).toEqual([])
  })

  it('updates a bound player role in the summary, tabs and selected lane', () => {
    render(<InspectorPanel />)
    fireEvent.click(screen.getByRole('button', { name: '等待到关键帧' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('tab', { name: '红方 2 · 火·蛮牛' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '等待结束5.00s' }))
    act(() => useTacticStore.getState().setPlayerRole('red-fire', 'ice'))
    expect(screen.getByText(/红方 2 · 冰·霜役 · 等待结束 · 5.00s/)).toBeInTheDocument()
    expect(timedAction()).toMatchObject({ startTime: 1, duration: 4, timingConstraint: { kind: 'keyframe' } })
    fireEvent.click(screen.getByRole('button', { name: '更换关键帧' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('tab', { name: '红方 2 · 冰·霜役' })).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog).getByLabelText('红方 2 · 冰·霜役时间轴')).toBeInTheDocument()
    expect(within(dialog).queryByRole('tab', { name: '红方 2 · 火·蛮牛' })).not.toBeInTheDocument()
  })

  it('wraps keyboard focus and cancels from the backdrop without changing the tactic', () => {
    render(<InspectorPanel />)
    const before = useTacticStore.getState().document
    const trigger = screen.getByRole('button', { name: '等待到关键帧' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    const first = within(dialog).getByRole('button', { name: '关闭关键帧选择' })
    const last = within(dialog).getAllByRole('button').filter((button) => !button.hasAttribute('disabled')).at(-1)!
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.mouseDown(dialog)
    expect(dialog).toBeInTheDocument()
    fireEvent.mouseDown(dialog.parentElement!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(useTacticStore.getState().document).toBe(before)
    expect(useTacticStore.getState().past).toEqual([])
  })

  it('does not rebuild picker candidates on playhead-only renders', () => {
    const catalog = vi.spyOn(timingKeyframes, 'playerTimingKeyframes')
    const validator = vi.spyOn(timingKeyframes, 'createTimingTargetValidator')
    render(<InspectorPanel />)
    fireEvent.click(screen.getByRole('button', { name: '等待到关键帧' }))
    catalog.mockClear()
    validator.mockClear()
    for (const currentTime of [1, 2, 3, 4.3, 2]) act(() => useTacticStore.setState({ currentTime }))
    expect(catalog).not.toHaveBeenCalled()
    expect(validator).not.toHaveBeenCalled()
  })
})
