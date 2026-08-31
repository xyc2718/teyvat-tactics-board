import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { EZoneAction, MoveAction, PassAction, QMoveAction } from '../domain/model/types'
import { useTacticStore } from '../editor/useTacticStore'
import { App } from './App'

describe('App shell', () => {
  afterEach(cleanup)
  beforeEach(() => {
    const document = createDefaultDocument()
    useTacticStore.setState({
      document,
      selection: null,
      tool: 'select',
      boardMode: 'simulation',
      activeStepId: document.stepMarkers[0]!.id,
      currentTime: 0,
      isPlaying: false,
      showRules: false,
      showLogic: false,
      showAdvancedTools: false,
      showAdvancedTimeline: false,
      notice: null,
      past: [],
      future: [],
    })
  })

  it('renders a usable 3v3 board with simple tools first', () => {
    const { container } = render(<App />)
    expect(screen.getByRole('application', { name: '战术编辑球场' })).toHaveAttribute('viewBox', '-36 -22 1072 744')
    expect(screen.getByLabelText('20 乘 14 格战术球场')).toBeInTheDocument()
    expect(container.querySelector('.pitch')).toHaveAttribute('height', '700')
    expect(screen.getAllByRole('button', { name: /蓝方/ })).toHaveLength(6)
    expect(screen.getByRole('button', { name: '跑动' })).toBeInTheDocument()
    expect(screen.queryByText('语义动作轨道')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '推演模式' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Version 0.1.0, Developer xyc')).toHaveTextContent('v0.1.0 · Developer: xyc')
  })

  it('uses the projected carrier for the possession button even when an imported flag is stale', () => {
    const document = createDefaultDocument()
    const carrier = document.initialScene.players.find((player) => player.id === 'red-fire')!
    for (const player of document.initialScene.players) player.hasBall = false
    document.initialScene.ball = { carrierId: carrier.id, position: { ...carrier.position }, isFree: false }
    useTacticStore.setState({ document, selection: { kind: 'player', id: carrier.id } })
    render(<App />)

    const possessionButton = screen.getByRole('button', { name: '放下球权' })
    expect(possessionButton).toHaveClass('active')
    fireEvent.click(possessionButton)
    expect(useTacticStore.getState().document.initialScene.ball.carrierId).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '设为持球者' }))
    expect(useTacticStore.getState().document.initialScene.ball.carrierId).toBe(carrier.id)
  })

  it('switches to a player-only basic board with persistent static move arrows and no timeline', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'hidden-timeline-move', type: 'move', actorId: 'blue-water', startTime: 0, duration: 2,
      path: [{ x: 5.5, y: 5 }, { x: 7.5, y: 5 }],
    })
    document.staticMoveArrows.push({ id: 'basic-arrow', playerId: 'blue-water', target: { x: 9, y: 4 } })
    useTacticStore.setState({ document })
    const { container } = render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '基础模式' }))
    expect(useTacticStore.getState().boardMode).toBe('basic')
    expect(screen.getByRole('button', { name: '基础模式' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '移动箭头' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Q 位移' })).not.toBeInTheDocument()
    expect(container.querySelector('.timeline-panel')).not.toBeInTheDocument()
    expect(container.querySelector('.roster-panel')).not.toBeInTheDocument()
    expect(container.querySelector('.inspector-panel')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.player-token')).toHaveLength(6)
    expect(container.querySelector('.ball-token')).not.toBeInTheDocument()
    expect(container.querySelector('[data-action-id="hidden-timeline-move"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-static-arrow-id="basic-arrow"]')).toBeInTheDocument()
    expect(screen.getByText('1 个移动箭头')).toBeInTheDocument()

    act(() => useTacticStore.setState({ selection: { kind: 'staticArrow', id: 'basic-arrow' } }))
    fireEvent.click(screen.getByRole('button', { name: '删除所选箭头' }))
    expect(useTacticStore.getState().document.staticMoveArrows).toEqual([])
  })

  it('keeps step deletion available when only the opening step remains', () => {
    const document = createDefaultDocument()
    document.stepMarkers[0]!.time = 8.56
    document.stepMarkers[0]!.name = '步骤 3'
    useTacticStore.setState({ document, activeStepId: document.stepMarkers[0]!.id, currentTime: 8.56, past: [], future: [] })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '删除当前步骤并恢复初始站位' }))
    const state = useTacticStore.getState()
    expect(state.document.stepMarkers).toHaveLength(1)
    expect(state.document.stepMarkers[0]).toMatchObject({ time: 0, name: '初始站位' })
    expect(state.currentTime).toBe(0)
    expect(state.past).toHaveLength(1)
  })

  it('opens analysis and rule parameters only on demand', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '分析层' }))
    expect(useTacticStore.getState().document.view.analysis).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '规则设置' }))
    expect(screen.getByRole('dialog', { name: '规则设置' })).toBeInTheDocument()
    expect(screen.getByText('基础移速')).toBeInTheDocument()
    expect(screen.getByText('E 圈内敌方 Q 距离')).toBeInTheDocument()
  })

  it('renders the opening setup as a disabled zero-second timeline', () => {
    render(<App />)

    expect(screen.getByLabelText('播放位置')).toBeDisabled()
    expect(screen.getByRole('button', { name: '播放' })).toBeInTheDocument()
    expect(screen.getAllByText('0.00s').length).toBeGreaterThan(0)
  })

  it('adds a wait from the selected player and exposes its duration directly', () => {
    render(<App />)
    fireEvent.pointerDown(screen.getByRole('button', { name: /蓝方 2，蛮牛/ }), { pointerId: 1, button: 0 })
    fireEvent.click(screen.getByRole('button', { name: '等待' }))

    expect(useTacticStore.getState().document.actions[0]).toMatchObject({ type: 'wait', actorId: 'blue-fire', duration: 1 })
    expect(screen.getByText('等待时长')).toBeInTheDocument()
  })

  it('hides unrelated future arrows while paused and reveals the path at its joint', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'future-path', type: 'move', actorId: 'blue-fire', startTime: 5, duration: 2,
      path: [{ x: 3.5, y: 2.7 }, { x: 5.5, y: 2.7 }],
    })
    useTacticStore.setState({ document, currentTime: 0 })
    const { container } = render(<App />)
    expect(container.querySelector('[data-action-id="future-path"]')).not.toBeInTheDocument()

    act(() => useTacticStore.getState().setCurrentTime(5))
    expect(container.querySelector('[data-action-id="future-path"] .action-move')).toBeInTheDocument()
  })

  it('guides a tool-first Q workflow without a virtual arrow and resets after creation', () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Q 位移' }))
    expect(screen.getByRole('status')).toHaveTextContent('1 / 2')

    fireEvent.pointerDown(screen.getByRole('button', { name: /蓝方 2，蛮牛/ }), { pointerId: 1, button: 0 })
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    expect(screen.getByRole('status')).toHaveTextContent('2 / 2')

    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    fireEvent.pointerMove(board, { clientX: 650, clientY: 270, pointerId: 1 })
    expect(container.querySelector('.q-preview-range')).toBeInTheDocument()
    expect(container.querySelector('.q-preview-path')).not.toBeInTheDocument()
    expect(container.querySelector('#arrow-q-preview')).not.toBeInTheDocument()
    fireEvent.pointerDown(board, { clientX: 650, clientY: 270, pointerId: 1, button: 0 })

    expect(useTacticStore.getState().document.actions[0]).toMatchObject({ type: 'qMove', actorId: 'blue-fire' })
    expect(container.querySelector('.action-qMove')).toHaveAttribute('marker-end', 'url(#arrow-q)')
    expect(container.querySelector('.q-preview-path')).not.toBeInTheDocument()
    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    expect(container.querySelector('.board-workflow-guide')).not.toBeInTheDocument()
  })

  it('lets the actor-selection stage choose an existing move endpoint as its actor node', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'clickable-run-end',
      type: 'move',
      actorId: 'blue-fire',
      startTime: 0,
      duration: 2,
      path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }],
    })
    useTacticStore.setState({ document, currentTime: 0, selection: null })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Q 位移' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: '从跑动终点续接Q 位移' }), { button: 0, pointerId: 31 })

    expect(useTacticStore.getState()).toMatchObject({
      currentTime: 2,
      selection: { kind: 'player', id: 'blue-fire' },
      tool: 'qMove',
    })
    expect(screen.getByRole('status')).toHaveTextContent('2 / 2')
  })

  it('does not let another action endpoint intercept a chosen water Q landing point', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'other-player-run-end',
      type: 'move',
      actorId: 'blue-fire',
      startTime: 0,
      duration: 2,
      path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }],
    })
    useTacticStore.setState({
      document,
      currentTime: 0,
      selection: { kind: 'player', id: 'blue-water' },
    })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Q 位移' }))
    expect(screen.getByRole('status')).toHaveTextContent('2 / 2')
    expect(screen.queryByRole('button', { name: '从跑动终点续接Q 位移' })).not.toBeInTheDocument()

    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    fireEvent.pointerDown(board, { clientX: 311, clientY: 257, pointerId: 32, button: 0 })

    const q = useTacticStore.getState().document.actions.at(-1)
    expect(q).toMatchObject({ type: 'qMove', actorId: 'blue-water' })
    if (q?.type === 'qMove') expect(q.path.at(-1)).toEqual({ x: 5.5, y: 4.7 })
  })

  it('saves a cooldown-delayed Q from the projected final origin without a virtual arrow', () => {
    const document = createDefaultDocument()
    document.actions.push(
      { id: 'existing-water-q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] },
      { id: 'existing-water-move', type: 'move', actorId: 'blue-water', startTime: 0, duration: 4, path: [{ x: 8, y: 5 }, { x: 12, y: 5 }] },
    )
    useTacticStore.setState({ document, selection: { kind: 'player', id: 'blue-water' } })
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Q 位移' }))
    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    fireEvent.pointerMove(board, { clientX: 736, clientY: 272, pointerId: 1 })

    expect(container.querySelector('.q-preview-path')).not.toBeInTheDocument()
    fireEvent.pointerDown(board, { clientX: 736, clientY: 272, pointerId: 1, button: 0 })
    const saved = useTacticStore.getState().document.actions.at(-1)
    expect(saved).toMatchObject({ type: 'qMove', startTime: 7 })
    if (saved?.type === 'qMove') expect(saved.path[0]).toEqual({ x: 12, y: 5 })
  })

  it('auto-selects the ball carrier and highlights only teammate pass targets', () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '传球' }))

    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-water' })
    expect(container.querySelectorAll('.player-token.tool-target-eligible')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('参考安全/最远距离圈')

    fireEvent.pointerDown(screen.getByRole('button', { name: /红方 1，水灵/ }), { pointerId: 1, button: 0 })
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    expect(useTacticStore.getState().tool).toBe('pass')
  })

  it('highlights only Frost actors for ice E and activates the follow zone in one click', () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /更多/ }))
    fireEvent.click(screen.getByRole('button', { name: '冰圈' }))

    expect(container.querySelectorAll('.player-token.tool-eligible')).toHaveLength(2)
    expect(container.querySelectorAll('.player-token.tool-ineligible')).toHaveLength(4)
    fireEvent.pointerDown(screen.getByRole('button', { name: /蓝方 2，蛮牛/ }), { pointerId: 1, button: 0 })
    expect(useTacticStore.getState().selection).toBeNull()
    expect(useTacticStore.getState().document.actions).toHaveLength(0)

    fireEvent.pointerDown(screen.getByRole('button', { name: /蓝方 3，霜役/ }), { pointerId: 1, button: 0 })
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-ice' })
    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().document.actions[0]).toMatchObject({ type: 'eZone', actorId: 'blue-ice' })
    expect(container.querySelector('.ice-zone.active')).toBeInTheDocument()
    expect(container.querySelector('.board-workflow-guide')).not.toBeInTheDocument()
  })

  it('renders an active ice zone at the live projected Frost position instead of its legacy snapshot', () => {
    const document = createDefaultDocument()
    const ice = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    ice.position = { x: 5, y: 5 }
    const zone: EZoneAction = {
      id: 'moving-zone', type: 'eZone', actorId: ice.id, center: { x: 19, y: 9 }, radius: 2,
      startTime: 0, duration: 5,
    }
    const move: MoveAction = {
      id: 'moving-zone-owner', type: 'move', actorId: ice.id, startTime: 0, duration: 4,
      path: [{ x: 5, y: 5 }, { x: 9, y: 5 }],
    }
    document.actions.push(zone, move)
    useTacticStore.setState({ document, currentTime: 2 })
    const { container } = render(<App />)

    const renderedZone = container.querySelector('.ice-zone.active')
    expect(renderedZone).toHaveAttribute('cx', '350')
    expect(renderedZone).toHaveAttribute('cy', '250')
    expect(renderedZone?.querySelector('title')).toHaveTextContent('敌方圈内移速 0.5×')
    expect(renderedZone?.querySelector('title')).toHaveTextContent('敌方 Q 距离 0.7×')
  })

  it('renders the shortened effective enemy Q path while retaining the authored action', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 5, y: 5 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 5, y: 5 }
    document.actions.push(
      { id: 'render-q-zone', type: 'eZone', actorId: 'blue-ice', center: { x: 19, y: 9 }, radius: 2, startTime: 0, duration: 5 },
      { id: 'render-short-q', type: 'qMove', actorId: 'red-fire', startTime: 1, duration: 0, path: [{ x: 5, y: 5 }, { x: 7.3, y: 5 }] },
    )
    useTacticStore.setState({ document, currentTime: 1 })
    const { container } = render(<App />)

    const renderedQ = container.querySelector('[data-action-id="render-short-q"] .action-qMove')
    expect(renderedQ).toHaveAttribute('points', '250,250 335,250')
    expect(renderedQ?.querySelector('title')).toHaveTextContent('实际 Q 位移 1.70 格')
    const savedQ = useTacticStore.getState().document.actions.find((action) => action.id === 'render-short-q')
    if (savedQ?.type === 'qMove') expect(savedQ.path.at(-1)).toEqual({ x: 7.3, y: 5 })
  })

  it('supports completing the second workflow step from the keyboard', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Q 位移' }))

    fireEvent.keyDown(screen.getByRole('button', { name: /蓝方 2，蛮牛/ }), { key: 'Enter' })
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    fireEvent.keyDown(screen.getByRole('button', { name: /红方 1，水灵/ }), { key: 'Enter' })

    expect(useTacticStore.getState().document.actions[0]).toMatchObject({
      type: 'qMove',
      actorId: 'blue-fire',
      targetId: 'red-water',
    })
    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
  })

  it('lets Escape cancel an unfinished tool while a form field is focused', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Q 位移' }))
    const title = screen.getByRole('textbox', { name: '战术名称' })
    title.focus()
    fireEvent.keyDown(title, { key: 'Escape' })

    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
  })

  it('does not dim valid point targets in the roster during a move workflow', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-water' })
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '跑动' }))

    expect(container.querySelectorAll('.roster-item.workflow-dimmed')).toHaveLength(0)
  })

  it('keeps attack range inspection active, switches players, and never writes an action', () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /更多/ }))
    fireEvent.click(screen.getByRole('button', { name: '攻击范围' }))
    expect(screen.getByRole('status')).toHaveTextContent('选择任意球员')

    fireEvent.pointerDown(screen.getByRole('button', { name: /蓝方 2，蛮牛/ }), { pointerId: 1, button: 0 })
    expect(useTacticStore.getState().tool).toBe('attack')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    expect(container.querySelector('.attack-range')).toHaveAttribute('r', '75')
    expect(container.querySelector('.attack-inner-range')).not.toBeInTheDocument()

    fireEvent.pointerDown(screen.getByRole('button', { name: /蓝方 1，水灵/ }), { pointerId: 1, button: 0 })
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-water' })
    expect(container.querySelector('.attack-range')).toHaveAttribute('r', '50')
    expect(container.querySelector('.attack-inner-range')).toHaveAttribute('r', '10')
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
  })

  it('shows only pass distance rings before creation and threat segments after saving', () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '传球' }))
    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)

    fireEvent.pointerMove(board, { clientX: 736, clientY: 272, pointerId: 1 })
    expect(container.querySelector('.pass-preview-safe')).toBeInTheDocument()
    expect(container.querySelector('.pass-preview-max')).toBeInTheDocument()
    expect(container.querySelectorAll('.pass-preview-segment')).toHaveLength(0)
    expect(screen.getByLabelText('传球威胁图例').children).toHaveLength(6)

    fireEvent.pointerDown(board, { clientX: 736, clientY: 272, pointerId: 1, button: 0 })
    expect(useTacticStore.getState().document.actions[0]).toMatchObject({ type: 'pass' })
    expect(screen.getByLabelText('传球威胁图例')).toBeInTheDocument()
    const savedSegments = container.querySelectorAll('.actions-layer .pass-threat-segment')
    expect(savedSegments.length).toBeGreaterThan(1)
    expect(container.querySelector('.actions-layer .pass-threat-segment[data-threat="safe"]')).toBeInTheDocument()
    expect(container.querySelector('.actions-layer .pass-threat-segment[data-threat="drop"]')).toBeInTheDocument()
    expect([...savedSegments].filter((segment) => segment.hasAttribute('marker-end'))).toHaveLength(1)
    expect(savedSegments[savedSegments.length - 1]).toHaveAttribute('marker-end', 'url(#arrow-pass)')

    fireEvent.pointerDown(savedSegments[0]!, { pointerId: 1, button: 0 })
    expect(screen.getByLabelText('传球威胁图例')).toBeInTheDocument()
  })

  it('previews an attached pass path with the dragged player and commits the new endpoint once', () => {
    const document = createDefaultDocument()
    const pass: PassAction = {
      id: 'follow-player-pass',
      type: 'pass',
      actorId: 'blue-water',
      targetPlayerId: 'blue-fire',
      path: [{ x: 5.5, y: 5 }, { x: 3.5, y: 2.7 }],
      startTime: 0,
      duration: 0.5,
    }
    document.actions.push(pass)
    useTacticStore.setState({ document, past: [], future: [] })
    const { container } = render(<App />)
    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    const carrier = screen.getByRole('button', { name: /蓝方 1，水灵/ })
    const firstThreatSegment = () => container.querySelector('[data-action-id="follow-player-pass"] .pass-threat-segment')
    const storedPass = () => {
      const action = useTacticStore.getState().document.actions[0]
      if (action?.type !== 'pass') throw new Error('Expected pass action')
      return action
    }

    expect(firstThreatSegment()?.getAttribute('points')).toMatch(/^275,250/)
    fireEvent.pointerDown(carrier, { pointerId: 26, button: 0, clientX: 311, clientY: 272 })
    fireEvent.pointerMove(board, { pointerId: 26, clientX: 361, clientY: 272 })
    expect(firstThreatSegment()?.getAttribute('points')).toMatch(/^325,250/)
    expect(storedPass().path[0]).toEqual({ x: 5.5, y: 5 })

    fireEvent.pointerUp(board, { pointerId: 26, clientX: 361, clientY: 272 })
    expect(storedPass().path[0]).toEqual({ x: 6.5, y: 5 })
    expect(firstThreatSegment()?.getAttribute('points')).toMatch(/^325,250/)
    expect(useTacticStore.getState().past).toHaveLength(1)
  })

  it('renders entities between background actions and the selected action exactly once', () => {
    const document = createDefaultDocument()
    const q: QMoveAction = { id: 'layer-q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] }
    const move: MoveAction = { id: 'boost-move', type: 'move', actorId: 'blue-water', startTime: 0, duration: 5, path: [{ x: 8, y: 5 }, { x: 13, y: 5 }] }
    document.actions.push(q, move)
    document.view.analysis = true
    useTacticStore.setState({ document, selection: { kind: 'action', id: move.id } })
    const { container } = render(<App />)

    const background = container.querySelector('.actions-layer-background')!
    const entities = container.querySelector('.entities-layer')!
    const selected = container.querySelector('.selected-action-layer')!
    expect(background.compareDocumentPosition(entities) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(entities.compareDocumentPosition(selected) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('[data-action-id="boost-move"]')).toHaveLength(1)
    expect(selected.querySelector('[data-action-id="boost-move"]')).toHaveAttribute('pointer-events', 'none')
    expect(selected.querySelector('.path-handle')).toHaveAttribute('pointer-events', 'all')
    expect(selected.querySelector('.water-q-boost-segment')).toBeInTheDocument()
    expect(selected.querySelector('.water-boost-label')).not.toBeInTheDocument()
    expect(selected.querySelector('.water-q-boost-segment title')).toHaveTextContent('水 Q 加速段')
    expect(container.querySelector('.action-label')).not.toBeInTheDocument()
    expect(container.querySelector('.separation-label')).not.toBeInTheDocument()
    expect(container.querySelector('.freeze-label')).not.toBeInTheDocument()
  })

  it('opens a live, closable logic explanation and labels the next-step action clearly', () => {
    const document = createDefaultDocument()
    const move: MoveAction = { id: 'logic-move', type: 'move', actorId: 'blue-water', startTime: 0, duration: 2, path: [{ x: 5.5, y: 5 }, { x: 7.5, y: 5 }] }
    document.actions.push(move)
    useTacticStore.setState({ document, showAdvancedTimeline: true })
    render(<App />)

    expect(screen.getByRole('button', { name: /添加下一步/ })).toBeInTheDocument()
    expect(screen.getByText('继承当前战术末尾状态')).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: '逻辑说明' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: '逻辑说明' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭逻辑说明' })).toHaveFocus()
    expect(screen.getByText('步骤：初始站位')).toBeInTheDocument()
    expect(screen.getByText('跑动 · 蓝方 1')).toBeInTheDocument()
    expect(screen.getByText(/0.00–2.00s/)).toBeInTheDocument()

    act(() => useTacticStore.getState().updateActionTiming(move.id, 'duration', 3))
    expect(screen.getByText(/0.00–3.00s/)).toBeInTheDocument()
    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    expect(useTacticStore.getState().isPlaying).toBe(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '逻辑说明' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('offers accessible normalized angle input and screen-coordinate cardinal facings', () => {
    useTacticStore.setState({ selection: { kind: 'player', id: 'blue-water' } })
    render(<App />)

    const handle = screen.getByRole('slider', { name: '调整蓝方 1面向' })
    const angleInput = screen.getByRole('spinbutton', { name: '蓝方 1面向角度' })
    expect(handle).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByRole('group', { name: '蓝方 1常用面向' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: '蓝方 1面向角度滑块' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '向下 90°' }))
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(90)
    expect(handle).toHaveAttribute('aria-valuenow', '90')

    fireEvent.change(angleInput, { target: { value: '-90' } })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(270)
    expect(screen.getByRole('button', { name: '向上 270°' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.change(angleInput, { target: { value: '360' } })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(0)
    expect(screen.getByRole('button', { name: '向右 0°' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.change(angleInput, { target: { value: '721' } })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(1)
    expect(handle).toHaveAttribute('aria-valuenow', '1')
  })

  it('previews facing drag locally, commits once, keeps position fixed, and supports one-step undo', () => {
    useTacticStore.setState({ selection: { kind: 'player', id: 'blue-water' } })
    render(<App />)
    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    const handle = screen.getByRole('slider', { name: '调整蓝方 1面向' })
    const initialPosition = { ...useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')!.position }

    fireEvent.pointerDown(handle, { pointerId: 17, button: 0, clientX: 350, clientY: 372 })
    fireEvent.pointerMove(board, { pointerId: 17, clientX: 311, clientY: 422 })

    expect(handle).toHaveAttribute('aria-valuenow', '90')
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(0)
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.position).toEqual(initialPosition)
    expect(useTacticStore.getState().past).toHaveLength(0)

    fireEvent.pointerUp(board, { pointerId: 17, clientX: 311, clientY: 422 })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(90)
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.position).toEqual(initialPosition)
    expect(useTacticStore.getState().past).toHaveLength(1)

    act(() => useTacticStore.getState().undo())
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(0)
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.position).toEqual(initialPosition)
  })

  it('cancels a facing preview without a commit and preserves ordinary player dragging', () => {
    useTacticStore.setState({ selection: { kind: 'player', id: 'blue-water' } })
    render(<App />)
    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    const handle = screen.getByRole('slider', { name: '调整蓝方 1面向' })

    fireEvent.pointerDown(handle, { pointerId: 23, button: 0, clientX: 350, clientY: 372 })
    fireEvent.pointerMove(board, { pointerId: 23, clientX: 361, clientY: 371.5 })
    expect(handle).toHaveAttribute('aria-valuenow', '359')
    fireEvent.pointerCancel(board, { pointerId: 23 })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(0)
    expect(useTacticStore.getState().past).toHaveLength(0)

    const playerToken = screen.getByRole('button', { name: /蓝方 1，水灵/ })
    fireEvent.pointerDown(playerToken, { pointerId: 24, button: 0, clientX: 311, clientY: 372 })
    fireEvent.pointerMove(board, { pointerId: 24, clientX: 361, clientY: 372 })
    fireEvent.pointerUp(board, { pointerId: 24, clientX: 361, clientY: 372 })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.position).toEqual({ x: 6.5, y: 7 })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(0)
  })

  it('keeps the ball attached during the carrier drag preview and after commit', () => {
    const { container } = render(<App />)
    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    const carrier = screen.getByRole('button', { name: /蓝方 1，水灵/ })
    const ball = container.querySelector('.ball-token')

    expect(carrier).toHaveAttribute('transform', 'translate(275 350)')
    expect(ball).toHaveAttribute('transform', 'translate(275 350)')
    fireEvent.pointerDown(carrier, { pointerId: 25, button: 0, clientX: 311, clientY: 372 })
    fireEvent.pointerMove(board, { pointerId: 25, clientX: 361, clientY: 372 })
    expect(carrier).toHaveAttribute('transform', 'translate(325 350)')
    expect(ball).toHaveAttribute('transform', 'translate(325 350)')
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.position).toEqual({ x: 5.5, y: 7 })

    fireEvent.pointerUp(board, { pointerId: 25, clientX: 361, clientY: 372 })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.position).toEqual({ x: 6.5, y: 7 })
    expect(useTacticStore.getState().document.initialScene.ball.position).toEqual({ x: 6.5, y: 7 })
    expect(ball).toHaveAttribute('transform', 'translate(325 350)')
  })

  it('clears a facing preview when pointer capture is lost and ignores non-primary pointer starts', () => {
    useTacticStore.setState({ selection: { kind: 'player', id: 'blue-water' } })
    render(<App />)
    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    const handle = screen.getByRole('slider', { name: '调整蓝方 1面向' })

    fireEvent.pointerDown(handle, { pointerId: 31, button: 0, clientX: 350, clientY: 372 })
    fireEvent.pointerMove(board, { pointerId: 31, clientX: 311, clientY: 422 })
    expect(handle).toHaveAttribute('aria-valuenow', '90')
    fireEvent.lostPointerCapture(board, { pointerId: 31 })
    expect(handle).toHaveAttribute('aria-valuenow', '0')
    fireEvent.pointerUp(board, { pointerId: 31, clientX: 311, clientY: 422 })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(0)
    expect(useTacticStore.getState().past).toHaveLength(0)

    fireEvent.pointerDown(handle, { pointerId: 32, button: 2, clientX: 350, clientY: 372 })
    fireEvent.pointerMove(board, { pointerId: 32, clientX: 311, clientY: 422 })
    fireEvent.pointerUp(board, { pointerId: 32, clientX: 311, clientY: 422 })
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(0)
    expect(useTacticStore.getState().past).toHaveLength(0)
  })

  it('uses the projected player center for the facing handle and supports keyboard micro-adjustment', () => {
    const document = useTacticStore.getState().document
    document.actions.push({
      id: 'projected-handle-move', type: 'move', actorId: 'blue-water', startTime: 0, duration: 2,
      path: [{ x: 5.5, y: 7 }, { x: 7.5, y: 7 }],
    })
    useTacticStore.setState({ document, currentTime: 1, selection: { kind: 'player', id: 'blue-water' } })
    render(<App />)
    const handle = screen.getByRole('slider', { name: '调整蓝方 1面向' })

    expect(handle).toHaveAttribute('transform', 'translate(364 350)')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle).toHaveAttribute('aria-valuenow', '1')
    expect(useTacticStore.getState().document.initialScene.players.find((player) => player.id === 'blue-water')?.position).toEqual({ x: 5.5, y: 7 })
    expect(useTacticStore.getState().document.actions).toHaveLength(1)
    expect(useTacticStore.getState().past).toHaveLength(1)

    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle).toHaveAttribute('aria-valuenow', '0')
    expect(useTacticStore.getState().past).toHaveLength(2)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(useTacticStore.getState().past).toHaveLength(2)
  })

  it('creates a player-first shot immediately from the toolbar and keyboard shortcut', () => {
    useTacticStore.setState({ selection: { kind: 'player', id: 'blue-water' } })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '射门' }))
    let shots = useTacticStore.getState().document.actions.filter((action) => action.type === 'shoot')
    expect(shots).toHaveLength(1)
    expect(shots[0]?.path).toEqual([{ x: 5.5, y: 7 }, { x: 20, y: 7 }])
    expect(useTacticStore.getState()).toMatchObject({ tool: 'select', selection: { kind: 'player', id: 'blue-water' } })

    fireEvent.keyDown(window, { key: 's' })
    shots = useTacticStore.getState().document.actions.filter((action) => action.type === 'shoot')
    expect(shots).toHaveLength(2)
    expect(useTacticStore.getState().tool).toBe('select')

    fireEvent.keyDown(window, { key: 's', repeat: true })
    expect(useTacticStore.getState().document.actions.filter((action) => action.type === 'shoot')).toHaveLength(2)
  })

  it('guides a tool-first shot, ignores empty ground, and creates on the player click', () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '射门' }))
    expect(container.querySelector('.board-workflow-guide')).toHaveTextContent('选择射门球员')
    expect(container.querySelector('.board-workflow-guide')).toHaveTextContent('1 / 1')
    expect(container.querySelector('.tool-preview-layer')).not.toBeInTheDocument()

    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    fireEvent.pointerDown(board, { pointerId: 41, button: 0, clientX: 600, clientY: 250 })
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    expect(useTacticStore.getState().tool).toBe('shoot')
    expect(useTacticStore.getState().notice).toContain('无需选择落点')
    expect(container.querySelector('.tool-preview-layer')).not.toBeInTheDocument()

    const redWater = screen.getByRole('button', { name: /红方 1，水灵/ })
    fireEvent.pointerDown(redWater, { pointerId: 42, button: 2 })
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    expect(useTacticStore.getState().tool).toBe('shoot')

    fireEvent.pointerDown(redWater, { pointerId: 43, button: 0 })
    fireEvent.pointerUp(board, { pointerId: 43 })
    const shot = useTacticStore.getState().document.actions[0]
    expect(useTacticStore.getState().document.actions).toHaveLength(1)
    expect(shot).toMatchObject({ type: 'shoot', actorId: 'red-water' })
    if (shot?.type === 'shoot') expect(shot.path.at(-1)).toEqual({ x: 0, y: 7 })
    expect(useTacticStore.getState()).toMatchObject({ tool: 'select', selection: { kind: 'player', id: 'red-water' }, notice: null })
    expect(container.querySelector('.tool-preview-layer')).not.toBeInTheDocument()
  })

  it('shows only the shared earliest shot pressure on the board and exposes no shot path handles', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 17, y: 7 }
    document.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 18.5, y: 7 }
    document.actions.push({
      id: 'pressure-shot', type: 'shoot', actorId: 'blue-water', charge: 'yellow', startTime: 0, duration: 0.4,
      path: [{ x: 17, y: 7 }, { x: 20, y: 7 }],
    })
    useTacticStore.setState({ document, selection: { kind: 'action', id: 'pressure-shot' } })
    const { container } = render(<App />)

    expect(container.querySelector('.shot-pressure-label')).toHaveTextContent('最早受击')
    expect(container.querySelector('.shot-pressure-label')).not.toHaveTextContent('风险')
    expect(container.querySelector('.shot-pressure-label')).not.toHaveTextContent('黄蓄')
    expect(screen.getByLabelText('射门受压分析')).toHaveTextContent('Q逼近')
    expect(container.querySelector('.selected-action-layer .path-handle')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: '蓄力等级' }), { target: { value: 'red' } })
    expect(useTacticStore.getState().document.actions[0]).toMatchObject({ charge: 'red', duration: 0.8 })
    expect(container.querySelector('.shot-pressure-label')).not.toHaveTextContent('红蓄')
    expect(screen.getByLabelText('射门受压分析')).toHaveTextContent('最早受击')
  })

  it('clears the active frame in one click and refreshes count, narrative, warnings, undo and redo', () => {
    const document = createDefaultDocument()
    const firstStep = document.stepMarkers[0]!
    document.stepMarkers.push({
      id: 'later-step', time: 5, name: '后续推进', note: '此步骤应保留', snapshot: structuredClone(document.initialScene),
    })
    document.actions.push(
      {
        id: 'frame-pass', type: 'pass', actorId: 'blue-water', startTime: 0, duration: 1.2,
        path: [{ x: 5.5, y: 5 }, { x: 15, y: 5 }],
      },
      {
        id: 'later-move', type: 'move', actorId: 'blue-fire', startTime: 5, duration: 1,
        path: [{ x: 3.5, y: 2.7 }, { x: 4.5, y: 2.7 }],
      },
    )
    useTacticStore.setState({ document, activeStepId: firstStep.id, currentTime: 0 })
    render(<App />)

    let clearButton = screen.getByRole('button', { name: '清空当前帧，共 1 个动作' })
    expect(clearButton).toBeEnabled()
    expect(clearButton).toHaveClass('clear-frame-button')
    expect(screen.getAllByRole('button', { name: /清空当前帧/ })).toHaveLength(1)
    expect(screen.getByText(/0.00s ≤ 动作开始 < 5.00s/)).toHaveTextContent('步骤本身保留，可撤销')
    expect(screen.getAllByRole('button', { name: /跳到/ })).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: '跳到 后续推进' }))
    expect(screen.getByText(/动作开始 ≥ 5.00s/)).toHaveTextContent('仅删除在此范围内开始的动作')
    expect(screen.getByRole('button', { name: '清空当前帧，共 1 个动作' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '跳到 初始站位' }))

    fireEvent.click(screen.getByRole('button', { name: '逻辑说明' }))
    expect(screen.getByRole('dialog', { name: '逻辑说明' })).toHaveTextContent('传球 · 蓝方 1')
    expect(screen.getByRole('dialog', { name: '逻辑说明' })).toHaveTextContent('传球超出有效距离')
    expect(screen.getByRole('dialog', { name: '逻辑说明' })).toHaveTextContent('跑动 · 蓝方 2')

    fireEvent.click(clearButton)
    expect(useTacticStore.getState().document.actions.map((action) => action.id)).toEqual(['later-move'])
    clearButton = screen.getByRole('button', { name: '清空当前帧，共 0 个动作' })
    expect(clearButton).toBeDisabled()
    expect(screen.getByRole('dialog', { name: '逻辑说明' })).not.toHaveTextContent('传球 · 蓝方 1')
    expect(screen.getByRole('dialog', { name: '逻辑说明' })).not.toHaveTextContent('传球超出有效距离')
    expect(screen.getByRole('dialog', { name: '逻辑说明' })).toHaveTextContent('跑动 · 蓝方 2')
    expect(useTacticStore.getState().document.stepMarkers).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(useTacticStore.getState().document.actions.map((action) => action.id)).toEqual(['frame-pass', 'later-move'])
    expect(screen.getByRole('button', { name: '清空当前帧，共 1 个动作' })).toBeEnabled()
    expect(screen.getByRole('dialog', { name: '逻辑说明' })).toHaveTextContent('传球超出有效距离')

    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(useTacticStore.getState().document.actions.map((action) => action.id)).toEqual(['later-move'])
    expect(screen.getByRole('button', { name: '清空当前帧，共 0 个动作' })).toBeDisabled()
  })
})

function mockBoardRect(board: HTMLElement) {
  Object.defineProperty(board, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1072,
      bottom: 744,
      width: 1072,
      height: 744,
      toJSON: () => ({}),
    }),
  })
}
