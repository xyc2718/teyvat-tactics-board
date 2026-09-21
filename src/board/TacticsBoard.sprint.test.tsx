import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { MoveAction } from '../domain/model/types'
import { pathLength, resolvedMovePath } from '../domain/geometry/geometry'
import * as normalization from '../domain/timeline/looseBall'
import { useTacticStore } from '../editor/useTacticStore'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { TopToolbar } from '../app/TopToolbar'
import { RosterPanel } from '../app/RosterPanel'
import { TacticsBoard } from './TacticsBoard'

function mount() {
  return render(<>
    <TopToolbar libraryReady libraryBusy={false} onOpenLibrary={() => {}} onCreateDocument={async () => {}} onImportDocument={async () => {}} />
    <RosterPanel /><TacticsBoard /><InspectorPanel /><TimelinePanel />
  </>)
}
function currentSprint() {
  return useTacticStore.getState().document.actions.find((a) => a.type === 'move' && a.sprint) as MoveAction
}
describe('Electro sprint UI', () => {
  beforeEach(() => {
    const document = createDefaultDocument()
    const actor = document.initialScene.players.find((p) => p.id === 'blue-fire')!
    actor.role = 'electro'; actor.position = { x: 5, y: 7 }
    document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
    useTacticStore.setState({ document, selection: null, tool: 'select', boardMode: 'simulation', currentTime: 0, currentKeyframe: null,
      activeStepId: document.stepMarkers[0]!.id, isPlaying: false, showRules: false, showLogic: false,
      showAdvancedTimeline: false, past: [], future: [], notice: null, pickupError: null })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('authors with toolbar, keyboard actor and pointer target, exposes energy and distinct trace, and hides E in basic mode', () => {
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: '雷 E' }))
    fireEvent.keyDown(screen.getByRole('button', { name: '蓝方 2，雷，可选施法者' }), { key: 'Enter' })
    expect(container.querySelector('.sprint-preview-range')).toBeInTheDocument()
    const board = container.querySelector('svg.tactics-board')!
    fireEvent.pointerDown(board, { button: 0, clientX: 13 * 50 + 36, clientY: 7 * 50 + 22 })
    const action = currentSprint()
    expect(action).toBeDefined()
    expect(action.duration).toBeCloseTo(3.8)
    expect(container.querySelector('.action-sprint')).toBeInTheDocument()
    expect(container.querySelector('.type-sprint')).toBeInTheDocument()
    expect(screen.getByLabelText('雷 E 能量百分比')).toHaveAttribute('value', '0')
    expect(screen.getByText('步骤 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '基础模式' }))
    expect(screen.queryByRole('button', { name: '雷 E' })).not.toBeInTheDocument()
  })

  it('supports curve and fixed time editing and stops E without changing normal run tools', () => {
    const { container } = mount()
    act(() => {
      useTacticStore.getState().select({ kind: 'player', id: 'blue-fire' })
      useTacticStore.getState().setTool('sprint')
      useTacticStore.getState().createAction('blue-fire', { x: 11, y: 7 })
      useTacticStore.getState().select({ kind: 'action', id: currentSprint().id })
    })
    fireEvent.click(screen.getByRole('button', { name: '可调曲线' }))
    expect(container.querySelector('.curve-handle')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /固定冲刺时间/ }))
    const inspector = within(container.querySelector('#inspector-panel') as HTMLElement)
    fireEvent.change(inspector.getByLabelText(/持续时间/), { target: { value: '1.9' } })
    expect(pathLength(resolvedMovePath(currentSprint()))).toBeCloseTo(4, 3)
    fireEvent.change(inspector.getByLabelText(/冲刺多久后停止/), { target: { value: '.95' } })
    fireEvent.click(screen.getByRole('button', { name: '在此停止雷 E' }))
    expect(currentSprint().duration).toBeCloseTo(.95)
  })

  it.each(['blue-fire', 'blue-water'])('can select Electro E ready from the %s wait timing dialog', (waiterId) => {
    mount()
    act(() => {
      useTacticStore.getState().select({ kind: 'player', id: 'blue-fire' })
      useTacticStore.getState().setTool('sprint')
      useTacticStore.getState().createAction('blue-fire', { x: 13, y: 7 })
      useTacticStore.getState().select({ kind: 'player', id: waiterId })
      useTacticStore.getState().setTool('wait')
      const wait = useTacticStore.getState().document.actions.find((a) => a.type === 'wait')!
      useTacticStore.getState().select({ kind: 'action', id: wait.id })
    })
    fireEvent.click(screen.getByRole('button', { name: '等待到关键帧' }))
    const dialog = within(screen.getByRole('dialog', { name: '选择等待结束关键帧' }))
    fireEvent.click(dialog.getByRole('tab', { name: /蓝方 2.*雷/ }))
    fireEvent.click(dialog.getByRole('button', { name: '雷 E 冷却结束 7.80秒' }))
    const wait = useTacticStore.getState().document.actions.find((a) => a.type === 'wait')!
    expect(wait.startTime + wait.duration).toBeCloseTo(7.8)
    expect(wait.type === 'wait' && wait.timingConstraint?.reference).toMatchObject({ event: 'eReady', playerId: 'blue-fire' })
  })

  it('warm scrubs reuse saved sprint geometry without normalizing ball flights', () => {
    mount()
    act(() => {
      useTacticStore.getState().select({ kind: 'player', id: 'blue-fire' })
      useTacticStore.getState().setTool('sprint')
      useTacticStore.getState().createAction('blue-fire', { x: 13, y: 7 })
    })
    const spy = vi.spyOn(normalization, 'normalizeBallActions')
    for (let i = 0; i < 90; i++) act(() => useTacticStore.setState({ currentTime: (i % 45) / 10, isPlaying: true }))
    expect(spy).not.toHaveBeenCalled()
  })
})
