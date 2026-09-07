import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { TacticDocumentV1, Vec2 } from '../domain/model/types'
import { pathLength } from '../domain/geometry/geometry'
import * as passThreat from '../domain/rules/passThreat'
import * as looseFlight from '../domain/timeline/loosePass'
import * as projection from '../domain/timeline/projectFrame'
import * as movementEffects from '../domain/timeline/movementEffects'
import { normalizeBallActions } from '../domain/timeline/looseBall'
import { actionEndTime } from '../domain/timeline/durations'
import { timelineDuration, timelineJointTimes } from '../domain/timeline/keyframes'
import { useTacticStore } from '../editor/useTacticStore'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { TopToolbar } from '../app/TopToolbar'
import { PickupErrorDialog } from '../app/PickupErrorDialog'
import { RosterPanel } from '../app/RosterPanel'
import { TacticsBoard } from './TacticsBoard'

function ErrorHost() {
  const message = useTacticStore((state) => state.pickupError)
  const dismiss = useTacticStore((state) => state.dismissPickupError)
  return message && <PickupErrorDialog message={message} onDismiss={dismiss} />
}

function mountEditor() {
  const view = render(<>
    <TopToolbar libraryReady libraryBusy={false} onOpenLibrary={() => {}} onCreateDocument={async () => {}} onImportDocument={async () => {}} />
    <TacticsBoard /><TimelinePanel /><InspectorPanel /><ErrorHost />
  </>)
  const board = screen.getByRole('application', { name: '战术编辑球场' })
  vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 1072, bottom: 744, width: 1072, height: 744, toJSON: () => ({}),
  })
  return { ...view, board }
}

function placeFreeBall(document: TacticDocumentV1, position: Vec2) {
  document.initialScene.players.forEach((player) => { player.hasBall = false })
  document.initialScene.ball = { position, carrierId: null, isFree: true }
  document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
}

describe('explicit loose-ball board workflow', () => {
  beforeEach(() => {
    const document = createDefaultDocument()
    useTacticStore.setState({ document, selection: null, tool: 'select', boardMode: 'simulation', currentTime: 0, currentKeyframe: null,
      activeStepId: document.stepMarkers[0]!.id, isPlaying: false, showRules: false, showLogic: false,
      showAdvancedTimeline: false, past: [], future: [], notice: null, pickupError: null })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('creates a reflected loose pass through the real toolbar and field click without ordinary-pass threat analysis', () => {
    const classify = vi.spyOn(passThreat, 'classifyPassThreat')
    const { board, container } = mountEditor()
    fireEvent.click(screen.getByRole('button', { name: '空传' }))
    fireEvent.pointerDown(board, { button: 0, clientX: 5.5 * 50 + 36, clientY: 22 })
    const state = useTacticStore.getState()
    const flight = state.document.actions.find((action) => action.type === 'loosePass')
    expect(flight?.type).toBe('loosePass')
    if (flight?.type !== 'loosePass') throw new Error('Loose pass not authored')
    expect(flight.duration).toBeCloseTo(3, 8)
    expect(pathLength(flight.path)).toBeCloseTo(6, 8)
    expect(flight.path[1]).toEqual({ x: 5.5, y: 0 })
    expect(flight.path.at(-1)?.y).toBeCloseTo(1.3, 8)
    expect(state.document.stepMarkers).toHaveLength(2)
    expect(container.querySelector('.action-loosePass')).toBeInTheDocument()
    expect(container.querySelector('.loose-pass-bounce')).toBeInTheDocument()
    expect(classify).not.toHaveBeenCalled()
    act(() => state.select({ kind: 'action', id: flight.id }))
    expect(container.querySelector('.selected-action-layer .path-handle')).not.toBeInTheDocument()
    expect(screen.getByText(/空传不使用普通传球的安全区判定/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '基础模式' }))
    expect(screen.queryByRole('button', { name: '空传' })).not.toBeInTheDocument()
  })

  it.each(['pointer', 'keyboard'] as const)('clicks a stopped ball to author a real run pickup using %s', (input) => {
    const document = createDefaultDocument()
    placeFreeBall(document, { x: 6.5, y: 4.7 })
    useTacticStore.setState({ document })
    mountEditor()
    fireEvent.keyDown(screen.getByRole('button', { name: '蓝方 1，水灵' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: '跑动' }))
    const ball = screen.getByRole('button', { name: '足球' })
    if (input === 'pointer') fireEvent.pointerDown(ball, { button: 0 })
    else fireEvent.keyDown(ball, { key: ' ' })
    const state = useTacticStore.getState()
    const run = state.document.actions.find((action) => action.type === 'move' && action.ballTarget)
    const receipt = state.document.actions.find((action) => action.type === 'receive' && action.pickupActionId === run?.id)
    expect(run?.type).toBe('move')
    expect(receipt?.type).toBe('receive')
    if (run?.type !== 'move' || receipt?.type !== 'receive') throw new Error('Missing pickup pair')
    expect(run.ballTarget).toEqual({ sourceActionId: null })
    expect(receipt.startTime).toBeCloseTo(run.startTime + run.duration, 8)
    expect(projection.projectFrame(state.document, receipt.startTime).ball.carrierId).toBe('blue-water')
    expect(screen.getByRole('button', { name: '选择捡球动作，不移动播放头' })).toBeInTheDocument()
    act(() => state.select({ kind: 'action', id: receipt.id }))
    expect(screen.getByText(/此捡球节点由跑动或 Q 与球的实际接触自动生成/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '高级时间' }))
    const row = screen.getByRole('button', { name: '捡球' }).closest('.action-row')!
    within(row as HTMLElement).getAllByRole('spinbutton').forEach((input) => expect(input).toBeDisabled())
    act(() => useTacticStore.getState().setCurrentTime(receipt.startTime))
    fireEvent.click(screen.getByRole('button', { name: '传球' }))
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-water' })
    expect(useTacticStore.getState().notice).toBeNull()
  })

  it('sweeps a stationary ball with Q, keeps its full distance and completes carrying the ball', () => {
    const document = createDefaultDocument()
    placeFreeBall(document, { x: 6.5, y: 4.7 })
    useTacticStore.setState({ document })
    mountEditor()
    fireEvent.keyDown(screen.getByRole('button', { name: '蓝方 1，水灵' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Q 技能' }))
    fireEvent.keyDown(screen.getByRole('button', { name: '足球' }), { key: 'Enter' })
    const state = useTacticStore.getState()
    const q = state.document.actions.find((action) => action.type === 'qMove')
    if (q?.type !== 'qMove') throw new Error(state.pickupError ?? 'Missing Q')
    expect(pathLength(q.path)).toBeCloseTo(document.rulesSnapshot.roles.water.q.maxDistance, 8)
    const frame = projection.projectFrame(state.document, q.startTime + q.duration)
    expect(frame.ball.carrierId).toBe('blue-water')
    expect(frame.ball.position).toEqual(q.path.at(-1))
    expect(frame.ball.position).not.toEqual(document.initialScene.ball.position)
  })

  it('rejects an unreachable Q in a portal dialog without committing actions, history or layout changes', () => {
    const document = createDefaultDocument()
    placeFreeBall(document, { x: 18, y: 4.7 })
    useTacticStore.setState({ document })
    const { board } = mountEditor()
    fireEvent.keyDown(screen.getByRole('button', { name: '蓝方 1，水灵' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Q 技能' }))
    const before = useTacticStore.getState()
    const viewBox = board.getAttribute('viewBox')
    const ball = screen.getByRole('button', { name: '足球' })
    ball.focus()
    fireEvent.keyDown(ball, { key: 'Enter' })
    const dialog = screen.getByRole('alertdialog', { name: '无法完成捡球' })
    expect(board).not.toContainElement(dialog)
    expect(screen.getByText(/无法用此次 Q 捡到球/)).toBeInTheDocument()
    expect(board).toHaveAttribute('viewBox', viewBox)
    expect(useTacticStore.getState().document).toBe(before.document)
    expect(useTacticStore.getState().past).toBe(before.past)
    const close = within(dialog).getByRole('button', { name: '知道了' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(ball).toHaveFocus()
    expect(useTacticStore.getState().tool).toBe('qMove')
  })

  it('keeps an Ice Q adjustable but rejects a shortened route that no longer crosses the ball', () => {
    const document = createDefaultDocument()
    placeFreeBall(document, { x: 6.5, y: 9.3 })
    useTacticStore.setState({ document })
    const { board, container } = mountEditor()
    fireEvent.keyDown(screen.getByRole('button', { name: '蓝方 3，霜役' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Q 技能' }))
    fireEvent.keyDown(screen.getByRole('button', { name: '足球' }), { key: 'Enter' })
    const q = useTacticStore.getState().document.actions.find((action) => action.type === 'qMove')
    if (q?.type !== 'qMove') throw new Error(useTacticStore.getState().pickupError ?? 'Missing Ice Q')
    act(() => useTacticStore.getState().select({ kind: 'action', id: q.id }))
    expect(screen.getByText('Q 穿球约束')).toBeInTheDocument()

    function dragEndpoint(x: number) {
      const handle = container.querySelectorAll('.selected-action-layer .path-handle-target')[1]!
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1 })
      fireEvent.pointerMove(board, { pointerId: 1, clientX: x * 50 + 36, clientY: 9.3 * 50 + 22 })
      fireEvent.pointerUp(board, { pointerId: 1 })
    }
    dragEndpoint(7.5)
    const valid = useTacticStore.getState()
    const edited = valid.document.actions.find((action) => action.id === q.id)
    expect(edited?.type === 'qMove' && pathLength(edited.path)).toBeCloseTo(2, 8)
    expect(valid.document.actions.some((action) => action.type === 'receive' && action.pickupActionId === q.id)).toBe(true)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    dragEndpoint(5.9)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('无法用此次 Q 捡到球')
    expect(useTacticStore.getState().document).toBe(valid.document)
    expect(useTacticStore.getState().past).toBe(valid.past)
  })

  it('clicks a flying reflected ball as a source-bound chase, not a stale position target', () => {
    const { board } = mountEditor()
    fireEvent.click(screen.getByRole('button', { name: '空传' }))
    fireEvent.pointerDown(board, { button: 0, clientX: 311, clientY: 22 })
    const source = useTacticStore.getState().document.actions.find((action) => action.type === 'loosePass')!
    fireEvent.keyDown(screen.getByRole('button', { name: '蓝方 2，蛮牛' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: '跑动' }))
    const startPosition = projection.projectFrame(useTacticStore.getState().document, useTacticStore.getState().currentTime).ball.position
    fireEvent.pointerDown(screen.getByRole('button', { name: '足球' }), { button: 0 })
    const state = useTacticStore.getState()
    const run = state.document.actions.find((action) => action.type === 'move' && action.ballTarget)
    if (run?.type !== 'move') throw new Error(state.pickupError ?? 'Missing chase')
    expect(run.ballTarget).toEqual({ sourceActionId: source.id })
    expect(run.pickupTrace!.length).toBeGreaterThan(2)
    expect(run.path.at(-1)).not.toEqual(startPosition)
    const receipt = state.document.actions.find((action) => action.type === 'receive' && action.pickupActionId === run.id)!
    const receivedFrame = projection.projectFrame(state.document, receipt.startTime)
    expect(receivedFrame.ball.carrierId).toBe('blue-fire')
    expect(receivedFrame.ball.position).toEqual(receivedFrame.players.find((player) => player.id === 'blue-fire')?.position)
  })

  it('ends an early-picked flight at contact and removes its hypothetical later bounce and landing joints', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 5.5, y: 3.7 }
    document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
    useTacticStore.setState({ document })
    const { board, container } = mountEditor()
    fireEvent.click(screen.getByRole('button', { name: '空传' }))
    fireEvent.pointerDown(board, { button: 0, clientX: 311, clientY: 22 })
    const initial = useTacticStore.getState().document.actions.find((action) => action.type === 'loosePass')
    if (initial?.type !== 'loosePass') throw new Error('Missing loose flight')
    const originalEvents = looseFlight.loosePassJointTimes(initial, document.rulesSnapshot)
    expect(originalEvents).toHaveLength(2)
    expect(container.querySelector('.loose-pass-bounce')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('button', { name: '蓝方 2，蛮牛' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: '跑动' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: '足球' }), { button: 0 })
    const state = useTacticStore.getState()
    const caught = state.document.actions.find((action) => action.type === 'receive' && action.ballSourceActionId === initial.id)
    const flight = state.document.actions.find((action) => action.id === initial.id)
    if (!caught || flight?.type !== 'loosePass') throw new Error(state.pickupError ?? 'Missing early pickup')
    expect(caught.startTime).toBeLessThan(originalEvents[0]!)
    expect(flight.flightOutcome).toBe('pickedUp')
    expect(flight.duration).toBe(caught.startTime - flight.startTime)
    expect(looseFlight.loosePassJointTimes(flight, state.document.rulesSnapshot)).toEqual([caught.startTime])
    expect(timelineDuration(state.document)).toBe(caught.startTime)
    originalEvents.forEach((time) => expect(timelineJointTimes(state.document)).not.toContain(time))
    expect(container.querySelector('.loose-pass-bounce')).not.toBeInTheDocument()
    expect(container.querySelector('.loose-pass-end.pickup-end')).toBeInTheDocument()
    expect(screen.getByText('捡球点')).toBeInTheDocument()
    act(() => useTacticStore.getState().select({ kind: 'action', id: flight.id }))
    expect(screen.getByText(/球已在途中被捡起，飞行在接触时刻结束/)).toBeInTheDocument()
    expect(container.querySelectorAll('.loose-flight-event')).toHaveLength(1)
    expect(container.querySelector('.loose-flight-event')).toHaveAttribute('title', `捡球 ${caught.startTime.toFixed(3)}s`)
  })

  it.each([false, true])('shows an Ice-boost ball tag only when launch eligibility is actually earned (boosted=%s)', (boosted) => {
    const { board, container } = mountEditor()
    if (boosted) {
      fireEvent.click(screen.getByRole('button', { name: '传球' }))
      fireEvent.keyDown(screen.getByRole('button', { name: /蓝方 3，霜役/ }), { key: 'Enter' })
      // The completed pass keeps its author selected. Explicitly choose its
      // receiver; loose-pass activation must not silently replace that actor.
      fireEvent.keyDown(screen.getByRole('button', { name: /蓝方 3，霜役/ }), { key: 'Enter' })
    } else {
      act(() => useTacticStore.getState().givePossession('blue-ice'))
    }
    fireEvent.click(screen.getByRole('button', { name: '空传' }))
    fireEvent.pointerDown(board, { button: 0, clientX: 311, clientY: 14 * 50 + 22 })
    const state = useTacticStore.getState()
    const launch = state.document.actions.find((action) => action.type === 'loosePass')
    expect(launch?.type).toBe('loosePass')
    const source = vi.spyOn(movementEffects, 'looseBallBoostSource')
    // The original receiver's boost has long expired, but a marked loose ball
    // retains a pickup trigger rather than spending a countdown on the ground.
    act(() => useTacticStore.setState({ currentTime: 20 }))
    expect(Boolean(container.querySelector('.ball-boost-indicator'))).toBe(boosted)
    if (boosted) expect(screen.getByText(/携带冰接球加速/)).toHaveTextContent('蓝方捡球后获得 4.3 秒')
    expect(source).not.toHaveBeenCalled()
  })

  it('reuses reflected-flight display and move geometry on distinct forward/backward scrubs', () => {
    const { board } = mountEditor()
    fireEvent.click(screen.getByRole('button', { name: '空传' }))
    fireEvent.pointerDown(board, { button: 0, clientX: 311, clientY: 22 })
    const flight = vi.spyOn(looseFlight, 'resolveLoosePass')
    const joints = vi.spyOn(looseFlight, 'loosePassJointTimes')
    const routes = vi.spyOn(projection, 'projectedMovePath')
    for (const time of [0, 1, 2, 3, 2.3, 1.3, 0.3]) act(() => useTacticStore.setState({ currentTime: time }))
    expect(flight).not.toHaveBeenCalled()
    expect(joints).not.toHaveBeenCalled()
    expect(routes).not.toHaveBeenCalled()
  })

  it.each(['pointer', 'keyboard', 'roster'] as const)('chooses a future receiver for loose passing via %s without an early launch', (input) => {
    const document = createDefaultDocument()
    document.actions = [{ id: 'incoming', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice',
      startTime: 1, duration: 1, path: [{ x: 5.5, y: 4.7 }, { x: 5.5, y: 9.3 }] }]
    normalizeBallActions(document)
    useTacticStore.setState({ document, activeStepId: 'action-step' })
    const { board } = mountEditor()
    const roster = input === 'roster' ? render(<RosterPanel />).container : null
    fireEvent.click(screen.getByRole('button', { name: '空传' }))
    expect(useTacticStore.getState().selection?.id).toBe('blue-water')
    if (input === 'roster') {
      fireEvent.click(within(roster!).getByText('蓝方 3').closest('button')!)
    } else {
      const receiver = screen.getByRole('button', { name: /蓝方 3，霜役/ })
      if (input === 'pointer') fireEvent.pointerDown(receiver, { button: 0 })
      else fireEvent.keyDown(receiver, { key: 'Enter' })
    }
    let state = useTacticStore.getState()
    const catchTime = actionEndTime(document.actions.find((action) => action.id === 'incoming')!)
    expect(state.currentTime).toBe(catchTime)
    expect(state.selection?.id).toBe('blue-ice')
    expect(state.document).toBe(document)
    expect(state.past).toHaveLength(0)
    fireEvent.pointerDown(board, { button: 0, clientX: 12 * 50 + 36, clientY: 9.3 * 50 + 22 })
    state = useTacticStore.getState()
    expect(state.document.actions.find((action) => action.type === 'loosePass')).toMatchObject({
      actorId: 'blue-ice', startTime: catchTime, originReception: { sourceActionId: 'incoming', offset: 0 },
    })
    expect(projection.projectFrame(state.document, catchTime + 0.1).ball.carrierId).toBeNull()
  })
})
