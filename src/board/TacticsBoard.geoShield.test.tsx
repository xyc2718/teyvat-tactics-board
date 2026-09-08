import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import type { ShootAction, TacticDocumentV1 } from '../domain/model/types'
import { buildTacticNarrative } from '../domain/narrative/buildTacticNarrative'
import { evaluateWarnings } from '../domain/rules/evaluateRules'
import * as shield from '../domain/rules/geoShield'
import { evaluateShotActionPressure } from '../domain/rules/shotPressure'
import * as projection from '../domain/timeline/projectFrame'
import * as reception from '../domain/timeline/passReception'
import { useTacticStore } from '../editor/useTacticStore'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { RulesDrawer } from '../inspector/RulesDrawer'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { TacticsBoard } from './TacticsBoard'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture(): TacticDocumentV1 {
  const document = createDefaultDocument()
  document.view.analysis = true
  document.initialScene.players.forEach((player) => {
    player.position = { x: player.team === 'red' ? 19 : 1, y: 13 }
    if (player.id === 'blue-water') player.position = { x: 5, y: 7 }
    if (player.id === 'blue-ice') player.position = { x: 8, y: 7 }
    if (player.id === 'red-fire') {
      player.role = 'geo'
      player.position = { x: 7, y: 7.5 }
    }
  })
  document.initialScene.statuses.push({
    id: 'frozen-geo', playerId: 'red-fire', kind: 'frozen', sourceActionId: 'opening', startsAt: 0, endsAt: 4,
  })
  document.actions.push({
    id: 'short-pass', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-ice',
    startTime: 0, duration: 0.42, flightOutcome: 'received', path: [{ x: 5, y: 7 }, { x: 8, y: 7 }],
  })
  return document
}

function show(document: TacticDocumentV1, actionId?: string) {
  // Preserve already-resolved route samples in this rendering fixture.
  useTacticStore.setState({
    document, selection: actionId ? { kind: 'action', id: actionId } : null,
    currentTime: 0, currentKeyframe: null, isPlaying: false, boardMode: 'simulation', tool: 'select',
    activeStepId: 'step-opening', showRules: false,
  })
}

it('marks frozen Geo on a safe short pass without replacing its ordinary color or ball outcome', () => {
  const document = fixture()
  const original = structuredClone(document)
  show(document, 'short-pass')
  const { container } = render(<><TacticsBoard /><InspectorPanel /></>)
  const overlay = container.querySelector('.geo-shield-route')
  expect(overlay).toHaveAttribute('pointer-events', 'none')
  expect(container.querySelector('.geo-shield-segment.geo-shield-inPlace')).toBeInTheDocument()
  expect(overlay?.querySelector('[marker-end]')).toBeNull()
  expect(container.querySelector('.pass-threat-segment.threat-safe')).toBeInTheDocument()
  expect(screen.getByLabelText('岩护罩传球提示')).toHaveTextContent('红方 2')
  expect(screen.getByLabelText('传球威胁图例')).toHaveTextContent('岩原地护罩')
  expect(screen.getByLabelText('传球威胁图例')).toHaveTextContent('岩跑动 / Q 护罩')
  const warnings = evaluateWarnings(document)
  expect(warnings.find((warning) => warning.id === 'geo-shield-pass-short-pass')?.detail).toContain('红方 2')
  expect(warnings.some((warning) => warning.detail.includes('不会被截断'))).toBe(false)
  expect(buildTacticNarrative(document).entries.find((entry) => entry.id === 'action-short-pass')?.detail).toContain('岩原地护罩')
  expect(document).toEqual(original)
})

it('removes overshoot-only pass hints and refreshes them when the full Q can land on the route', () => {
  const document = fixture()
  document.initialScene.statuses = []
  document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 0, y: 5 }
  document.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 1.28, y: 5 }
  document.initialScene.players.find((player) => player.id === 'blue-ice')!.position = { x: 1.32, y: 5 }
  document.actions = [{
    id: 'short-pass', type: 'pass', actorId: 'blue-water', startTime: 0, duration: 0.15,
    path: [{ x: 1.28, y: 5 }, { x: 1.32, y: 5 }],
  }]
  show(document, 'short-pass')
  const { container } = render(<><TacticsBoard /><InspectorPanel /></>)
  expect(container.querySelector('.geo-shield-route')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('岩护罩传球提示')).not.toBeInTheDocument()
  expect(evaluateWarnings(document).some((warning) => warning.id === 'geo-shield-pass-short-pass')).toBe(false)
  expect(buildTacticNarrative(document).entries.find((entry) => entry.id === 'action-short-pass')?.detail).not.toContain('岩跑动 / Q 护罩')
  act(() => {
    const next = structuredClone(document)
    next.initialScene.players.find((player) => player.id === 'red-fire')!.position.x = 3.7
    useTacticStore.setState({ document: next })
  })
  expect(container.querySelector('.geo-shield-segment.geo-shield-reachable')).toBeInTheDocument()
  expect(screen.getByLabelText('岩护罩传球提示')).toHaveTextContent('红方 2')
  expect(container.querySelector('.pass-threat-segment.threat-safe')).toBeInTheDocument()
})

it('keeps the legend closed during time changes and reopens it for a newly added loose pass', () => {
  const document = fixture()
  show(document, 'short-pass')
  render(<TacticsBoard />)
  fireEvent.click(screen.getByRole('button', { name: '关闭传球威胁图例' }))
  act(() => { useTacticStore.setState({ currentTime: 0.3 }) })
  expect(screen.queryByLabelText('传球威胁图例')).not.toBeInTheDocument()
  act(() => {
    const next = structuredClone(document)
    next.actions.push({
      id: 'new-loose', type: 'loosePass', actorId: 'blue-water', startTime: 1, duration: 3,
      aimDirection: { x: 1, y: 0 }, path: [{ x: 5, y: 7 }, { x: 11, y: 7 }], flightOutcome: 'grounded',
    })
    useTacticStore.setState({ document: next })
  })
  expect(screen.getByLabelText('传球威胁图例')).toBeInTheDocument()
})

it('renders exact tangent shield contact as a visible point without adding an arrow or hit target', () => {
  const document = fixture()
  document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 6.03, y: 8 }
  show(document, 'short-pass')
  const { container } = render(<TacticsBoard />)
  const contact = container.querySelector('.geo-shield-contact.geo-shield-inPlace')
  expect(contact).toHaveAttribute('cx', '301.5')
  expect(contact).toHaveAttribute('cy', '350')
  expect(contact).toHaveAttribute('r', '6')
  expect(contact).not.toHaveAttribute('marker-end')
  expect(contact?.closest('.geo-shield-route')).toHaveAttribute('pointer-events', 'none')
  expect(container.querySelectorAll('.pass-threat-segment[marker-end]')).toHaveLength(1)
})

it('adds independent shot shield hints, preserves pressure color, and excludes red charge', () => {
  const document = fixture()
  const shot: ShootAction = { id: 'shot', type: 'shoot', actorId: 'blue-water', startTime: 0, duration: 0.5, charge: 'yellow', path: [{ x: 5, y: 7 }, { x: 20, y: 7 }] }
  document.actions = [shot]
  show(document, 'shot')
  const { container } = render(<><TacticsBoard /><InspectorPanel /></>)
  const expectedColor = evaluateShotActionPressure(document, shot)?.isRisk ? 'risk' : 'safe'
  expect(container.querySelector('.shot-pressure-label')).toHaveClass(expectedColor)
  expect(container.querySelector('.geo-shield-shot-label')).toHaveTextContent('岩最早挡球 0s')
  expect(screen.getAllByLabelText('岩护罩射门提示')).toHaveLength(2)
  expect(buildTacticNarrative(document).entries.find((entry) => entry.id === 'action-shot')?.detail).toContain('岩最早挡球')
  act(() => {
    const next = structuredClone(document)
    const changed = next.actions[0]
    if (changed?.type === 'shoot') changed.charge = 'red'
    useTacticStore.setState({ document: next })
  })
  expect(screen.queryByLabelText('岩护罩射门提示')).not.toBeInTheDocument()
  expect(container.querySelector('.shot-pressure-label')).toHaveClass(expectedColor)
})

it('shows all four simulation roles and the directed four-by-four matchup table', () => {
  const document = fixture()
  show(document)
  useTacticStore.setState({ selection: { kind: 'player', id: 'red-fire' }, showRules: true })
  render(<><InspectorPanel /><RulesDrawer /></>)
  const rolePicker = screen.getByRole('combobox', { name: '职业' })
  expect(within(rolePicker).getAllByRole('option')).toHaveLength(4)
  expect(rolePicker).toHaveValue('geo')
  expect(within(rolePicker).getByRole('option', { name: '万象' })).toBeInTheDocument()
  expect(screen.getByText('护罩半径')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '职业对位' }))
  const dialog = screen.getByRole('dialog', { name: '规则设置' })
  expect(within(dialog).getAllByRole('combobox', { name: /进攻对.+防守/ })).toHaveLength(16)
  const geoToFire = within(dialog).getByRole('combobox', { name: '岩进攻对火防守' })
  expect(geoToFire).toHaveValue('-1')
  expect(within(dialog).getByRole('combobox', { name: '火进攻对岩防守' })).toHaveValue('1')
  fireEvent.change(geoToFire, { target: { value: '2' } })
  expect(useTacticStore.getState().document.rulesSnapshot.matchups.geo.fire).toBe(2)
})

it('reuses Geo analysis during 90 distinct real timeline scrubs and invalidates it after editing', () => {
  const document = fixture()
  document.actions.push({ id: 'run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 6, path: [{ x: 1, y: 13 }, { x: 7, y: 13 }], timingConstraint: { kind: 'fixed' } })
  show(document, 'short-pass')
  const analysis = vi.spyOn(shield, 'analyzeActionGeoShield')
  const solver = vi.spyOn(reception, 'solvePassReception')
  const timed = vi.spyOn(projection, 'resolveTimedMoveGeometry')
  render(<><TacticsBoard /><TimelinePanel /><InspectorPanel /></>)
  expect(analysis).toHaveBeenCalled()
  const counts = [analysis.mock.calls.length, solver.mock.calls.length, timed.mock.calls.length] as const
  const slider = screen.getByRole('slider', { name: '播放位置' })
  for (let index = 0; index < 90; index += 1) {
    fireEvent.change(slider, { target: { value: String((index * 1543 + 9000) % 10000) } })
  }
  const projectedTimes = new Set<number>()
  for (let index = 0; index < 90; index += 1) {
    const time = ((index * 37) % 90) / 15 + 0.001
    act(() => { useTacticStore.setState({ currentTime: time, currentKeyframe: null }) })
    projectedTimes.add(useTacticStore.getState().currentTime)
  }
  expect(projectedTimes.size).toBe(90)
  expect([analysis.mock.calls.length, solver.mock.calls.length, timed.mock.calls.length]).toEqual(counts)
  act(() => {
    const next = structuredClone(document)
    next.initialScene.players.find((player) => player.id === 'red-fire')!.position.y = 12
    useTacticStore.setState({ document: next })
  })
  expect(analysis.mock.calls.length).toBeGreaterThan(counts[0])
})
