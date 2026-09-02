import { beforeEach, describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../domain/model/createDocument'
import { evaluateWarnings } from '../domain/rules/evaluateRules'
import { actionEndTime, documentDuration, passDuration } from '../domain/timeline/durations'
import { projectFrame } from '../domain/timeline/projectFrame'
import { getStepActionOwnership } from '../domain/timeline/stepActionOwnership'
import { isOpeningStep } from '../domain/timeline/steps'
import { useTacticStore } from './useTacticStore'

describe('tactic store timeline edits', () => {
  beforeEach(() => {
    const document = createDefaultDocument()
    const editableStep = {
      id: 'test-editable-step',
      time: 0,
      name: '步骤 2',
      note: '',
      snapshot: structuredClone(document.initialScene),
    }
    document.stepMarkers.push(editableStep)
    useTacticStore.setState({
      document,
      selection: null,
      tool: 'select',
      boardMode: 'simulation',
      activeStepId: editableStep.id,
      currentTime: 0,
      isPlaying: false,
      showAdvancedTimeline: false,
      notice: null,
      past: [],
      future: [],
    })
  })

  it('automatically creates the editable next step before drawing movement from the opening frame', () => {
    const document = createDefaultDocument()
    const openingId = document.stepMarkers[0]!.id
    useTacticStore.setState({
      document,
      activeStepId: openingId,
      currentTime: 0,
      selection: { kind: 'player', id: 'blue-water' },
      tool: 'select',
      past: [],
      future: [],
    })

    useTacticStore.getState().setTool('move')
    let state = useTacticStore.getState()
    expect(state.document.stepMarkers).toHaveLength(2)
    expect(state.activeStepId).not.toBe(openingId)
    expect(state.document.stepMarkers.find((step) => step.id === state.activeStepId)).toMatchObject({ time: 0, name: '步骤 1' })
    expect(state).toMatchObject({ currentTime: 0, tool: 'move', selection: { kind: 'player', id: 'blue-water' } })

    state.createAction('blue-water', { x: 7.5, y: 5 })
    state = useTacticStore.getState()
    expect(state.document.actions).toHaveLength(1)
    expect(state.document.actions[0]).toMatchObject({ type: 'move', startTime: 0 })
    expect(getStepActionOwnership(state.document, openingId)?.count).toBe(0)
    expect(getStepActionOwnership(state.document, state.activeStepId)?.count).toBe(1)
  })

  it('automatically puts an immediate wait into the next step instead of the opening frame', () => {
    const document = createDefaultDocument()
    const openingId = document.stepMarkers[0]!.id
    useTacticStore.setState({
      document,
      activeStepId: openingId,
      currentTime: 0,
      selection: { kind: 'player', id: 'blue-fire' },
      tool: 'select',
      past: [],
      future: [],
    })

    useTacticStore.getState().setTool('wait')
    const state = useTacticStore.getState()
    expect(state.document.stepMarkers).toHaveLength(2)
    expect(state.document.actions[0]).toMatchObject({ type: 'wait', actorId: 'blue-fire', startTime: 0 })
    expect(getStepActionOwnership(state.document, openingId)?.count).toBe(0)
    expect(getStepActionOwnership(state.document, state.activeStepId)?.count).toBe(1)
  })

  it('starts a pass from the visible opening possession instead of checking the hidden timeline end', () => {
    const document = createDefaultDocument()
    const openingId = document.stepMarkers[0]!.id
    document.actions.push({
      id: 'future-loose-ball',
      type: 'possession',
      carrierId: null,
      position: { x: 8, y: 7 },
      startTime: 4,
      duration: 0,
    })
    useTacticStore.setState({
      document,
      activeStepId: openingId,
      currentTime: 4,
      selection: null,
      tool: 'select',
      past: [],
      future: [],
    })

    expect(projectFrame(document, 4).ball.carrierId).toBeNull()
    useTacticStore.getState().setTool('pass')

    const state = useTacticStore.getState()
    expect(state.activeStepId).not.toBe(openingId)
    expect(state.currentTime).toBe(0)
    expect(state.selection).toEqual({ kind: 'player', id: 'blue-water' })
    expect(state.tool).toBe('pass')
    expect(state.notice).toBeNull()
    expect(state.document.stepMarkers.find((step) => step.id === state.activeStepId)).toMatchObject({
      time: 0,
      name: '步骤 1',
    })
  })

  it('keeps inspection and basic-board arrows in the opening frame without creating a timeline step', () => {
    const document = createDefaultDocument()
    const openingId = document.stepMarkers[0]!.id
    useTacticStore.setState({ document, activeStepId: openingId, selection: { kind: 'player', id: 'blue-water' } })

    useTacticStore.getState().setTool('attack')
    expect(useTacticStore.getState().document.stepMarkers).toHaveLength(1)

    useTacticStore.getState().setTool('strikeRange')
    expect(useTacticStore.getState().document.stepMarkers).toHaveLength(1)
    expect(useTacticStore.getState().document.actions).toHaveLength(0)

    useTacticStore.getState().setBoardMode('basic')
    useTacticStore.getState().setTool('attack')
    useTacticStore.getState().chooseActorForTool('blue-fire')
    expect(useTacticStore.getState()).toMatchObject({
      tool: 'attack',
      selection: { kind: 'player', id: 'blue-fire' },
    })

    useTacticStore.getState().setTool('strikeRange')
    useTacticStore.getState().chooseActorForTool('blue-water')
    expect(useTacticStore.getState()).toMatchObject({
      tool: 'strikeRange',
      selection: { kind: 'player', id: 'blue-water' },
    })
    expect(useTacticStore.getState().document.stepMarkers).toHaveLength(1)
    expect(useTacticStore.getState().document.actions).toHaveLength(0)

    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction('blue-water', { x: 8, y: 5 })
    expect(useTacticStore.getState().document.stepMarkers).toHaveLength(1)
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
  })

  it('repairs a legacy opening-only draft by adding an action boundary without changing action times', () => {
    const imported = createDefaultDocument()
    const openingId = imported.stepMarkers[0]!.id
    imported.actions.push({ id: 'legacy-wait', type: 'wait', actorId: 'blue-water', startTime: 0, duration: 2 })

    useTacticStore.getState().replaceDocument(imported)
    const state = useTacticStore.getState()
    expect(state.document.stepMarkers).toHaveLength(2)
    expect(state.document.actions[0]).toMatchObject({ id: 'legacy-wait', startTime: 0, duration: 2 })
    expect(getStepActionOwnership(state.document, openingId)?.count).toBe(0)
    expect(state.document.stepMarkers.filter((step) => !isOpeningStep(state.document, step.id))).toHaveLength(1)
  })

  it('migrates the former automatic step names to start at one without changing custom names', () => {
    const imported = createDefaultDocument()
    const snapshot = structuredClone(imported.initialScene)
    imported.stepMarkers.push(
      { id: 'legacy-step-2', time: 0, name: '步骤 2', note: '', snapshot },
      { id: 'legacy-step-3', time: 4, name: '步骤 3', note: '', snapshot: structuredClone(snapshot) },
    )

    useTacticStore.getState().replaceDocument(imported)

    expect(useTacticStore.getState().document.stepMarkers.map((step) => step.name)).toEqual([
      '初始站位',
      '步骤 1',
      '步骤 2',
    ])

    const withCustomName = createDefaultDocument()
    withCustomName.stepMarkers.push({
      id: 'custom-step', time: 0, name: '开场策应', note: '', snapshot: structuredClone(withCustomName.initialScene),
    })
    useTacticStore.getState().replaceDocument(withCustomName)
    expect(useTacticStore.getState().document.stepMarkers[1]?.name).toBe('开场策应')
  })

  it('edits only the opening position when the opening step is active at a stale later playhead', () => {
    const document = createDefaultDocument()
    const openingId = document.stepMarkers[0]!.id
    document.actions.push({
      id: 'later-run',
      type: 'move',
      actorId: 'blue-fire',
      startTime: 0,
      duration: 2,
      path: [{ x: 3.5, y: 2.7 }, { x: 5.5, y: 2.7 }],
    })
    useTacticStore.setState({ document, activeStepId: openingId, currentTime: 2, past: [], future: [] })

    useTacticStore.getState().moveEntity('blue-fire', { x: 4, y: 3 })
    const state = useTacticStore.getState()
    expect(state.currentTime).toBe(0)
    expect(state.document.initialScene.players.find((player) => player.id === 'blue-fire')?.position).toEqual({ x: 4, y: 3 })
    expect(state.document.actions[0]).toMatchObject({
      type: 'move',
      path: [{ x: 4, y: 3 }, { x: 5.5, y: 2.7 }],
    })
  })

  it('leaves the static opening step when playback starts', () => {
    const document = createDefaultDocument()
    const openingId = document.stepMarkers[0]!.id
    const actionStep = { id: 'playback-step', time: 0, name: '步骤 2', note: '', snapshot: structuredClone(document.initialScene) }
    document.stepMarkers.push(actionStep)
    document.actions.push({ id: 'playback-run', type: 'move', actorId: 'blue-water', startTime: 0, duration: 2, path: [{ x: 5.5, y: 5 }, { x: 7.5, y: 5 }] })
    useTacticStore.setState({ document, activeStepId: openingId, currentTime: 0, isPlaying: false })

    useTacticStore.getState().setPlaying(true)
    expect(useTacticStore.getState()).toMatchObject({ activeStepId: actionStep.id, isPlaying: true, currentTime: 0 })
  })

  it('starts each player from that player own sequence instead of another player global endpoint', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-water' })
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction('blue-water', { x: 9.5, y: 7 })
    expect(useTacticStore.getState().currentTime).toBe(4)

    useTacticStore.getState().select({ kind: 'player', id: 'blue-fire' })
    useTacticStore.getState().setTool('wait')
    let state = useTacticStore.getState()
    const wait = state.document.actions.find((action) => action.type === 'wait' && action.actorId === 'blue-fire')
    expect(wait).toMatchObject({ startTime: 0, duration: 1 })
    expect(state.currentTime).toBe(1)

    state.select({ kind: 'player', id: 'blue-fire' })
    state.setTool('move')
    expect(useTacticStore.getState().currentTime).toBe(1)
    useTacticStore.getState().createAction('blue-fire', { x: 5.5, y: 4.7 })

    state = useTacticStore.getState()
    const fireMove = state.document.actions.find((action) => action.type === 'move' && action.actorId === 'blue-fire')
    expect(fireMove).toMatchObject({ startTime: 1 })
    expect(state.document.actions.find((action) => action.type === 'move' && action.actorId === 'blue-water')).toMatchObject({ startTime: 0, duration: 4 })
  })

  it('changes possession at the current time without rewriting the opening state', () => {
    useTacticStore.setState({ currentTime: 2 })
    useTacticStore.getState().givePossession('blue-fire')
    const document = useTacticStore.getState().document
    expect(document.initialScene.ball.carrierId).toBe('blue-water')
    expect(projectFrame(document, 1).ball.carrierId).toBe('blue-water')
    expect(projectFrame(document, 2).ball.carrierId).toBe('blue-fire')

    useTacticStore.setState({ currentTime: 3 })
    useTacticStore.getState().givePossession(null)
    const released = useTacticStore.getState().document
    expect(released.initialScene.ball.carrierId).toBe('blue-water')
    expect(projectFrame(released, 3).ball.isFree).toBe(true)
  })

  it('keeps the carried ball attached when a stale player flag disagrees with the carrier id', () => {
    const document = createDefaultDocument()
    const carrier = document.initialScene.players.find((player) => player.id === 'red-fire')!
    for (const player of document.initialScene.players) player.hasBall = false
    document.initialScene.ball = {
      carrierId: carrier.id,
      position: { ...carrier.position },
      isFree: false,
    }
    document.stepMarkers[0]!.snapshot = structuredClone(document.initialScene)
    useTacticStore.setState({ document, past: [], future: [] })

    useTacticStore.getState().moveEntity(carrier.id, { x: 12, y: 6 })
    const moved = useTacticStore.getState().document
    expect(moved.initialScene.ball.position).toEqual({ x: 12, y: 6 })
    expect(projectFrame(moved, 0).ball.position).toEqual({ x: 12, y: 6 })
    expect(projectFrame(moved, 0).players.find((player) => player.id === carrier.id)?.hasBall).toBe(true)

    useTacticStore.getState().undo()
    expect(useTacticStore.getState().document.initialScene.ball.position).toEqual(carrier.position)
  })

  it('replaces repeated possession edits at one timestamp and keeps the final carrier movable', () => {
    useTacticStore.setState({ currentTime: 2 })
    useTacticStore.getState().givePossession(null)
    useTacticStore.getState().givePossession('red-fire')
    useTacticStore.getState().moveEntity('red-fire', { x: 11, y: 6 })

    const document = useTacticStore.getState().document
    const possessionEdits = document.actions.filter(
      (action) => action.startTime === 2 && (action.type === 'receive' || action.type === 'possession'),
    )
    expect(possessionEdits).toHaveLength(1)
    expect(possessionEdits[0]).toMatchObject({ type: 'receive', actorId: 'red-fire' })
    expect(projectFrame(document, 2).ball).toMatchObject({ carrierId: 'red-fire', position: { x: 11, y: 6 }, isFree: false })
  })

  it('keeps named passes solved between the passer and receiver', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'anchored-pass',
      type: 'pass',
      actorId: 'blue-water',
      targetPlayerId: 'blue-fire',
      path: [{ x: 5.5, y: 5 }, { x: 4.5, y: 4 }, { x: 3.5, y: 2.7 }],
      startTime: 0,
      duration: 0.5,
    })
    useTacticStore.setState({ document, past: [], future: [] })

    useTacticStore.getState().moveEntity('blue-water', { x: 6.5, y: 5 })
    let pass = useTacticStore.getState().document.actions[0]
    expect(pass).toMatchObject({ type: 'pass' })
    if (pass?.type !== 'pass') throw new Error('Expected pass action')
    expect(pass.path).toEqual([{ x: 6.5, y: 5 }, { x: 3.5, y: 4.7 }])
    expect(pass.duration).toBeCloseTo(passDuration(pass.path, document.rulesSnapshot))

    useTacticStore.getState().moveEntity('blue-fire', { x: 8, y: 5 })
    pass = useTacticStore.getState().document.actions[0]
    if (pass?.type !== 'pass') throw new Error('Expected pass action')
    expect(pass.path).toEqual([{ x: 6.5, y: 5 }, { x: 8, y: 5 }])
    expect(pass.duration).toBeCloseTo(passDuration(pass.path, document.rulesSnapshot))

    useTacticStore.getState().undo()
    const restored = useTacticStore.getState().document.actions[0]
    if (restored?.type !== 'pass') throw new Error('Expected pass action')
    expect(restored.path.at(-1)).toEqual({ x: 3.5, y: 4.7 })
  })

  it('moves only the origin of a pass to a free landing point', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'free-target-pass',
      type: 'pass',
      actorId: 'blue-water',
      path: [{ x: 5.5, y: 5 }, { x: 9, y: 7 }],
      startTime: 0,
      duration: 0.5,
    })
    useTacticStore.setState({ document, past: [], future: [] })

    useTacticStore.getState().moveEntity('blue-water', { x: 6.5, y: 5 })
    const pass = useTacticStore.getState().document.actions[0]
    if (pass?.type !== 'pass') throw new Error('Expected pass action')
    expect(pass.path).toEqual([{ x: 6.5, y: 5 }, { x: 9, y: 7 }])
  })

  it('repairs detached pass endpoints when replacing the current document', () => {
    const imported = createDefaultDocument()
    imported.initialScene.players.find((player) => player.id === 'blue-water')!.position = { x: 7, y: 5 }
    imported.initialScene.players.find((player) => player.id === 'blue-fire')!.position = { x: 8, y: 5 }
    imported.actions.push({
      id: 'imported-detached-pass',
      type: 'pass',
      actorId: 'blue-water',
      targetPlayerId: 'blue-fire',
      path: [{ x: 5.5, y: 5 }, { x: 6, y: 4 }, { x: 3.5, y: 2.7 }],
      startTime: 0,
      duration: 0.5,
    })

    useTacticStore.getState().replaceDocument(imported)
    const pass = useTacticStore.getState().document.actions[0]
    if (pass?.type !== 'pass') throw new Error('Expected pass action')
    expect(pass.path).toEqual([{ x: 7, y: 5 }, { x: 8, y: 5 }])
    expect(pass.duration).toBeCloseTo(passDuration(pass.path, imported.rulesSnapshot))
    expect(useTacticStore.getState().document.actions).toContainEqual(expect.objectContaining({
      type: 'receive',
      actorId: 'blue-fire',
      sourceActionId: pass.id,
      startTime: actionEndTime(pass),
      duration: 0,
    }))
  })

  it('creates one replaceable static move arrow per player without adding timeline actions', () => {
    const state = useTacticStore.getState()
    state.setBoardMode('basic')
    state.setTool('move')
    state.chooseActorForTool('blue-water')
    state.createAction('blue-water', { x: 9, y: 4 })

    let current = useTacticStore.getState()
    expect(current.document.actions).toHaveLength(0)
    expect(current.document.staticMoveArrows).toHaveLength(1)
    expect(current.document.staticMoveArrows[0]).toMatchObject({ playerId: 'blue-water', target: { x: 9, y: 4 } })
    expect(current).toMatchObject({ tool: 'select', selection: { kind: 'player', id: 'blue-water' } })
    const arrowId = current.document.staticMoveArrows[0]!.id

    current.setTool('move')
    current.createAction('blue-water', { x: 10, y: 6 })
    current = useTacticStore.getState()
    expect(current.document.staticMoveArrows).toEqual([{ id: arrowId, playerId: 'blue-water', target: { x: 10, y: 6 } }])
    expect(current.document.actions).toHaveLength(0)

    current.updateStaticMoveArrowTarget(arrowId, { x: 11, y: 6 })
    expect(useTacticStore.getState().document.staticMoveArrows[0]?.target).toEqual({ x: 11, y: 6 })
    useTacticStore.getState().deleteStaticMoveArrow(arrowId)
    expect(useTacticStore.getState().document.staticMoveArrows).toEqual([])
  })

  it('moves the opening player directly in basic mode even when a later step is active', () => {
    const document = createDefaultDocument()
    const later = { id: 'later-basic', time: 5, name: '后续', note: '', snapshot: structuredClone(document.initialScene) }
    document.stepMarkers.push(later)
    useTacticStore.setState({ document, activeStepId: later.id, currentTime: 5, boardMode: 'basic', past: [], future: [] })

    useTacticStore.getState().moveEntity('blue-water', { x: 7, y: 4 })
    const current = useTacticStore.getState().document
    expect(current.initialScene.players.find((player) => player.id === 'blue-water')?.position).toEqual({ x: 7, y: 4 })
    expect(current.stepMarkers.find((step) => step.id === later.id)?.snapshot.players.find((player) => player.id === 'blue-water')?.position).toEqual({ x: 5.5, y: 7 })
    expect(current.actions).toHaveLength(0)
  })

  it('restarts playback from zero after reaching the end', () => {
    const document = useTacticStore.getState().document
    document.actions.push({ id: 'playable-wait', type: 'wait', actorId: 'blue-water', startTime: 0, duration: 2 })
    useTacticStore.setState({ document })
    useTacticStore.setState({ currentTime: 2, isPlaying: false })
    useTacticStore.getState().setPlaying(true)
    expect(useTacticStore.getState().currentTime).toBe(0)
    expect(useTacticStore.getState().isPlaying).toBe(true)
  })

  it('cancels a pending drawing tool when playback starts', () => {
    const document = useTacticStore.getState().document
    document.actions.push({ id: 'playable-wait', type: 'wait', actorId: 'red-water', startTime: 0, duration: 1 })
    useTacticStore.setState({ document })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().chooseActorForTool('blue-water')
    useTacticStore.getState().setPlaying(true)

    expect(useTacticStore.getState().isPlaying).toBe(true)
    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-water' })
  })

  it('returns a Move/Q workflow from target selection to actor selection without canceling it', () => {
    const document = useTacticStore.getState().document
    document.actions.push({
      id: 'blue-fire-run',
      type: 'move',
      actorId: 'blue-fire',
      startTime: 0,
      duration: 2,
      path: [{ x: 3.5, y: 2.7 }, { x: 5.5, y: 2.7 }],
    })
    useTacticStore.setState({ document })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().chooseActorForTool('blue-fire')
    expect(useTacticStore.getState()).toMatchObject({
      tool: 'qMove',
      selection: { kind: 'player', id: 'blue-fire' },
      currentTime: 2,
    })

    useTacticStore.getState().reselectToolActor()
    expect(useTacticStore.getState()).toMatchObject({
      tool: 'qMove',
      selection: null,
      currentTime: 2,
    })
    expect(useTacticStore.getState().document.actions).toHaveLength(1)

    useTacticStore.getState().chooseActorForTool('blue-ice')
    expect(useTacticStore.getState()).toMatchObject({
      tool: 'qMove',
      selection: { kind: 'player', id: 'blue-ice' },
      currentTime: 0,
    })
  })

  it('keeps the opening setup as a zero-duration static frame', () => {
    useTacticStore.setState({ currentTime: 2, isPlaying: false })
    useTacticStore.getState().setPlaying(true)

    expect(useTacticStore.getState()).toMatchObject({ currentTime: 0, isPlaying: false, tool: 'select' })
    expect(useTacticStore.getState().notice).toContain('静态初始帧')
  })

  it('snaps paused time to action joints while playback may remain continuous', () => {
    const document = useTacticStore.getState().document
    document.actions.push(
      { id: 'snap-move', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2, path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }] },
      { id: 'snap-wait', type: 'wait', actorId: 'blue-fire', startTime: 2, duration: 3 },
    )
    useTacticStore.setState({ document })

    useTacticStore.getState().setCurrentTime(4.4)
    expect(useTacticStore.getState().currentTime).toBe(5)
    useTacticStore.setState({ currentTime: 3.1, isPlaying: true })
    useTacticStore.getState().setPlaying(false)
    expect(useTacticStore.getState().currentTime).toBe(2)
  })

  it('chains run, wait, and Q and reconnects both sides when the wait-start joint moves', () => {
    const document = useTacticStore.getState().document
    document.actions.push(
      { id: 'joint-run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2, path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }] },
      { id: 'joint-wait', type: 'wait', actorId: 'blue-fire', startTime: 2, duration: 1 },
      { id: 'joint-q', type: 'qMove', actorId: 'blue-fire', startTime: 3, duration: 0, path: [{ x: 5.5, y: 4.7 }, { x: 7.5, y: 4.7 }] },
    )
    useTacticStore.setState({ document, currentTime: 2, past: [], future: [] })

    useTacticStore.getState().moveEntity('blue-fire', { x: 6.5, y: 4.7 })
    const actions = useTacticStore.getState().document.actions
    const move = actions.find((action) => action.id === 'joint-run')
    const wait = actions.find((action) => action.id === 'joint-wait')
    const q = actions.find((action) => action.id === 'joint-q')
    expect(move).toMatchObject({ type: 'move', duration: 3, path: [{ x: 3.5, y: 4.7 }, { x: 6.5, y: 4.7 }] })
    expect(wait).toMatchObject({ type: 'wait', startTime: 3, duration: 1 })
    expect(q).toMatchObject({ type: 'qMove', startTime: 4 })
    if (q?.type === 'qMove') expect(q.path[0]).toEqual({ x: 6.5, y: 4.7 })
    expect(useTacticStore.getState().currentTime).toBe(3)
  })

  it('keeps a saved shot origin attached when its shooter is moved', () => {
    const document = useTacticStore.getState().document
    document.actions.push({
      id: 'attached-shot',
      type: 'shoot',
      actorId: 'blue-fire',
      charge: 'yellow',
      startTime: 0,
      duration: 0.8,
      path: [{ x: 3.5, y: 4.7 }, { x: 20, y: 7 }],
    })
    useTacticStore.setState({ document, currentTime: 0, past: [], future: [] })

    useTacticStore.getState().moveEntity('blue-fire', { x: 12, y: 6 })

    const shot = useTacticStore.getState().document.actions.find((action) => action.id === 'attached-shot')
    expect(shot).toMatchObject({
      type: 'shoot',
      path: [{ x: 12, y: 6 }, { x: 20, y: 7 }],
    })
  })

  it('does not let a player drag rewrite a route between timeline joints', () => {
    const document = useTacticStore.getState().document
    document.actions.push({ id: 'locked-run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2, path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }] })
    useTacticStore.setState({ document, currentTime: 1, past: [], future: [] })

    useTacticStore.getState().moveEntity('blue-fire', { x: 8, y: 4 })

    expect(useTacticStore.getState().document.actions.find((action) => action.id === 'locked-run')).toMatchObject({
      path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }],
    })
    expect(useTacticStore.getState().notice).toContain('开始或结束节点')
  })

  it('adds an editable wait after the selected player locomotion chain', () => {
    const document = useTacticStore.getState().document
    document.actions.push({ id: 'before-wait', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2, path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }] })
    useTacticStore.setState({ document, selection: { kind: 'player', id: 'blue-fire' } })

    useTacticStore.getState().setTool('wait')
    let state = useTacticStore.getState()
    const wait = state.document.actions.find((action) => action.type === 'wait')
    expect(wait).toMatchObject({ actorId: 'blue-fire', startTime: 2, duration: 1 })
    expect(state.selection).toEqual({ kind: 'action', id: wait?.id })

    state.updateActionTiming(wait!.id, 'duration', 2.5)
    state = useTacticStore.getState()
    expect(state.document.actions.find((action) => action.id === wait?.id)).toMatchObject({ startTime: 2, duration: 2.5 })
  })

  it('switches a run between straight and adjustable curved projection', () => {
    const document = useTacticStore.getState().document
    document.actions.push({ id: 'curved-run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2, path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }] })
    useTacticStore.setState({ document, currentTime: 2 })

    useTacticStore.getState().setMovePathMode('curved-run', 'curve')
    let move = useTacticStore.getState().document.actions.find((action) => action.id === 'curved-run')
    expect(move).toMatchObject({ type: 'move' })
    if (move?.type !== 'move') throw new Error('Expected move')
    expect(move.curveControl).toBeDefined()
    expect(move.duration).toBeGreaterThan(2)
    expect(useTacticStore.getState().currentTime).toBe(move.duration)
    expect(projectFrame(useTacticStore.getState().document, move.duration / 2).players.find((player) => player.id === 'blue-fire')?.position.y).toBeGreaterThan(4.7)

    useTacticStore.getState().setMovePathMode('curved-run', 'straight')
    move = useTacticStore.getState().document.actions.find((action) => action.id === 'curved-run')
    if (move?.type !== 'move') throw new Error('Expected move')
    expect(move.curveControl).toBeUndefined()
    expect(move.duration).toBeCloseTo(2)
  })

  it('supports tool-first Q creation and keeps the actor selected after one shot', () => {
    const store = useTacticStore.getState()
    store.setTool('qMove')
    expect(useTacticStore.getState().selection).toBeNull()

    useTacticStore.getState().chooseActorForTool('blue-fire')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    useTacticStore.getState().createAction('blue-fire', { x: 7, y: 4.7 })

    const state = useTacticStore.getState()
    expect(state.document.actions).toHaveLength(1)
    expect(state.document.actions[0]).toMatchObject({ type: 'qMove', actorId: 'blue-fire' })
    expect(state.tool).toBe('select')
    expect(state.selection).toEqual({ kind: 'player', id: 'blue-fire' })
  })

  it('treats a short fire-Q target click as direction and saves the fixed rule distance', () => {
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().chooseActorForTool('blue-fire')
    useTacticStore.getState().createAction('blue-fire', { x: 3.7, y: 4.7 })

    const action = useTacticStore.getState().document.actions.find((candidate) => candidate.type === 'qMove')
    expect(action).toMatchObject({
      type: 'qMove',
      actorId: 'blue-fire',
      path: [{ x: 3.5, y: 4.7 }, { x: 5.8, y: 4.7 }],
    })
  })

  it('jumps to the chosen player latest joint before continuing Q', () => {
    const document = createDefaultDocument()
    document.actions.push(
      {
        id: 'endpoint-run',
        type: 'move',
        actorId: 'blue-fire',
        startTime: 0,
        duration: 2,
        path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }],
      },
      { id: 'endpoint-wait', type: 'wait', actorId: 'blue-fire', startTime: 2, duration: 3 },
    )
    useTacticStore.setState({ document, tool: 'qMove', currentTime: 0, selection: null, past: [], future: [] })

    useTacticStore.getState().chooseActorForTool('blue-fire')
    expect(useTacticStore.getState()).toMatchObject({
      currentTime: 5,
      selection: { kind: 'player', id: 'blue-fire' },
      tool: 'qMove',
    })

    useTacticStore.getState().createAction('blue-fire', { x: 7.5, y: 4.7 })
    const q = useTacticStore.getState().document.actions.find((action) => action.type === 'qMove')
    expect(q).toMatchObject({
      actorId: 'blue-fire',
      startTime: 5,
      path: [{ x: 5.5, y: 4.7 }, { x: 7.8, y: 4.7 }],
    })
  })

  it('jumps from the chosen ice player latest joint to the completed Q endpoint', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'ice-endpoint-run',
      type: 'move',
      actorId: 'blue-ice',
      startTime: 0,
      duration: 2,
      path: [{ x: 3.5, y: 9.3 }, { x: 5.5, y: 9.3 }],
    })
    useTacticStore.setState({ document, tool: 'qMove', currentTime: 0, selection: null, past: [], future: [] })

    useTacticStore.getState().chooseActorForTool('blue-ice')
    expect(useTacticStore.getState().currentTime).toBe(2)

    useTacticStore.getState().createAction('blue-ice', { x: 8.5, y: 9.3 })

    const state = useTacticStore.getState()
    const q = state.document.actions.at(-1)
    expect(q).toMatchObject({ type: 'qMove', actorId: 'blue-ice', startTime: 2, duration: 1 })
    expect(state.currentTime).toBe(3)
    expect(projectFrame(state.document, state.currentTime).players.find((player) => player.id === 'blue-ice')?.position).toEqual({ x: 8.5, y: 9.3 })
  })

  it('previews an ice Q at its legal start so an intervening knockback cannot reverse the chosen direction', () => {
    const document = createDefaultDocument()
    const blueIce = document.initialScene.players.find((player) => player.id === 'blue-ice')!
    const redIce = document.initialScene.players.find((player) => player.id === 'red-ice')!
    blueIce.position = { x: 3.5, y: 7 }
    blueIce.facing = 180
    redIce.position = { x: 9, y: 7 }
    document.actions.push(
      {
        id: 'first-blue-ice-q', type: 'qMove', actorId: blueIce.id, startTime: 0, duration: 1,
        path: [{ x: 3.5, y: 7 }, { x: 6.5, y: 7 }],
      },
      {
        id: 'intervening-red-ice-q', type: 'qMove', actorId: redIce.id, startTime: 3, duration: 1,
        path: [{ x: 9, y: 7 }, { x: 6.5, y: 7 }],
      },
    )
    useTacticStore.setState({
      document,
      tool: 'qMove',
      selection: null,
      currentTime: 0,
      past: [],
      future: [],
    })

    useTacticStore.getState().chooseActorForTool(blueIce.id)

    let state = useTacticStore.getState()
    expect(state.currentTime).toBe(7)
    const displayedOrigin = projectFrame(state.document, state.currentTime).players.find((player) => player.id === blueIce.id)!.position
    expect(displayedOrigin.x).toBeGreaterThan(6.5)

    state.createAction(blueIce.id, { x: 8, y: 7 })
    state = useTacticStore.getState()
    const created = state.document.actions.at(-1)
    expect(created).toMatchObject({ type: 'qMove', actorId: blueIce.id, startTime: 7 })
    if (created?.type !== 'qMove') throw new Error('Expected ice Q')
    expect(created.path[0]).toEqual(displayedOrigin)
    expect(created.path.at(-1)!.x).toBeGreaterThan(created.path[0]!.x)
  })

  it('does not treat a selected action endpoint as a move actor', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'selected-endpoint-run',
      type: 'move',
      actorId: 'blue-fire',
      startTime: 0,
      duration: 2,
      path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }],
    })
    useTacticStore.setState({ document, selection: { kind: 'action', id: 'selected-endpoint-run' }, currentTime: 0 })

    useTacticStore.getState().setTool('move')

    expect(useTacticStore.getState()).toMatchObject({
      currentTime: 0,
      selection: null,
      tool: 'move',
    })
  })

  it('lets target-stage locomotion switch players and follows the replacement latest joint', () => {
    const document = createDefaultDocument()
    document.actions.push(
      {
        id: 'actor-a-run', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2,
        path: [{ x: 3.5, y: 4.7 }, { x: 5.5, y: 4.7 }],
      },
      {
        id: 'actor-b-run', type: 'move', actorId: 'blue-ice', startTime: 0, duration: 4,
        path: [{ x: 3.5, y: 9.3 }, { x: 7.5, y: 9.3 }],
      },
    )
    useTacticStore.setState({ document, tool: 'move', currentTime: 0, selection: null, past: [], future: [] })

    useTacticStore.getState().chooseActorForTool('blue-fire')
    expect(useTacticStore.getState()).toMatchObject({ currentTime: 2, selection: { kind: 'player', id: 'blue-fire' } })

    useTacticStore.getState().chooseActorForTool('blue-ice')
    expect(useTacticStore.getState()).toMatchObject({ currentTime: 4, selection: { kind: 'player', id: 'blue-ice' } })
    expect(useTacticStore.getState().document.actions).toHaveLength(2)

    useTacticStore.getState().createAction('blue-ice', { x: 9.5, y: 9.3 })
    expect(useTacticStore.getState().document.actions.at(-1)).toMatchObject({
      type: 'move',
      actorId: 'blue-ice',
      startTime: 4,
      path: [{ x: 7.5, y: 9.3 }, { x: 9.5, y: 9.3 }],
    })
  })

  it('supports player-first Q creation without losing the chosen actor', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-water' })
    useTacticStore.getState().setTool('qMove')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-water' })

    useTacticStore.getState().createAction('blue-water', { x: 8, y: 5 })
    const state = useTacticStore.getState()
    expect(state.document.actions[0]).toMatchObject({ type: 'qMove', actorId: 'blue-water' })
    expect(state.tool).toBe('select')
    expect(state.selection).toEqual({ kind: 'player', id: 'blue-water' })
  })

  it('auto-selects the carrier for passes and ignores invalid opponents safely', () => {
    useTacticStore.getState().setTool('pass')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-water' })

    useTacticStore.getState().createAction('blue-water', { x: 14.5, y: 5 }, 'red-water')
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    expect(useTacticStore.getState().tool).toBe('pass')
    expect(useTacticStore.getState().notice).toContain('同队')

    useTacticStore.getState().createAction('blue-water', { x: 3.5, y: 2.7 }, 'blue-fire')
    const action = useTacticStore.getState().document.actions[0]
    expect(action).toMatchObject({ type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-fire' })
    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-water' })
    expect(useTacticStore.getState().currentTime).toBeCloseTo(actionEndTime(action!))
    expect(projectFrame(useTacticStore.getState().document, useTacticStore.getState().currentTime).ball.carrierId).toBe('blue-fire')

    useTacticStore.getState().setTool('pass')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    expect(useTacticStore.getState().notice).toBeNull()
  })

  it('solves a moving receiver catch and creates linked keyframes on both player tracks', () => {
    const document = createDefaultDocument()
    const receiver = document.initialScene.players.find((player) => player.id === 'blue-fire')!
    document.actions.push({
      id: 'moving-receiver',
      type: 'move',
      actorId: receiver.id,
      path: [{ ...receiver.position }, { x: receiver.position.x + 4, y: receiver.position.y }],
      startTime: 0,
      duration: 4,
    })
    document.stepMarkers.push({
      id: 'pass-step', name: '步骤 1', note: '', time: 0, snapshot: structuredClone(document.initialScene),
    })
    useTacticStore.setState({
      document,
      activeStepId: 'pass-step',
      currentTime: 0,
      tool: 'select',
      selection: null,
      past: [],
      future: [],
    })

    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-water', receiver.position, receiver.id)

    const state = useTacticStore.getState()
    const pass = state.document.actions.find((action) => action.type === 'pass')
    const receive = state.document.actions.find(
      (action) => action.type === 'receive' && action.sourceActionId === pass?.id,
    )
    if (!pass || pass.type !== 'pass') throw new Error('Expected pass action')
    expect(pass.path.at(-1)?.x).toBeGreaterThan(receiver.position.x)
    expect(receive).toMatchObject({
      type: 'receive',
      actorId: receiver.id,
      sourceActionId: pass.id,
      startTime: actionEndTime(pass),
      duration: 0,
    })
    expect(projectFrame(state.document, actionEndTime(pass)).ball.carrierId).toBe(receiver.id)

    useTacticStore.getState().updateActionPathPoint('moving-receiver', 1, {
      x: receiver.position.x,
      y: receiver.position.y + 4,
    })
    const updated = useTacticStore.getState().document
    const updatedPass = updated.actions.find((action) => action.id === pass.id)
    const updatedReceive = updated.actions.find(
      (action) => action.type === 'receive' && action.sourceActionId === pass.id,
    )
    if (!updatedPass || updatedPass.type !== 'pass') throw new Error('Expected updated pass action')
    expect(updatedPass.path.at(-1)?.y).toBeGreaterThan(receiver.position.y)
    expect(updatedReceive?.startTime).toBeCloseTo(actionEndTime(updatedPass))
  })

  it('deletes an automatic pass/receive pair as one semantic action', () => {
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-water', { x: 3.5, y: 4.7 }, 'blue-fire')
    const pass = useTacticStore.getState().document.actions.find((action) => action.type === 'pass')
    const receive = useTacticStore.getState().document.actions.find(
      (action) => action.type === 'receive' && action.sourceActionId === pass?.id,
    )
    expect(pass).toBeDefined()
    expect(receive).toBeDefined()

    useTacticStore.getState().deleteAction(receive!.id)

    expect(useTacticStore.getState().document.actions.some(
      (action) => action.id === pass?.id || action.id === receive?.id,
    )).toBe(false)
  })

  it('keeps solved pass duration and linked receive timing read-only', () => {
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().createAction('blue-water', { x: 3.5, y: 4.7 }, 'blue-fire')
    const pass = useTacticStore.getState().document.actions.find((action) => action.type === 'pass')!
    const receive = useTacticStore.getState().document.actions.find(
      (action) => action.type === 'receive' && action.sourceActionId === pass.id,
    )!
    const duration = pass.duration
    const arrival = receive.startTime

    useTacticStore.getState().updateActionTiming(pass.id, 'duration', 9)
    expect(useTacticStore.getState().document.actions.find((action) => action.id === pass.id)?.duration).toBe(duration)
    expect(useTacticStore.getState().notice).toContain('自动解算')

    useTacticStore.getState().updateActionTiming(receive.id, 'startTime', 9)
    expect(useTacticStore.getState().document.actions.find((action) => action.id === receive.id)?.startTime).toBe(arrival)
    expect(useTacticStore.getState().notice).toContain('自动解算')
  })

  it('describes a flying pass instead of reporting a generic missing carrier', () => {
    const document = createDefaultDocument()
    document.actions.push({
      id: 'flying-pass', type: 'pass', actorId: 'blue-water', targetPlayerId: 'blue-fire', startTime: 0, duration: 1,
      path: [{ x: 5.5, y: 5 }, { x: 3.5, y: 2.7 }],
    })
    document.stepMarkers.push({
      id: 'action-step', name: '步骤 1', note: '', time: 0, snapshot: structuredClone(document.initialScene),
    })
    useTacticStore.setState({ document, activeStepId: 'action-step', currentTime: 0.5, past: [], future: [] })

    useTacticStore.getState().setTool('pass')

    expect(useTacticStore.getState().selection).toBeNull()
    expect(useTacticStore.getState().notice).toContain('传球途中')
  })

  it('only allows Frost players to activate a centered follow ice zone', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-fire' })
    useTacticStore.getState().setTool('eZone')
    expect(useTacticStore.getState().selection).toBeNull()

    useTacticStore.getState().chooseActorForTool('blue-fire')
    expect(useTacticStore.getState().selection).toBeNull()
    expect(useTacticStore.getState().notice).toContain('霜役')

    useTacticStore.getState().chooseActorForTool('blue-ice')
    expect(useTacticStore.getState().document.actions[0]).toMatchObject({
      type: 'eZone',
      actorId: 'blue-ice',
      center: { x: 3.5, y: 9.3 },
    })
    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-ice' })
  })

  it('cancels an unfinished tool with the actor selection preserved', () => {
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().chooseActorForTool('red-ice')
    useTacticStore.getState().cancelTool()

    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'red-ice' })
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
  })

  it('keeps the pass actor synchronized when possession changes mid-workflow', () => {
    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().givePossession('blue-fire')

    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    useTacticStore.getState().createAction('blue-water', { x: 6, y: 7.3 }, 'blue-ice')
    expect(useTacticStore.getState().document.actions[0]).toMatchObject({
      type: 'pass',
      actorId: 'blue-fire',
      targetPlayerId: 'blue-ice',
    })

    useTacticStore.getState().setTool('pass')
    useTacticStore.getState().givePossession(null)
    expect(useTacticStore.getState().selection).toBeNull()
    expect(useTacticStore.getState().notice).toContain('没有持球者')
  })

  it('refreshes the automatic pass actor when the timeline moves to a new carrier', () => {
    const document = useTacticStore.getState().document
    document.actions.push({
      id: 'future-receive',
      type: 'receive',
      actorId: 'blue-fire',
      startTime: 1,
      duration: 0,
    })
    useTacticStore.setState({ document })
    useTacticStore.getState().setTool('pass')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-water' })

    useTacticStore.getState().setCurrentTime(1)
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-fire' })
    expect(useTacticStore.getState().notice).toBeNull()
  })

  it('activates an ice zone immediately when an eligible selected player uses the tool', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-ice' })
    useTacticStore.getState().setTool('eZone')

    expect(useTacticStore.getState().document.actions).toHaveLength(1)
    expect(useTacticStore.getState().document.actions[0]).toMatchObject({ type: 'eZone', actorId: 'blue-ice' })
    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'blue-ice' })
  })

  it('uses attack as a persistent range inspector without adding timeline actions', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-fire' })
    useTacticStore.getState().setTool('attack')
    useTacticStore.getState().createAction('blue-fire', { x: 8, y: 5 })
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    expect(useTacticStore.getState().notice).toContain('球员')

    useTacticStore.getState().createAction('blue-fire', { x: 14.5, y: 5 }, 'red-water')
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    expect(useTacticStore.getState().tool).toBe('attack')
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'red-water' })
  })

  it('creates actor-only shots from projected positions toward each opposing goal', () => {
    const document = useTacticStore.getState().document
    document.actions.push({
      id: 'pre-shot-move', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 4.7 }, { x: 17, y: 7 }],
    })
    useTacticStore.setState({ document, currentTime: 1 })
    useTacticStore.getState().createShot('blue-fire')
    let shot = useTacticStore.getState().document.actions.at(-1)
    expect(shot).toMatchObject({ type: 'shoot', actorId: 'blue-fire', startTime: 1, charge: 'yellow' })
    if (shot?.type === 'shoot') expect(shot.path).toEqual([{ x: 17, y: 7 }, { x: 20, y: 7 }])
    expect(useTacticStore.getState()).toMatchObject({ tool: 'select', selection: { kind: 'player', id: 'blue-fire' } })

    useTacticStore.setState({ currentTime: 0 })
    useTacticStore.getState().createShot('red-water')
    shot = useTacticStore.getState().document.actions.at(-1)
    if (shot?.type === 'shoot') expect(shot.path.at(-1)).toEqual({ x: 0, y: 7 })
  })

  it('jumps shooting to the actor latest locomotion keyframe before creating the shot', () => {
    const document = useTacticStore.getState().document
    document.actions.push({
      id: 'future-shot-move', type: 'move', actorId: 'blue-fire', startTime: 1, duration: 3,
      path: [{ x: 3.5, y: 4.7 }, { x: 17, y: 7 }],
    })
    useTacticStore.setState({ document, currentTime: 0 })

    useTacticStore.getState().createShot('blue-fire')

    const state = useTacticStore.getState()
    const shot = state.document.actions.at(-1)
    expect(shot).toMatchObject({ type: 'shoot', actorId: 'blue-fire', startTime: 4 })
    if (shot?.type === 'shoot') expect(shot.path).toEqual([{ x: 17, y: 7 }, { x: 20, y: 7 }])
    expect(state.currentTime).toBe(4)
  })

  it('creates immediately for player-first shooting and ignores legacy point creation while shooting', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-fire' })
    useTacticStore.getState().setTool('shoot')
    expect(useTacticStore.getState().document.actions).toHaveLength(1)
    expect(useTacticStore.getState()).toMatchObject({ tool: 'select', selection: { kind: 'player', id: 'blue-fire' } })

    useTacticStore.setState({ tool: 'shoot', selection: null, notice: null })
    useTacticStore.getState().createAction(null, { x: 12, y: 4 })
    expect(useTacticStore.getState().document.actions).toHaveLength(1)
    expect(useTacticStore.getState().notice).toContain('无需选择落点')
  })

  it('keeps actor-only shot paths immutable and restores the document with one undo', () => {
    useTacticStore.getState().createShot('blue-water')
    const shot = useTacticStore.getState().document.actions[0]
    expect(shot?.type).toBe('shoot')
    expect(useTacticStore.getState().past).toHaveLength(1)

    useTacticStore.getState().updateActionPathPoint(shot!.id, 1, { x: 3, y: 3 })
    expect(useTacticStore.getState().document.actions[0]).toEqual(shot)
    expect(useTacticStore.getState().past).toHaveLength(1)

    useTacticStore.getState().undo()
    expect(useTacticStore.getState().document.actions).toHaveLength(0)
    expect(useTacticStore.getState()).toMatchObject({ tool: 'select', selection: null, notice: null })
    useTacticStore.getState().redo()
    expect(useTacticStore.getState().document.actions).toHaveLength(1)
  })

  it('auto-chains ice Q actions from the projected endpoint and one-second duration', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-ice' })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-ice', { x: 6.5, y: 7.3 })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-ice', { x: 9.5, y: 7.3 })

    const actions = useTacticStore.getState().document.actions.filter((action) => action.type === 'qMove')
    expect(actions).toHaveLength(2)
    expect(actions[0]).toMatchObject({ startTime: 0, duration: 1 })
    expect(actions[1]).toMatchObject({ startTime: 7, duration: 1 })
    expect(actions[1]?.path[0]).toEqual(actions[0]?.path.at(-1))
  })

  it.each([
    ['blue-water', { x: 8, y: 7 }, { x: 10, y: 7 }, 7],
    ['blue-fire', { x: 5.8, y: 4.7 }, { x: 8, y: 4.7 }, 9],
  ] as const)('auto-schedules consecutive instant Q actions on the %s cooldown', (actorId, firstTarget, secondTarget, cooldown) => {
    useTacticStore.getState().select({ kind: 'player', id: actorId })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction(actorId, firstTarget)
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction(actorId, secondTarget)

    const actions = useTacticStore.getState().document.actions.filter((action) => action.type === 'qMove')
    expect(actions.map((action) => action.startTime)).toEqual([0, cooldown])
    expect(actions[1]?.path[0]).toEqual(actions[0]?.path.at(-1))
  })

  it('combines cooldown and move conflicts before projecting the next Q origin', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-ice' })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-ice', { x: 6.5, y: 9.3 })
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction('blue-ice', { x: 14.5, y: 9.3 })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-ice', { x: 17.5, y: 9.3 })

    const actions = useTacticStore.getState().document.actions
    const move = actions.find((action) => action.type === 'move')
    const secondQ = actions.filter((action) => action.type === 'qMove')[1]
    expect(move?.startTime).toBe(1)
    expect(secondQ?.startTime).toBeCloseTo(9)
    if (move?.type === 'move' && secondQ?.type === 'qMove') expect(secondQ.path[0]).toEqual(move.path.at(-1))
  })

  it('rejects an advanced Q timing edit inside cooldown and preserves non-Q timing edits', () => {
    const document = useTacticStore.getState().document
    document.actions.push(
      { id: 'q-first', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] },
      { id: 'q-second', type: 'qMove', actorId: 'blue-water', startTime: 7, duration: 0, path: [{ x: 8, y: 5 }, { x: 10, y: 5 }] },
      { id: 'plain-move', type: 'move', actorId: 'blue-fire', startTime: 0, duration: 2, path: [{ x: 3.5, y: 2.7 }, { x: 5.5, y: 2.7 }] },
    )
    useTacticStore.setState({ document, showAdvancedTimeline: true })

    useTacticStore.getState().updateActionTiming('q-second', 'startTime', 5)
    expect(useTacticStore.getState().document.actions.find((action) => action.id === 'q-second')?.startTime).toBe(7)
    expect(useTacticStore.getState().notice).toContain('还差 2.00 秒')
    useTacticStore.getState().updateActionTiming('plain-move', 'startTime', 1.5)
    expect(useTacticStore.getState().document.actions.find((action) => action.id === 'plain-move')?.startTime).toBe(1.5)
  })

  it('continues a newly drawn advanced Q at the next legal cooldown joint', () => {
    const document = useTacticStore.getState().document
    document.actions.push({ id: 'existing-q', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] })
    useTacticStore.setState({ document, showAdvancedTimeline: true, currentTime: 5, selection: { kind: 'player', id: 'blue-water' } })
    useTacticStore.getState().setTool('qMove')
    expect(useTacticStore.getState().currentTime).toBe(7)
    useTacticStore.getState().createAction('blue-water', { x: 10, y: 5 })
    expect(useTacticStore.getState().document.actions.filter((action) => action.type === 'qMove')).toHaveLength(2)
    expect(useTacticStore.getState().document.actions.at(-1)?.startTime).toBe(7)
    expect(useTacticStore.getState().currentTime).toBe(7)
    expect(useTacticStore.getState().notice).toBeNull()
  })

  it('reflows existing simple Q actions after cooldown or role edits', () => {
    const document = useTacticStore.getState().document
    document.actions.push(
      { id: 'q-first', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] },
      { id: 'q-second', type: 'qMove', actorId: 'blue-water', startTime: 7, duration: 0, path: [{ x: 8, y: 5 }, { x: 10, y: 5 }] },
    )
    useTacticStore.setState({ document })
    useTacticStore.getState().updateRoleRule('water', 'qCooldown', 8)
    expect(useTacticStore.getState().document.actions.find((action) => action.id === 'q-second')?.startTime).toBe(8)

    useTacticStore.getState().setPlayerRole('blue-water', 'fire')
    expect(useTacticStore.getState().document.actions.find((action) => action.id === 'q-second')?.startTime).toBe(9)
    expect(evaluateWarnings(useTacticStore.getState().document).some((warning) => warning.id === 'q-cd-q-second')).toBe(false)
  })

  it('updates and clamps the configurable enemy-Q multiplier for the ice zone', () => {
    useTacticStore.getState().updateRoleExtra('ice', 'eQDistanceMultiplier', 0.6)
    expect(useTacticStore.getState().document.rulesSnapshot.roles.ice.e?.qDistanceMultiplier).toBe(0.6)
    useTacticStore.getState().updateRoleExtra('ice', 'eQDistanceMultiplier', 2)
    expect(useTacticStore.getState().document.rulesSnapshot.roles.ice.e?.qDistanceMultiplier).toBe(1)
  })

  it('keeps advanced authored Q times but explicitly reports a rule-created cooldown conflict', () => {
    const document = useTacticStore.getState().document
    document.actions.push(
      { id: 'q-first', type: 'qMove', actorId: 'blue-water', startTime: 0, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] },
      { id: 'q-second', type: 'qMove', actorId: 'blue-water', startTime: 7, duration: 0, path: [{ x: 8, y: 5 }, { x: 10, y: 5 }] },
      { id: 'manual-move', type: 'move', actorId: 'blue-fire', startTime: 2, duration: 12.5, path: [{ x: 3.5, y: 2.7 }, { x: 5.5, y: 2.7 }] },
    )
    useTacticStore.setState({ document, showAdvancedTimeline: true })
    useTacticStore.getState().updateRoleRule('water', 'qCooldown', 8)

    expect(useTacticStore.getState().document.actions.map((action) => action.startTime)).toEqual([0, 7, 2])
    expect(useTacticStore.getState().document.actions.find((action) => action.id === 'manual-move')?.duration).toBe(12.5)
    expect(useTacticStore.getState().notice).toContain('规则已修改')
    expect(evaluateWarnings(useTacticStore.getState().document).some((warning) => warning.id === 'q-cd-q-second')).toBe(true)
  })

  it('keeps Q cooldown and locomotion valid after a simple-mode Q path edit', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-water' })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-water', { x: 8, y: 5 })
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction('blue-water', { x: 10, y: 5 })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-water', { x: 12, y: 5 })

    const firstQ = useTacticStore.getState().document.actions.find((action) => action.type === 'qMove')!
    useTacticStore.getState().updateActionPathPoint(firstQ.id, firstQ.path.length - 1, { x: 7, y: 5 })

    const document = useTacticStore.getState().document
    const [editedQ, move, secondQ] = document.actions
    expect(editedQ).toMatchObject({ type: 'qMove', startTime: 0 })
    expect(move).toMatchObject({ type: 'move', startTime: 0 })
    expect(secondQ).toMatchObject({ type: 'qMove', startTime: 7 })
    if (editedQ?.type === 'qMove' && move?.type === 'move' && secondQ?.type === 'qMove') {
      expect(move.path[0]).toEqual(editedQ.path.at(-1))
      expect(secondQ.path[0]).toEqual(move.path.at(-1))
    }
    expect(evaluateWarnings(document).some((warning) => warning.id.startsWith('q-cd-') || warning.title === '同一球员的位移动作重叠')).toBe(false)
  })

  it.each([
    ['blue-water', { x: 8, y: 5 }, { x: 10, y: 5 }],
    ['blue-fire', { x: 5.8, y: 2.7 }, { x: 8, y: 2.7 }],
  ] as const)('chains movement from an instantaneous Q endpoint for %s', (actorId, qTarget, moveTarget) => {
    useTacticStore.getState().select({ kind: 'player', id: actorId })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction(actorId, qTarget)
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction(actorId, moveTarget)

    const [q, move] = useTacticStore.getState().document.actions
    expect(q).toMatchObject({ type: 'qMove', startTime: 0, duration: 0 })
    expect(move).toMatchObject({ type: 'move', startTime: 0 })
    if (q?.type === 'qMove' && move?.type === 'move') {
      expect(move.path[0]).toEqual(q.path.at(-1))
    }
  })

  it.each(['blue-water', 'blue-fire'] as const)('chains an instantaneous Q after an existing move for %s', (actorId) => {
    useTacticStore.getState().select({ kind: 'player', id: actorId })
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction(actorId, { x: 7.5, y: actorId === 'blue-water' ? 5 : 2.7 })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction(actorId, { x: 9.5, y: actorId === 'blue-water' ? 5 : 2.7 })

    const [move, q] = useTacticStore.getState().document.actions
    expect(move?.type).toBe('move')
    expect(q?.type).toBe('qMove')
    if (move?.type === 'move' && q?.type === 'qMove') {
      expect(q.startTime).toBeCloseTo(move.startTime + move.duration)
      expect(q.path[0]).toEqual(move.path.at(-1))
    }
  })

  it('jumps to a newly scheduled action end when it is appended beyond the current joint', () => {
    const document = createDefaultDocument()
    document.actions.push(
      {
        id: 'existing-run-1',
        type: 'move',
        actorId: 'blue-water',
        startTime: 0,
        duration: 2,
        path: [{ x: 5.5, y: 5 }, { x: 7.5, y: 5 }],
      },
      {
        id: 'existing-wait',
        type: 'wait',
        actorId: 'blue-water',
        startTime: 2,
        duration: 1,
      },
      {
        id: 'existing-run-2',
        type: 'move',
        actorId: 'blue-water',
        startTime: 3,
        duration: 1,
        path: [{ x: 7.5, y: 5 }, { x: 8.5, y: 5 }],
      },
    )
    useTacticStore.setState({
      document,
      currentTime: 2,
      selection: { kind: 'player', id: 'blue-water' },
      tool: 'move',
      past: [],
      future: [],
    })

    useTacticStore.getState().createAction('blue-water', { x: 10, y: 5 })

    const state = useTacticStore.getState()
    const created = state.document.actions.at(-1)
    expect(created).toMatchObject({ type: 'move', actorId: 'blue-water', startTime: 4 })
    if (!created) throw new Error('Expected a scheduled move')
    expect(state.currentTime).toBe(actionEndTime(created))
  })

  it('reflows simple locomotion when a role edit changes an instantaneous Q into an ice dash', () => {
    useTacticStore.getState().select({ kind: 'player', id: 'blue-water' })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-water', { x: 8, y: 5 })
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction('blue-water', { x: 10, y: 5 })
    useTacticStore.getState().setPlayerRole('blue-water', 'ice')

    const [q, move] = useTacticStore.getState().document.actions
    expect(q).toMatchObject({ type: 'qMove', startTime: 0, duration: 1 })
    expect(move).toMatchObject({ type: 'move', startTime: 1 })
    if (q?.type === 'qMove' && move?.type === 'move') expect(move.path[0]).toEqual(q.path.at(-1))
    expect(evaluateWarnings(useTacticStore.getState().document).some((warning) => warning.title === '同一球员的位移动作重叠')).toBe(false)
  })

  it('chains newly drawn advanced locomotion and permits an explicit manual overlap afterward', () => {
    useTacticStore.getState().setAdvancedTimeline(true)
    useTacticStore.getState().select({ kind: 'player', id: 'blue-ice' })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-ice', { x: 6.5, y: 7.3 })
    useTacticStore.getState().setCurrentTime(0)
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction('blue-ice', { x: 5.5, y: 7.3 })

    let document = useTacticStore.getState().document
    expect(document.actions.map((action) => action.startTime)).toEqual([0, 1])
    expect(evaluateWarnings(document).some((warning) => warning.title === '同一球员的位移动作重叠')).toBe(false)

    const move = document.actions.find((action) => action.type === 'move')!
    useTacticStore.getState().updateActionTiming(move.id, 'startTime', 0)
    document = useTacticStore.getState().document
    expect(document.actions.map((action) => action.startTime)).toEqual([0, 0])
    expect(evaluateWarnings(document).some((warning) => warning.title === '同一球员的位移动作重叠')).toBe(true)
  })

  it('preserves authored overlap after a role-duration change in advanced mode', () => {
    useTacticStore.getState().setAdvancedTimeline(true)
    useTacticStore.getState().select({ kind: 'player', id: 'blue-water' })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().createAction('blue-water', { x: 8, y: 5 })
    useTacticStore.getState().setCurrentTime(0)
    useTacticStore.getState().setTool('move')
    useTacticStore.getState().createAction('blue-water', { x: 10, y: 5 })
    useTacticStore.getState().setPlayerRole('blue-water', 'ice')

    const document = useTacticStore.getState().document
    expect(document.actions.map((action) => action.startTime)).toEqual([0, 0])
    expect(evaluateWarnings(document).some((warning) => warning.title === '同一球员的位移动作重叠')).toBe(true)
  })

  it('clears an obsolete workflow notice when the user makes a normal selection', () => {
    useTacticStore.setState({ notice: '旧的错误提示' })
    useTacticStore.getState().select({ kind: 'player', id: 'red-water' })
    expect(useTacticStore.getState().selection).toEqual({ kind: 'player', id: 'red-water' })
    expect(useTacticStore.getState().notice).toBeNull()
  })

  it('normalizes facing commands and avoids empty history entries', () => {
    useTacticStore.getState().setPlayerFacing('blue-water', -90)
    let state = useTacticStore.getState()
    expect(state.document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(270)
    expect(state.document.stepMarkers[0]?.snapshot.players.find((player) => player.id === 'blue-water')?.facing).toBe(270)
    expect(state.past).toHaveLength(1)

    state.setPlayerFacing('blue-water', 630)
    state = useTacticStore.getState()
    expect(state.document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(270)
    expect(state.past).toHaveLength(1)

    state.setPlayerFacing('blue-water', Number.NaN)
    state = useTacticStore.getState()
    expect(state.document.initialScene.players.find((player) => player.id === 'blue-water')?.facing).toBe(0)
    expect(state.past).toHaveLength(2)

    state.setPlayerFacing('missing-player', 90)
    expect(useTacticStore.getState().past).toHaveLength(2)
  })

  it('adds the next step from the tactic end state and cancels an unfinished tool', () => {
    const document = useTacticStore.getState().document
    document.actions.push({
      id: 'step-end-move', type: 'move', actorId: 'blue-water', startTime: 0, duration: 3,
      path: [{ x: 5.5, y: 5 }, { x: 8.5, y: 5 }],
    })
    useTacticStore.setState({ document })
    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().chooseActorForTool('blue-water')
    useTacticStore.getState().addStep()

    const state = useTacticStore.getState()
    const added = state.document.stepMarkers.find((step) => step.id === state.activeStepId)!
    expect(added.time).toBe(3)
    expect(added.snapshot.players.find((player) => player.id === 'blue-water')?.position.x).toBeCloseTo(8.5)
    expect(state.document.actions).toHaveLength(1)
    expect(state.tool).toBe('select')
    expect(state.selection).toEqual({ kind: 'player', id: 'blue-water' })
  })

  it('deletes the first of multiple steps without deleting continuous timeline actions', () => {
    const document = createDefaultDocument()
    const opening = document.stepMarkers[0]!
    const later = {
      id: 'later-step', time: 5, name: '后续步骤', note: '', snapshot: structuredClone(document.initialScene),
    }
    document.stepMarkers.push(later)
    document.actions.push({ id: 'surviving-action', type: 'wait', actorId: 'blue-water', startTime: 0, duration: 8 })
    useTacticStore.setState({ document, activeStepId: opening.id, currentTime: 0, past: [], future: [], tool: 'qMove' })

    useTacticStore.getState().deleteStep(opening.id)
    let state = useTacticStore.getState()
    expect(state.document.stepMarkers).toEqual([later])
    expect(state.document.actions.map((action) => action.id)).toEqual(['surviving-action'])
    expect(state.activeStepId).toBe(later.id)
    expect(state.currentTime).toBe(5)
    expect(state.tool).toBe('select')
    expect(state.notice).toContain('动作仍保留')
    expect(state.past).toHaveLength(1)

    state.undo()
    state = useTacticStore.getState()
    expect(state.document.stepMarkers.map((step) => step.id)).toEqual([opening.id, later.id])
    expect(state.document.actions.map((action) => action.id)).toEqual(['surviving-action'])
  })

  it('resets the sole remaining step to an opening marker and restores it with one undo', () => {
    const document = createDefaultDocument()
    const only = document.stepMarkers[0]!
    only.time = 8.56
    only.name = '步骤 3'
    only.note = '待删除的最后节点'
    document.actions.push({ id: 'preserved-action', type: 'wait', actorId: 'red-water', startTime: 2, duration: 1 })
    useTacticStore.setState({ document, activeStepId: only.id, currentTime: 8.56, past: [], future: [], isPlaying: true })

    useTacticStore.getState().deleteStep(only.id)
    let state = useTacticStore.getState()
    expect(state.document.stepMarkers).toHaveLength(1)
    expect(state.document.stepMarkers[0]).toMatchObject({ id: only.id, time: 0, name: '初始站位', note: '' })
    expect(state.document.stepMarkers[0]?.snapshot).toEqual(state.document.initialScene)
    expect(state.document.actions.map((action) => action.id)).toEqual(['preserved-action'])
    expect(state).toMatchObject({ activeStepId: only.id, currentTime: 0, isPlaying: false })
    expect(state.notice).toContain('恢复为初始站位')
    expect(state.past).toHaveLength(1)

    state.undo()
    state = useTacticStore.getState()
    expect(state.document.stepMarkers[0]).toMatchObject({ id: only.id, time: 8.56, name: '步骤 3', note: '待删除的最后节点' })
    expect(state.document.actions.map((action) => action.id)).toEqual(['preserved-action'])
  })

  it('clears stale action selection after deletion and resets active tools for replacement documents', () => {
    const document = useTacticStore.getState().document
    document.actions.push({
      id: 'selected-move', type: 'move', actorId: 'blue-water', startTime: 0, duration: 1,
      path: [{ x: 5.5, y: 5 }, { x: 6.5, y: 5 }],
    })
    useTacticStore.setState({ document, selection: { kind: 'action', id: 'selected-move' } })
    useTacticStore.getState().deleteAction('selected-move')
    expect(useTacticStore.getState().selection).toBeNull()

    useTacticStore.getState().setTool('qMove')
    useTacticStore.getState().replaceDocument(createDefaultDocument())
    expect(useTacticStore.getState().tool).toBe('select')
    expect(useTacticStore.getState().selection).toBeNull()
  })

  it('clears one sorted step interval in one reversible command while preserving crossing actions and order', () => {
    const document = createDefaultDocument()
    const snapshot = structuredClone(document.initialScene)
    const initial = document.stepMarkers[0]!
    const middle = { id: 'middle-step', time: 5, name: '中段组织', note: '保留备注', snapshot: structuredClone(snapshot) }
    const last = { id: 'last-step', time: 10, name: '最后阶段', note: '', snapshot: structuredClone(snapshot) }
    document.stepMarkers = [last, initial, middle]
    document.actions = [
      { id: 'first-action', type: 'wait', actorId: 'blue-water', startTime: 0, duration: 1 },
      { id: 'middle-a', type: 'wait', actorId: 'blue-fire', startTime: 5, duration: 1 },
      { id: 'crossing-action', type: 'wait', actorId: 'blue-ice', startTime: 4, duration: 8 },
      { id: 'middle-b', type: 'wait', actorId: 'red-water', startTime: 9.5, duration: 1 },
      { id: 'last-boundary', type: 'wait', actorId: 'red-fire', startTime: 10, duration: 1 },
    ]
    const originalIds = document.actions.map((action) => action.id)
    const originalRules = structuredClone(document.rulesSnapshot)
    const originalMarkers = structuredClone(document.stepMarkers)
    useTacticStore.setState({
      document,
      activeStepId: middle.id,
      selection: { kind: 'action', id: 'middle-a' },
      tool: 'qMove',
      isPlaying: true,
      past: [],
      future: [],
    })

    useTacticStore.getState().clearStepActions(middle.id)
    let state = useTacticStore.getState()
    expect(state.document.actions.map((action) => action.id)).toEqual(['first-action', 'crossing-action', 'last-boundary'])
    expect(state.document.stepMarkers).toEqual(originalMarkers)
    expect(state.document.rulesSnapshot).toEqual(originalRules)
    expect(state.activeStepId).toBe(middle.id)
    expect(state.selection).toBeNull()
    expect(state.tool).toBe('select')
    expect(state.isPlaying).toBe(false)
    expect(state.notice).toContain('2 个动作')
    expect(state.notice).toContain('5.00s ≤ 动作开始 < 10.00s')
    expect(state.notice).toContain('可撤销')
    expect(state.past).toHaveLength(1)

    state.undo()
    state = useTacticStore.getState()
    expect(state.document.actions.map((action) => action.id)).toEqual(originalIds)
    expect(state.past).toHaveLength(0)
    expect(state.future).toHaveLength(1)
    expect(state.notice).toBeNull()

    state.redo()
    state = useTacticStore.getState()
    expect(state.document.actions.map((action) => action.id)).toEqual(['first-action', 'crossing-action', 'last-boundary'])
    expect(state.past).toHaveLength(1)
    expect(state.future).toHaveLength(0)
    expect(state.notice).toBeNull()
  })

  it('does nothing for an empty or unknown step, including history and active tool state', () => {
    const document = createDefaultDocument()
    const empty = {
      id: 'empty-step', time: 5, name: '空帧', note: '', snapshot: structuredClone(document.initialScene),
    }
    document.stepMarkers.push(empty)
    document.actions.push({ id: 'crosses-empty', type: 'wait', startTime: 0, duration: 10 })
    const retainedSelection = { kind: 'player' as const, id: 'blue-water' }
    const future = [structuredClone(document)]
    useTacticStore.setState({
      document,
      activeStepId: empty.id,
      tool: 'qMove',
      selection: retainedSelection,
      isPlaying: true,
      notice: '原提示',
      past: [],
      future,
    })
    const before = useTacticStore.getState().document

    useTacticStore.getState().clearStepActions(empty.id)
    expect(useTacticStore.getState().document).toBe(before)
    expect(useTacticStore.getState().past).toHaveLength(0)
    expect(useTacticStore.getState().tool).toBe('qMove')
    expect(useTacticStore.getState()).toMatchObject({ selection: retainedSelection, isPlaying: true, notice: '原提示' })
    expect(useTacticStore.getState().future).toBe(future)

    useTacticStore.getState().clearStepActions('unknown-step')
    expect(useTacticStore.getState().document).toBe(before)
    expect(useTacticStore.getState().past).toHaveLength(0)
    expect(useTacticStore.getState().tool).toBe('qMove')
    expect(useTacticStore.getState()).toMatchObject({ selection: retainedSelection, isPlaying: true, notice: '原提示' })
    expect(useTacticStore.getState().future).toBe(future)
  })

  it('preserves a valid surviving action selection and clears a stale action selection', () => {
    const document = createDefaultDocument()
    const opening = document.stepMarkers[0]!
    document.stepMarkers.push({
      id: 'selection-later', time: 5, name: '后段', note: '', snapshot: structuredClone(document.initialScene),
    })
    document.actions.push(
      { id: 'remove-opening', type: 'wait', startTime: 0, duration: 1 },
      { id: 'keep-later', type: 'wait', startTime: 5, duration: 1 },
    )
    useTacticStore.setState({ document, selection: { kind: 'action', id: 'keep-later' }, past: [], future: [] })

    useTacticStore.getState().clearStepActions(opening.id)
    expect(useTacticStore.getState().selection).toEqual({ kind: 'action', id: 'keep-later' })

    useTacticStore.getState().undo()
    useTacticStore.setState({ selection: { kind: 'action', id: 'stale-action' } })
    useTacticStore.getState().clearStepActions(opening.id)
    expect(useTacticStore.getState().selection).toBeNull()
  })

  it('refreshes duration, cooldown and possession after clearing the last step', () => {
    const document = createDefaultDocument()
    const last = {
      id: 'derived-last', time: 5, name: '派生状态帧', note: '', snapshot: structuredClone(document.initialScene),
    }
    document.stepMarkers.push(last)
    document.actions.push(
      {
        id: 'last-q', type: 'qMove', actorId: 'blue-water', startTime: 5, duration: 0,
        path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }],
      },
      { id: 'last-receive', type: 'receive', actorId: 'red-fire', startTime: 5.5, duration: 0 },
      { id: 'last-wait', type: 'wait', actorId: 'red-fire', startTime: 5, duration: 10 },
    )
    useTacticStore.setState({ document, activeStepId: last.id, currentTime: 14, past: [], future: [] })
    expect(documentDuration(document.actions, document.stepMarkers.map((step) => step.time))).toBe(15)
    expect(projectFrame(document, 6).cooldowns['blue-water']?.q).toBe(6)
    expect(projectFrame(document, 6).ball.carrierId).toBe('red-fire')

    useTacticStore.getState().clearStepActions(last.id)
    const state = useTacticStore.getState()
    expect(state.document.actions).toHaveLength(0)
    expect(documentDuration(state.document.actions, state.document.stepMarkers.map((step) => step.time))).toBe(5)
    expect(state.currentTime).toBe(5)
    expect(projectFrame(state.document, state.currentTime).cooldowns['blue-water']?.q).toBe(0)
    expect(projectFrame(state.document, state.currentTime).ball.carrierId).toBe('blue-water')
  })
})
