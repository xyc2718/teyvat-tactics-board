import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { useTacticStore } from '../editor/useTacticStore'
import { App } from './App'
import { MobileOrientationGate } from './MobileOrientationGate'
import { PHONE_LIKE_MEDIA_QUERY, PORTRAIT_MEDIA_QUERY } from './useDeviceLayout'

const originalMatchMedia = window.matchMedia
const originalOrientation = Object.getOwnPropertyDescriptor(window.screen, 'orientation')
const originalRequestFullscreen = Object.getOwnPropertyDescriptor(document.documentElement, 'requestFullscreen')

function installDeviceMedia(phoneLike: boolean, portrait: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query === PHONE_LIKE_MEDIA_QUERY ? phoneLike : query === PORTRAIT_MEDIA_QUERY ? portrait : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }),
  })
}

describe('phone layout', () => {
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
      showAdvancedTimeline: false,
      notice: null,
      past: [],
      future: [],
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
    if (originalOrientation) Object.defineProperty(window.screen, 'orientation', originalOrientation)
    else Reflect.deleteProperty(window.screen, 'orientation')
    if (originalRequestFullscreen) Object.defineProperty(document.documentElement, 'requestFullscreen', originalRequestFullscreen)
    else Reflect.deleteProperty(document.documentElement, 'requestFullscreen')
  })

  it('keeps desktop on the existing layout and default board zoom', () => {
    installDeviceMedia(false, false)
    const { container } = render(<App />)

    expect(container.querySelector('.app-shell')).not.toHaveClass('mobile-landscape')
    expect(screen.queryByRole('navigation', { name: '手机面板' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('20 乘 14 格战术球场')).toHaveAttribute('data-board-zoom', '100')
    expect(screen.getByLabelText('20 乘 14 格战术球场')).toHaveAttribute('data-touch-optimized', 'false')
    expect(container.querySelectorAll('.entity-touch-hit')).toHaveLength(0)
  })

  it('gates portrait phones behind a rotation prompt', () => {
    installDeviceMedia(true, true)
    render(<App />)

    expect(screen.getByRole('heading', { name: '请将手机旋转为横屏' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '尝试切换横屏' })).toBeInTheDocument()
    expect(screen.queryByRole('application', { name: '战术编辑球场' })).not.toBeInTheDocument()
  })

  it('uses a board-first landscape shell with transient shared panels', () => {
    installDeviceMedia(true, false)
    const { container } = render(<App />)

    expect(container.querySelector('.app-shell')).toHaveClass('mobile-landscape')
    expect(screen.getByLabelText('20 乘 14 格战术球场')).toHaveAttribute('data-board-zoom', '175')
    expect(screen.getByLabelText('20 乘 14 格战术球场')).toHaveAttribute('data-touch-optimized', 'true')
    expect(container.querySelectorAll('.entity-touch-hit')).toHaveLength(7)
    expect(screen.getByRole('navigation', { name: '手机面板' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Q 技能' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '阵容' }))
    expect(container.querySelector('.app-shell')).toHaveClass('mobile-panel-roster')
    const roster = document.getElementById('roster-panel')!
    fireEvent.click(within(roster).getByRole('button', { name: /蓝方 1水灵/ }))
    expect(container.querySelector('.app-shell')).not.toHaveClass('mobile-panel-roster')

    fireEvent.click(screen.getByRole('button', { name: '属性' }))
    expect(container.querySelector('.app-shell')).toHaveClass('mobile-panel-inspector')
    fireEvent.click(screen.getByRole('button', { name: '关闭手机面板' }))
    expect(container.querySelector('.app-shell')).not.toHaveClass('mobile-panel-inspector')

    fireEvent.click(screen.getByRole('button', { name: '时间轴' }))
    expect(container.querySelector('.app-shell')).toHaveClass('mobile-panel-timeline')
  })

  it('reserves object touches for dragging while leaving empty-field touches available for panning', () => {
    installDeviceMedia(true, false)
    const { container } = render(<App />)
    const board = screen.getByRole('application', { name: '战术编辑球场' })
    mockBoardRect(board)
    const player = screen.getByRole('button', { name: /蓝方 1，水灵/ })
    const visibleToken = player.querySelector('.token-body')!

    expect(fireEvent.pointerDown(visibleToken, {
      pointerId: 91,
      pointerType: 'touch',
      button: 0,
      clientX: 311,
      clientY: 257,
    })).toBe(false)
    fireEvent.pointerMove(board, { pointerId: 91, pointerType: 'touch', clientX: 361, clientY: 257 })
    fireEvent.pointerUp(board, { pointerId: 91, pointerType: 'touch', button: 0, clientX: 361, clientY: 257 })

    expect(useTacticStore.getState().document.initialScene.players.find((candidate) => candidate.id === 'blue-water')?.position).toEqual({ x: 6.5, y: 4.7 })
    expect(useTacticStore.getState().past).toHaveLength(1)
    expect(fireEvent.pointerDown(container.querySelector('.pitch')!, {
      pointerId: 92,
      pointerType: 'touch',
      button: 0,
      clientX: 600,
      clientY: 400,
    })).toBe(true)
  })

  it('opens low-frequency actions in a mobile dialog without duplicating tool buttons', () => {
    installDeviceMedia(true, false)
    render(<App />)

    expect(screen.queryByRole('dialog', { name: '战术功能' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '功能' }))
    expect(screen.getByRole('dialog', { name: '战术功能' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '跑动' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '关闭战术功能' }))
    expect(screen.queryByRole('dialog', { name: '战术功能' })).not.toBeInTheDocument()
  })

  it('falls back to manual rotation when orientation locking is unavailable', async () => {
    Object.defineProperty(window.screen, 'orientation', { configurable: true, value: undefined })
    render(<MobileOrientationGate />)

    fireEvent.click(screen.getByRole('button', { name: '尝试切换横屏' }))
    expect(await screen.findByText('此浏览器无法自动旋转。请关闭系统方向锁，再将手机横放。')).toBeInTheDocument()
  })

  it('requests fullscreen and landscape lock from the user gesture when supported', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    const lock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    Object.defineProperty(window.screen, 'orientation', { configurable: true, value: { lock } })
    render(<MobileOrientationGate />)

    fireEvent.click(screen.getByRole('button', { name: '尝试切换横屏' }))

    await waitFor(() => expect(lock).toHaveBeenCalledWith('landscape'))
    expect(requestFullscreen).toHaveBeenCalledOnce()
    expect(screen.getByText(/已请求横屏/)).toBeInTheDocument()
  })
})

function mockBoardRect(board: HTMLElement, width = 1072, height = 744) {
  Object.defineProperty(board, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }),
  })
}
