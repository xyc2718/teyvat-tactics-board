import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { MoveAction } from '../domain/model/types'
import { pathLength } from '../domain/geometry/geometry'
import * as moveTiming from '../domain/timeline/moveTiming'
import { useTacticStore } from '../editor/useTacticStore'
import { InspectorPanel } from './InspectorPanel'
import { TimelinePanel } from '../timeline/TimelinePanel'

function prepareRun({ advanced = false, hasQ = true, start = 4, fixed = false } = {}) {
  const document = createDefaultDocument()
  document.rulesSnapshot.roles.water.q.cooldown = 6
  if (hasQ) document.actions.push(
    {
      id: 'source-q', type: 'qMove', actorId: 'blue-water', startTime: 2, duration: 0,
      path: [{ x: 5.5, y: 4.7 }, { x: 8, y: 4.7 }],
    },
    { id: 'carrying-wait', type: 'wait', actorId: 'blue-water', startTime: 2, duration: start - 2 },
  )
  const run: MoveAction = {
    id: 'timed-run', type: 'move', actorId: 'blue-water', startTime: start, duration: 1,
    path: [{ x: 8, y: 4.7 }, { x: 9, y: 4.7 }],
    ...(fixed ? { timingConstraint: { kind: 'fixed' as const } } : {}),
  }
  document.actions.push(run)
  document.stepMarkers.push({
    id: 'action-step', name: '步骤 1', time: 0, note: '', snapshot: structuredClone(document.initialScene),
  })
  useTacticStore.setState({
    document, activeStepId: 'action-step', selection: { kind: 'action', id: run.id },
    currentTime: start, currentKeyframe: null, boardMode: 'simulation', tool: 'select',
    showAdvancedTimeline: advanced, isPlaying: false, past: [], future: [], notice: null,
  })
}

function selectedRun() {
  const run = useTacticStore.getState().document.actions.find((action) => action.id === 'timed-run')
  if (run?.type !== 'move') throw new Error('Expected selected run')
  return run
}

describe('Inspector Q cooldown run timing', () => {
  beforeEach(() => prepareRun())
  afterEach(cleanup)
  afterEach(() => vi.restoreAllMocks())

  it('binds a run to its own Q ready time and refreshes the locked arrow when cooldown changes', () => {
    render(<InspectorPanel />)
    fireEvent.click(screen.getByRole('checkbox', { name: /固定跑动时间/ }))
    const button = screen.getByRole('button', { name: '跑到 Q 冷却结束' })
    expect(button).toBeEnabled()
    fireEvent.click(button)

    expect(selectedRun()).toMatchObject({
      startTime: 4, duration: 4, timingConstraint: { kind: 'qCooldown', sourceActionId: 'source-q' },
    })
    expect(pathLength(selectedRun().path)).toBeCloseTo(4)
    expect(screen.getByText('Q 冷却结束 · 8.00s')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: /持续时间/ })).toBeDisabled()
    expect(button).toHaveAttribute('aria-pressed', 'true')

    act(() => useTacticStore.getState().updateRoleRule('water', 'qCooldown', 7))
    expect(selectedRun().duration).toBeCloseTo(5)
    expect(pathLength(selectedRun().path)).toBeCloseTo(5)
    expect(screen.getByText('Q 冷却结束 · 9.00s')).toBeInTheDocument()
    expect(useTacticStore.getState().document.actions.filter((action) => action.type === 'qMove')).toHaveLength(1)
  })

  it('locks both advanced duration controls and can switch back to manual time', () => {
    prepareRun({ advanced: true, fixed: true })
    render(<InspectorPanel />)
    fireEvent.click(screen.getByRole('button', { name: '跑到 Q 冷却结束' }))
    const durationInputs = screen.getAllByRole('spinbutton', { name: /持续时间/ })
    expect(durationInputs).toHaveLength(2)
    durationInputs.forEach((input) => expect(input).toBeDisabled())
    expect(screen.getByRole('spinbutton', { name: /开始时间/ })).toBeEnabled()

    act(() => useTacticStore.getState().updateRoleRule('water', 'qCooldown', 7))
    expect(selectedRun().duration).toBeCloseTo(5)
    expect(screen.getByText('Q 冷却结束 · 9.00s')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '改为手动时间' }))
    expect(selectedRun()).toMatchObject({ duration: 5, timingConstraint: { kind: 'fixed' } })
    screen.getAllByRole('spinbutton', { name: /持续时间/ }).forEach((input) => expect(input).toBeEnabled())
    expect(screen.queryByText('对齐自身 Q 冷却结束')).not.toBeInTheDocument()
  })

  it.each([
    { hasQ: false, start: 4 },
    { hasQ: true, start: 8 },
  ])('explains unavailable cooldown without changing a run: %j', (options) => {
    prepareRun({ ...options, fixed: true })
    render(<InspectorPanel />)
    const before = useTacticStore.getState().document
    const button = screen.getByRole('button', { name: '跑到 Q 冷却结束' })
    expect(button).toBeDisabled()
    expect(screen.getByText('这段跑动开始时没有尚未结束的 Q 冷却。')).toBeInTheDocument()
    fireEvent.click(button)
    expect(useTacticStore.getState().document).toBe(before)
    expect(useTacticStore.getState().past).toEqual([])
  })

  it('retains the other-player keyframe option after binding cooldown', () => {
    prepareRun({ fixed: true })
    const document = structuredClone(useTacticStore.getState().document)
    document.actions.push({ id: 'red-wait', type: 'wait', actorId: 'red-fire', startTime: 0, duration: 10 })
    useTacticStore.setState({ document })
    render(<InspectorPanel />)
    fireEvent.click(screen.getByRole('button', { name: '跑到 Q 冷却结束' }))
    fireEvent.click(screen.getByRole('button', { name: '选择其他球员关键帧' }))
    fireEvent.click(screen.getByRole('tab', { name: '红方 2' }))
    fireEvent.click(screen.getByRole('button', { name: '等待结束10.00s' }))
    expect(selectedRun()).toMatchObject({
      duration: 6,
      timingConstraint: { kind: 'keyframe', reference: { playerId: 'red-fire', actionId: 'red-wait', edge: 'end' } },
    })
    expect(screen.queryByText('对齐自身 Q 冷却结束')).not.toBeInTheDocument()
  })

  it('does not resolve cooldown targets again on playhead-only renders', () => {
    prepareRun({ fixed: true })
    const find = vi.spyOn(moveTiming, 'findMoveQCooldownTarget')
    const resolve = vi.spyOn(moveTiming, 'resolveMoveQCooldownTarget')
    render(<InspectorPanel />)
    fireEvent.click(screen.getByRole('button', { name: '跑到 Q 冷却结束' }))
    find.mockClear()
    resolve.mockClear()
    for (const currentTime of [4.5, 6, 7, 4, 8]) {
      act(() => useTacticStore.setState({ currentTime }))
    }
    expect(find).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('keeps the advanced timeline duration read-only until switching to manual time', () => {
    prepareRun({ advanced: true, fixed: true })
    useTacticStore.getState().setMoveTimingQCooldown('timed-run')
    render(<TimelinePanel />)
    const input = screen.getByTitle('由自身 Q 冷却结束时刻自动计算')
    expect(input).toBeDisabled()
    expect(input).toHaveValue(4)
    act(() => useTacticStore.getState().setMoveTimingFixed('timed-run', true))
    expect(input).toBeEnabled()
  })
})
