import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { useTacticStore } from '../editor/useTacticStore'
import { TimelinePanel } from './TimelinePanel'

describe('TimelinePanel player tracks', () => {
  afterEach(cleanup)

  beforeEach(() => {
    const document = createDefaultDocument()
    document.actions.push(
      {
        id: 'water-run',
        type: 'move',
        actorId: 'blue-water',
        startTime: 0,
        duration: 2,
        path: [{ x: 5.5, y: 5 }, { x: 7.5, y: 5 }],
      },
      {
        id: 'fire-run',
        type: 'move',
        actorId: 'blue-fire',
        startTime: 0,
        duration: 4,
        path: [{ x: 3.5, y: 2.7 }, { x: 7.5, y: 2.7 }],
      },
    )
    useTacticStore.setState({
      document,
      selection: null,
      tool: 'select',
      boardMode: 'simulation',
      activeStepId: document.stepMarkers[0]!.id,
      currentTime: 2,
      isPlaying: false,
      showAdvancedTimeline: false,
      notice: null,
      past: [],
      future: [],
    })
  })

  it('switches the visible player track without moving the global playhead', () => {
    render(<TimelinePanel />)

    fireEvent.click(screen.getByRole('tab', { name: '查看蓝方 2个人轨道' }))

    expect(useTacticStore.getState().currentTime).toBe(2)
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    expect(screen.getByLabelText('蓝方 2动作轨道')).toBeInTheDocument()
    expect(screen.getByText(/续编点 4\.00s/)).toBeInTheDocument()
  })

  it('keeps implementation guidance out of the opening step UI', () => {
    render(<TimelinePanel />)

    expect(screen.queryByText('静止帧 · 仅布置位置')).not.toBeInTheDocument()
    expect(screen.queryByText('初始站位是静止帧')).not.toBeInTheDocument()
    expect(screen.getByText('初始站位').closest('.step-card')).not.toHaveTextContent('0.00s')
  })

  it('shows and navigates to the end of the actions currently owned by a step', () => {
    const document = useTacticStore.getState().document
    const actionStep = { id: 'display-step', time: 0, name: '步骤 2', note: '', snapshot: structuredClone(document.initialScene) }
    document.stepMarkers.push(actionStep)
    useTacticStore.setState({ document, activeStepId: actionStep.id, currentTime: 0 })
    render(<TimelinePanel />)

    const stepCard = screen.getByText('步骤 2').closest('.step-card')
    expect(stepCard).toHaveTextContent('4.00s')
    fireEvent.click(stepCard!)
    expect(useTacticStore.getState().currentTime).toBe(4)
  })

  it('jumps to that player continuation joint only when move or Q is activated', () => {
    render(<TimelinePanel />)
    fireEvent.click(screen.getByRole('tab', { name: '查看蓝方 2个人轨道' }))
    expect(useTacticStore.getState().currentTime).toBe(2)

    act(() => useTacticStore.getState().setTool('move'))

    expect(useTacticStore.getState()).toMatchObject({
      currentTime: 4,
      tool: 'move',
      selection: { kind: 'player', id: 'blue-fire' },
    })
  })

  it('uses the player continuation joint when Move/Q is activated in advanced time too', () => {
    render(<TimelinePanel />)
    fireEvent.click(screen.getByRole('tab', { name: '查看蓝方 2个人轨道' }))
    fireEvent.click(screen.getByRole('button', { name: '高级时间' }))
    expect(useTacticStore.getState().currentTime).toBe(2)

    act(() => useTacticStore.getState().setTool('qMove'))

    expect(useTacticStore.getState()).toMatchObject({
      currentTime: 4,
      tool: 'qMove',
      selection: { kind: 'player', id: 'blue-fire' },
    })
  })

  it('uses the right-side track tabs as Move/Q actor switching while the workflow is active', () => {
    render(<TimelinePanel />)
    fireEvent.click(screen.getByRole('tab', { name: '查看蓝方 2个人轨道' }))
    act(() => useTacticStore.getState().setTool('qMove'))
    expect(useTacticStore.getState().currentTime).toBe(4)

    fireEvent.click(screen.getByRole('tab', { name: '查看蓝方 3个人轨道' }))
    expect(useTacticStore.getState()).toMatchObject({
      tool: 'qMove',
      selection: { kind: 'player', id: 'blue-ice' },
      currentTime: 0,
    })

    fireEvent.click(screen.getByRole('tab', { name: '总览' }))
    expect(useTacticStore.getState()).toMatchObject({ tool: 'qMove', selection: null, currentTime: 0 })
  })

  it('selects a track action for editing without using it as time navigation', () => {
    render(<TimelinePanel />)
    fireEvent.click(screen.getByRole('tab', { name: '查看蓝方 2个人轨道' }))
    fireEvent.click(screen.getByRole('button', { name: '选择跑动动作，不移动播放头' }))

    expect(useTacticStore.getState().currentTime).toBe(2)
    expect(useTacticStore.getState().selection).toEqual({ kind: 'action', id: 'fire-run' })
    expect(screen.getByLabelText('蓝方 2动作轨道')).toBeInTheDocument()
  })

  it('shows every actor keyframe on the global overview and filters precise timing by player', () => {
    const { container } = render(<TimelinePanel />)
    expect(container.querySelectorAll('.global-player-ticks [data-player-id="blue-water"]')).toHaveLength(2)
    expect(container.querySelectorAll('.global-player-ticks [data-player-id="blue-fire"]')).toHaveLength(2)

    fireEvent.click(screen.getByRole('tab', { name: '查看蓝方 2个人轨道' }))
    fireEvent.click(screen.getByRole('button', { name: '高级时间' }))

    expect(container.querySelector('.action-row[data-timeline-action-id="fire-run"]')).toBeInTheDocument()
    expect(container.querySelector('.action-row[data-timeline-action-id="water-run"]')).not.toBeInTheDocument()
    expect(screen.getByText('蓝方 2 · 精确时序')).toBeInTheDocument()
  })

  it('shows readable time labels and highlights the continuation keyframe on a selected player track', () => {
    const { container } = render(<TimelinePanel />)
    fireEvent.click(screen.getByRole('tab', { name: '查看蓝方 2个人轨道' }))

    const labels = Array.from(container.querySelectorAll('.player-track-keyframe-marker b'))
      .map((label) => label.textContent)
    expect(labels).toEqual(['0.00s', '4.00s · 续接'])
    expect(container.querySelector('.player-track-keyframe-marker.continuation')).toHaveTextContent('4.00s · 续接')
  })
})
