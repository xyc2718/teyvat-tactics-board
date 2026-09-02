import { create } from 'zustand'
import { clampPoint, distance, goalCenter, normalizeAngle, pathLength, resolveQPath, resolvedMovePath } from '../domain/geometry/geometry'
import { createDefaultDocument } from '../domain/model/createDocument'
import type {
  BoardMode,
  MatchupRating,
  RoleId,
  RuleSetV1,
  SceneState,
  TacticAction,
  TacticDocumentV1,
  ToolId,
  Vec2,
} from '../domain/model/types'
import { cloneDefaultRules } from '../domain/rules/defaultRules'
import { qCooldownConflictNotice, validateQStart } from '../domain/rules/qCooldown'
import { actionEndTime, documentDuration, movementDuration, passDuration, qDuration, shotDuration } from '../domain/timeline/durations'
import { nearestTimelineJoint, timelineDuration } from '../domain/timeline/keyframes'
import { solvePassReception } from '../domain/timeline/passReception'
import { projectFrame } from '../domain/timeline/projectFrame'
import { formatStepActionRange, getStepActionOwnership } from '../domain/timeline/stepActionOwnership'
import { FIRST_ACTION_STEP_TIME, isOpeningStep, openingStep, sortedStepMarkers } from '../domain/timeline/steps'
import { loadDraft, saveDraft } from '../persistence/tacticFile'
import { latestActorSequenceJoint, planSimpleLocomotion, planSimpleQ, planSimpleWait, reflowSimpleLocomotion } from './locomotionScheduling'
import { isRangeInspectionTool, isToolActorEligible, isToolTargetPlayerEligible, toolNeedsActor } from './toolWorkflow'

type Selection =
  | { kind: 'player'; id: string }
  | { kind: 'ball'; id: 'ball' }
  | { kind: 'action'; id: string }
  | { kind: 'staticArrow'; id: string }
  | null

interface HistoryState {
  past: TacticDocumentV1[]
  future: TacticDocumentV1[]
}

interface TacticStore extends HistoryState {
  document: TacticDocumentV1
  selection: Selection
  tool: ToolId
  boardMode: BoardMode
  activeStepId: string
  currentTime: number
  isPlaying: boolean
  playbackSpeed: number
  showAdvancedTools: boolean
  showAdvancedTimeline: boolean
  showRules: boolean
  showLogic: boolean
  notice: string | null
  select: (selection: Selection) => void
  setTool: (tool: ToolId) => void
  setBoardMode: (mode: BoardMode) => void
  chooseActorForTool: (playerId: string) => void
  reselectToolActor: () => void
  cancelTool: () => void
  setCurrentTime: (time: number) => void
  setPlaying: (playing: boolean) => void
  setPlaybackSpeed: (speed: number) => void
  setAdvancedTools: (show: boolean) => void
  setAdvancedTimeline: (show: boolean) => void
  setRulesOpen: (show: boolean) => void
  setLogicOpen: (show: boolean) => void
  setAnalysis: (show: boolean) => void
  setNotice: (notice: string | null) => void
  updateMeta: (field: 'title' | 'author' | 'notes', value: string) => void
  moveEntity: (id: string, position: Vec2) => void
  setPlayerRole: (id: string, role: RoleId) => void
  setPlayerTeam: (id: string, team: 'blue' | 'red') => void
  setPlayerFacing: (id: string, facing: number) => void
  givePossession: (id: string | null) => void
  createWait: (actorId: string) => void
  createShot: (actorId: string) => void
  createEZone: (actorId: string) => void
  createAction: (actorId: string | null, target: Vec2, targetPlayerId?: string) => void
  updateActionPathPoint: (actionId: string, index: number, point: Vec2) => void
  setMovePathMode: (actionId: string, mode: 'straight' | 'curve') => void
  updateMoveCurveControl: (actionId: string, point: Vec2) => void
  updateActionTiming: (actionId: string, field: 'startTime' | 'duration', value: number) => void
  setShotCharge: (actionId: string, charge: 'yellow' | 'red') => void
  deleteAction: (actionId: string) => void
  updateStaticMoveArrowTarget: (arrowId: string, target: Vec2) => void
  deleteStaticMoveArrow: (arrowId: string) => void
  addStep: () => void
  selectStep: (id: string) => void
  renameStep: (id: string, name: string) => void
  updateStepNote: (id: string, note: string) => void
  deleteStep: (id: string) => void
  clearStepActions: (id: string) => void
  updateFieldRule: (key: keyof RuleSetV1['field'], value: number) => void
  updatePassingRule: (key: keyof RuleSetV1['passing'], value: number) => void
  updateShootingRule: (key: Exclude<keyof RuleSetV1['shooting'], 'interruptedByAttack'>, value: number) => void
  updateRoleRule: (role: RoleId, key: 'attackInnerRadius' | 'attackRadius' | 'qDistance' | 'qCooldown' | 'qDuration', value: number) => void
  updateRoleExtra: (
    role: RoleId,
    key: 'boostDuration' | 'boostGain' | 'freezeDuration' | 'knockback' | 'slowFullDuration' | 'slowFullLoss' | 'slowDuration' | 'slowLoss' | 'eRadius' | 'eDuration' | 'eCooldown' | 'eSlowMultiplier' | 'eQDistanceMultiplier',
    value: number,
  ) => void
  setMatchup: (attacker: RoleId, defender: RoleId, value: MatchupRating) => void
  setModifier: (id: string, field: 'enabled' | 'delta', value: boolean | number) => void
  resetRules: () => void
  replaceDocument: (document: TacticDocumentV1) => void
  newDocument: () => void
  undo: () => void
  redo: () => void
}

function cloneDocument(document: TacticDocumentV1): TacticDocumentV1 {
  return structuredClone(document)
}

function uid(prefix: string): string {
  return `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`
}

function sceneFromFrame(document: TacticDocumentV1, time: number): SceneState {
  const frame = projectFrame(document, time)
  return {
    players: frame.players.map((player) => ({ ...player, position: { ...player.position } })),
    ball: { ...frame.ball, position: { ...frame.ball.position } },
    statuses: frame.statuses.map((status) => ({ ...status })),
  }
}

const TIMELINE_WRITING_TOOLS = new Set<ToolId>([
  'move',
  'wait',
  'qMove',
  'pass',
  'shoot',
  'annotation',
  'eZone',
])

function appendStepMarker(document: TacticDocumentV1, time: number): string {
  const id = uid('step')
  const stepNumber = sortedStepMarkers(document)
    .filter((step) => !isOpeningStep(document, step.id))
    .length + 1
  document.stepMarkers.push({
    id,
    time,
    name: `步骤 ${stepNumber}`,
    note: '',
    snapshot: sceneFromFrame(document, time),
  })
  return id
}

/** Migrates the former automatic sequence "步骤 2, 步骤 3…" without touching custom names. */
function normalizeLegacyDefaultStepNames(document: TacticDocumentV1) {
  const actionSteps = sortedStepMarkers(document).filter((step) => !isOpeningStep(document, step.id))
  const isLegacySequence = actionSteps.length > 0
    && actionSteps.every((step, index) => step.name === `步骤 ${index + 2}`)
  if (!isLegacySequence) return
  actionSteps.forEach((step, index) => {
    step.name = `步骤 ${index + 1}`
  })
}

/** Moves actions out of the opening step's ownership without changing their authored times. */
function ensureOpeningActionBoundary(document: TacticDocumentV1): string | null {
  const opening = openingStep(document)
  if (!opening) return null
  const ownership = getStepActionOwnership(document, opening.id)
  if (!ownership?.count) return null
  const ownedIds = new Set(ownership.actionIds)
  const boundaryTime = Math.min(
    ...document.actions.filter((action) => ownedIds.has(action.id)).map((action) => action.startTime),
  )
  return appendStepMarker(document, boundaryTime)
}

function actionContinuationTime(document: TacticDocumentV1): number {
  return documentDuration(document.actions, document.stepMarkers.map((step) => step.time))
}

function actorToolPreviewTime(document: TacticDocumentV1, actorId: string, tool: ToolId): number {
  const continuationTime = latestActorSequenceJoint(document, actorId)
  if (tool !== 'qMove') return continuationTime
  return planSimpleQ(document, actorId, continuationTime)?.startTime ?? continuationTime
}

function prepareTimelineEditingStep(state: TacticStore, preferredTime?: number) {
  if (state.boardMode !== 'simulation' || !isOpeningStep(state.document, state.activeStepId)) return null

  const next = cloneDocument(state.document)
  const targetTime = preferredTime === undefined
    ? Math.max(FIRST_ACTION_STEP_TIME, actionContinuationTime(next))
    : Math.max(FIRST_ACTION_STEP_TIME, preferredTime)
  let createdStepId: string | null = null
  let laterSteps = sortedStepMarkers(next).filter((step) => !isOpeningStep(next, step.id))

  if (preferredTime !== undefined) {
    let target = laterSteps.find((step) => Math.abs(step.time - targetTime) <= 1e-6)
    if (!target) {
      createdStepId = appendStepMarker(next, targetTime)
      target = next.stepMarkers.find((step) => step.id === createdStepId)
    }
    if (!target) return null
    return {
      document: next,
      targetStepId: target.id,
      time: targetTime,
      changed: createdStepId !== null,
    }
  }

  const repairedStepId = ensureOpeningActionBoundary(next)
  if (repairedStepId) createdStepId = repairedStepId
  laterSteps = sortedStepMarkers(next).filter((step) => !isOpeningStep(next, step.id))

  if (laterSteps.length === 0) {
    createdStepId = appendStepMarker(next, targetTime)
    laterSteps = sortedStepMarkers(next).filter((step) => !isOpeningStep(next, step.id))
  }

  const target = laterSteps.at(-1)
  if (!target) return null
  return {
    document: next,
    targetStepId: target.id,
    time: Math.max(target.time, targetTime),
    changed: createdStepId !== null,
  }
}

function applyDocument(state: TacticStore, next: TacticDocumentV1, trackHistory = true) {
  next.meta.updatedAt = new Date().toISOString()
  saveDraft(next)
  return {
    document: next,
    past: trackHistory ? [...state.past.slice(-49), cloneDocument(state.document)] : state.past,
    future: trackHistory ? [] : state.future,
  }
}

function mutateDocument(state: TacticStore, mutation: (draft: TacticDocumentV1) => void) {
  const next = cloneDocument(state.document)
  mutation(next)
  return applyDocument(state, next)
}

function firstQCooldownViolation(document: TacticDocumentV1, actorIds: string[]) {
  for (const action of document.actions) {
    if (action.type !== 'qMove' || !actorIds.includes(action.actorId)) continue
    const validation = validateQStart(document, action.actorId, action.startTime, action.id)
    if (!validation.valid) return validation
  }
  return null
}

function recalculateRuleDrivenActions(document: TacticDocumentV1) {
  for (const action of document.actions) {
    if (action.type === 'move') action.duration = movementDuration(resolvedMovePath(action), document.rulesSnapshot)
    if (action.type === 'qMove') {
      const player = document.initialScene.players.find((candidate) => candidate.id === action.actorId)
      if (player) {
        const q = document.rulesSnapshot.roles[player.role].q
        action.path = resolveQPath(
          action.path,
          q.maxDistance,
          q.fixedDistance,
          document.rulesSnapshot.field.width,
          document.rulesSnapshot.field.height,
        )
        action.duration = qDuration(player, document.rulesSnapshot)
      }
    }
    if (action.type === 'shoot') {
      const player = projectFrame(document, action.startTime).players.find((candidate) => candidate.id === action.actorId)
      if (player) action.duration = shotDuration(player, action.charge, document.rulesSnapshot)
    }
    if (action.type === 'eZone') {
      const player = document.initialScene.players.find((candidate) => candidate.id === action.actorId)
      const e = player ? document.rulesSnapshot.roles[player.role].e : undefined
      if (e) {
        action.duration = e.duration
        action.radius = e.radius
      }
    }
  }
  syncPassEndpoints(document)
}

function syncPassEndpoints(document: TacticDocumentV1, playerId?: string) {
  const passes = document.actions
    .filter(
      (action): action is Extract<TacticAction, { type: 'pass' }> =>
        action.type === 'pass'
        && (playerId === undefined || action.actorId === playerId || action.targetPlayerId === playerId),
    )
    .sort((left, right) => left.startTime - right.startTime)

  for (const action of passes) {
    const resolution = solvePassReception(document, action)
    action.path = resolution.path
    action.duration = resolution.duration

    const linkedReceives = document.actions.filter(
      (candidate): candidate is Extract<TacticAction, { type: 'receive' }> =>
        candidate.type === 'receive' && candidate.sourceActionId === action.id,
    )
    const primaryReceive = linkedReceives[0]
    if (resolution.received && action.targetPlayerId) {
      if (primaryReceive) {
        primaryReceive.actorId = action.targetPlayerId
        primaryReceive.startTime = resolution.arrivalTime
        primaryReceive.duration = 0
      } else {
        document.actions.push({
          id: uid('receive'),
          type: 'receive',
          actorId: action.targetPlayerId,
          sourceActionId: action.id,
          startTime: resolution.arrivalTime,
          duration: 0,
        })
      }
      if (linkedReceives.length > 1) {
        const duplicateIds = new Set(linkedReceives.slice(1).map((receive) => receive.id))
        document.actions = document.actions.filter((candidate) => !duplicateIds.has(candidate.id))
      }
    } else if (linkedReceives.length > 0) {
      const linkedIds = new Set(linkedReceives.map((receive) => receive.id))
      document.actions = document.actions.filter((candidate) => !linkedIds.has(candidate.id))
    }
  }

  const passIds = new Set(document.actions.filter((action) => action.type === 'pass').map((action) => action.id))
  document.actions = document.actions.filter(
    (action) => action.type !== 'receive' || !action.sourceActionId || passIds.has(action.sourceActionId),
  )
}

function passPairActionIds(document: TacticDocumentV1, actionIds: Iterable<string>): Set<string> {
  const expanded = new Set(actionIds)
  for (const action of document.actions) {
    if (action.type === 'pass' && expanded.has(action.id)) {
      for (const receive of document.actions) {
        if (receive.type === 'receive' && receive.sourceActionId === action.id) expanded.add(receive.id)
      }
    }
    if (action.type === 'receive' && action.sourceActionId && expanded.has(action.id)) {
      expanded.add(action.sourceActionId)
      for (const receive of document.actions) {
        if (receive.type === 'receive' && receive.sourceActionId === action.sourceActionId) expanded.add(receive.id)
      }
    }
  }
  return expanded
}

function syncShotOrigins(document: TacticDocumentV1, playerId?: string) {
  const shots = document.actions
    .filter(
      (action): action is Extract<TacticAction, { type: 'shoot' }> =>
        action.type === 'shoot' && (playerId === undefined || action.actorId === playerId),
    )
    .sort((left, right) => left.startTime - right.startTime)

  for (const action of shots) {
    if (action.path.length < 2) continue
    const shooter = projectFrame(document, action.startTime).players.find((player) => player.id === action.actorId)
    if (!shooter) continue
    action.path[0] = { ...shooter.position }
    action.duration = shotDuration(shooter, action.charge, document.rulesSnapshot)
  }
}

const JOINT_EPSILON = 1e-5

function missingPassCarrierNotice(document: TacticDocumentV1, time: number): string {
  const passInFlight = document.actions.some(
    (action) => action.type === 'pass'
      && time + JOINT_EPSILON >= action.startTime
      && time < actionEndTime(action) - JOINT_EPSILON,
  )
  return passInFlight
    ? '球正在传球途中；请跳到传球结束关键帧后再继续传球。'
    : '当前没有持球者；请先回到选择模式设置球权。'
}

type ActorSequenceAction = Extract<TacticAction, { type: 'move' | 'qMove' | 'wait' }> & { actorId: string }

function actorSequence(document: TacticDocumentV1, actorId: string): ActorSequenceAction[] {
  return document.actions
    .map((action, index) => ({ action, index }))
    .filter(
      (entry): entry is { action: ActorSequenceAction; index: number } =>
        (entry.action.type === 'move' || entry.action.type === 'qMove' || entry.action.type === 'wait')
        && entry.action.actorId === actorId,
    )
    .sort((left, right) => left.action.startTime - right.action.startTime || left.index - right.index)
    .map((entry) => entry.action)
}

function refreshStepSnapshots(document: TacticDocumentV1) {
  for (const step of document.stepMarkers) step.snapshot = sceneFromFrame(document, step.time)
}

interface JointEditResult {
  ok: boolean
  anchorActionId?: string
  anchorEdge?: 'start' | 'end'
}

function timeAfterActionEdit(
  before: TacticAction | undefined,
  after: TacticAction | undefined,
  document: TacticDocumentV1,
  currentTime: number,
): number {
  if (before && after) {
    if (Math.abs(currentTime - actionEndTimeSafe(before)) <= JOINT_EPSILON) return actionEndTimeSafe(after)
    if (Math.abs(currentTime - before.startTime) <= JOINT_EPSILON) return after.startTime
  }
  return nearestTimelineJoint(document, currentTime)
}

/** Moves a stationary actor joint and lets reflow reconnect both neighboring paths. */
function editPlayerJoint(
  document: TacticDocumentV1,
  actorId: string,
  time: number,
  position: Vec2,
): JointEditResult {
  const sequence = actorSequence(document, actorId)
  const movingNow = sequence.find(
    (action) => action.type !== 'wait'
      && action.startTime + JOINT_EPSILON < time
      && actionEndTimeSafe(action) - JOINT_EPSILON > time,
  )
  if (movingNow) return { ok: false }

  const endingAtJoint = [...sequence].reverse().find(
    (action) => Math.abs(actionEndTimeSafe(action) - time) <= JOINT_EPSILON,
  )
  const startingAtJoint = sequence.find(
    (action) => Math.abs(action.startTime - time) <= JOINT_EPSILON,
  )
  const previousMovement = [...sequence].reverse().find(
    (action) => action.type !== 'wait' && actionEndTimeSafe(action) <= time + JOINT_EPSILON,
  )

  if (previousMovement && previousMovement.type !== 'wait') {
    previousMovement.path[previousMovement.path.length - 1] = { ...position }
  } else {
    const initialPlayer = document.initialScene.players.find((player) => player.id === actorId)
    if (!initialPlayer) return { ok: false }
    initialPlayer.position = { ...position }
    if (document.initialScene.ball.carrierId === actorId) document.initialScene.ball.position = { ...position }
  }

  reflowSimpleLocomotion(document, actorId)
  syncPassEndpoints(document, actorId)
  syncShotOrigins(document, actorId)
  refreshStepSnapshots(document)

  if (endingAtJoint) return { ok: true, anchorActionId: endingAtJoint.id, anchorEdge: 'end' }
  if (startingAtJoint) return { ok: true, anchorActionId: startingAtJoint.id, anchorEdge: 'start' }
  return { ok: true }
}

function initialDocument(): TacticDocumentV1 {
  const document = typeof window === 'undefined' ? createDefaultDocument() : loadDraft() ?? createDefaultDocument()
  syncPassEndpoints(document)
  ensureOpeningActionBoundary(document)
  normalizeLegacyDefaultStepNames(document)
  return document
}

const startingDocument = initialDocument()

export const useTacticStore = create<TacticStore>((set, get) => ({
  document: startingDocument,
  selection: null,
  tool: 'select',
  boardMode: 'simulation',
  activeStepId: startingDocument.stepMarkers[0]?.id ?? '',
  currentTime: 0,
  isPlaying: false,
  playbackSpeed: 1,
  showAdvancedTools: false,
  showAdvancedTimeline: false,
  showRules: false,
  showLogic: false,
  notice: null,
  past: [],
  future: [],

  select: (selection) => set({ selection, notice: null }),
  setTool: (tool) => {
    let current = get()
    if (current.isPlaying) {
      set({ isPlaying: false, currentTime: nearestTimelineJoint(current.document, current.currentTime) })
      current = get()
    }
    if (current.boardMode === 'basic' && tool !== 'select' && tool !== 'move' && !isRangeInspectionTool(tool)) {
      set({ notice: '基础模式只提供球员选择、移动箭头和范围查看。' })
      return
    }
    if (
      current.boardMode === 'simulation'
      && TIMELINE_WRITING_TOOLS.has(tool)
      && isOpeningStep(current.document, current.activeStepId)
    ) {
      set((state) => {
        // The protected opening step always renders the initial scene. Pass activation must
        // therefore inspect that same visible instant, not a hidden continuation at timeline end.
        const prepared = prepareTimelineEditingStep(
          state,
          tool === 'pass' ? FIRST_ACTION_STEP_TIME : undefined,
        )
        if (!prepared) return {}
        return {
          ...(prepared.changed ? applyDocument(state, prepared.document) : {}),
          activeStepId: prepared.targetStepId,
          currentTime: prepared.time,
          isPlaying: false,
          notice: null,
        }
      })
      current = get()
    }
    if (
      current.boardMode === 'simulation'
      && (tool === 'move' || tool === 'qMove' || tool === 'wait' || tool === 'shoot' || tool === 'eZone')
      && current.selection?.kind === 'player'
    ) {
      set({ tool, isPlaying: false })
      get().chooseActorForTool(current.selection.id)
      return
    }
    set((state) => {
      if (tool === 'select') return { tool, notice: null, isPlaying: false }
      const frame = projectFrame(state.document, state.currentTime)

      if (tool === 'pass') {
        const carrier = frame.ball.carrierId
          ? frame.players.find((player) => player.id === frame.ball.carrierId)
          : undefined
        return carrier
          ? { tool, selection: { kind: 'player' as const, id: carrier.id }, notice: null, isPlaying: false }
          : { tool, selection: null, notice: missingPassCarrierNotice(state.document, state.currentTime), isPlaying: false }
      }

      if (state.selection?.kind === 'player') {
        const player = frame.players.find((candidate) => candidate.id === state.selection?.id)
        if (player && isToolActorEligible(tool, player, frame, state.document.rulesSnapshot)) {
          return { tool, notice: null, isPlaying: false }
        }
      }

      return {
        tool,
        selection: toolNeedsActor(tool) ? null : state.selection,
        notice: tool === 'eZone'
          ? '冰圈只能由霜役施放；球场已高亮可选角色。'
          : tool === 'shoot'
            ? '选择一名射门球员；程序会自动瞄准对方球门中心。'
            : null,
        isPlaying: false,
      }
    })
  },
  setBoardMode: (boardMode) => set((state) => ({
    boardMode,
    tool: 'select',
    selection: null,
    currentTime: nearestTimelineJoint(state.document, state.currentTime),
    isPlaying: false,
    showAdvancedTools: false,
    showRules: false,
    showLogic: false,
    notice: null,
  })),
  chooseActorForTool: (playerId) => {
    const immediateTool = get().tool
    if (immediateTool === 'wait' || immediateTool === 'shoot' || immediateTool === 'eZone') {
      const state = get()
      const currentTime = latestActorSequenceJoint(state.document, playerId)
      const frame = projectFrame(state.document, currentTime)
      const player = frame.players.find((candidate) => candidate.id === playerId)
      if (!player) return
      if (!isToolActorEligible(immediateTool, player, frame, state.document.rulesSnapshot)) {
        set({
          selection: immediateTool === 'eZone' ? null : state.selection,
          notice: immediateTool === 'eZone' ? '冰圈只能由霜役施放。' : '该球员不能执行当前动作。',
        })
        return
      }
      set({ currentTime, selection: { kind: 'player', id: playerId }, isPlaying: false, notice: null })
      if (immediateTool === 'wait') get().createWait(playerId)
      if (immediateTool === 'shoot') get().createShot(playerId)
      if (immediateTool === 'eZone') get().createEZone(playerId)
      return
    }
    set((state) => {
      const actorSequenceTime = state.boardMode === 'simulation'
        && (state.tool === 'move' || state.tool === 'qMove')
        ? actorToolPreviewTime(state.document, playerId, state.tool)
        : state.currentTime
      const currentTime = actorSequenceTime
      const frame = projectFrame(state.document, currentTime)
      const player = frame.players.find((candidate) => candidate.id === playerId)
      if (!player) return {}
      if (state.tool === 'select') return { selection: { kind: 'player' as const, id: player.id } }
      if (!isToolActorEligible(state.tool, player, frame, state.document.rulesSnapshot)) {
        const notice = state.tool === 'pass'
          ? '传球者必须是当前持球者。'
          : state.tool === 'eZone'
            ? '冰圈只能由霜役施放。'
            : '该球员不能执行当前动作。'
        return { notice }
      }
      return {
        currentTime,
        selection: { kind: 'player' as const, id: player.id },
        isPlaying: false,
        notice: null,
      }
    })
  },
  reselectToolActor: () => set((state) => {
    if (
      state.boardMode !== 'simulation'
      || (state.tool !== 'move' && state.tool !== 'qMove')
    ) return {}
    return {
      selection: null,
      isPlaying: false,
      notice: null,
    }
  }),
  cancelTool: () => set((state) => ({
    tool: 'select',
    selection: state.selection?.kind === 'player' ? state.selection : null,
    notice: null,
  })),
  setCurrentTime: (rawTime) => set((state) => {
    const currentTime = nearestTimelineJoint(state.document, rawTime)
    if (state.tool !== 'pass') return { currentTime, isPlaying: false, notice: null }
    const frame = projectFrame(state.document, currentTime)
    const carrier = frame.ball.carrierId
      ? frame.players.find((player) => player.id === frame.ball.carrierId)
      : undefined
    return carrier
      ? {
          currentTime,
          isPlaying: false,
          selection: { kind: 'player' as const, id: carrier.id },
          notice: null,
        }
      : {
          currentTime,
          isPlaying: false,
          selection: null,
          notice: missingPassCarrierNotice(state.document, currentTime),
        }
  }),
  setPlaying: (isPlaying) => set((state) => {
    if (!isPlaying) return { isPlaying: false, currentTime: nearestTimelineJoint(state.document, state.currentTime) }
    if (state.boardMode === 'basic') return { isPlaying: false, notice: '基础模式没有时间轴播放。' }
    const duration = timelineDuration(state.document)
    if (duration <= JOINT_EPSILON) return { isPlaying: false, currentTime: 0, tool: 'select' as const, notice: '当前只有静态初始帧；添加动作后即可播放。' }
    const playbackStep = isOpeningStep(state.document, state.activeStepId)
      ? sortedStepMarkers(state.document).find((step) => !isOpeningStep(state.document, step.id))
      : undefined
    return {
      isPlaying: true,
      currentTime: state.currentTime >= duration ? 0 : state.currentTime,
      activeStepId: playbackStep?.id ?? state.activeStepId,
      tool: 'select' as const,
      notice: null,
    }
  }),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
  setAdvancedTools: (showAdvancedTools) => set({ showAdvancedTools }),
  setAdvancedTimeline: (showAdvancedTimeline) => set({ showAdvancedTimeline }),
  setRulesOpen: (showRules) => set({ showRules, ...(showRules ? { showLogic: false } : {}) }),
  setLogicOpen: (showLogic) => set({ showLogic, ...(showLogic ? { showRules: false } : {}) }),
  setNotice: (notice) => set({ notice }),

  setAnalysis: (analysis) =>
    set((state) => {
      const next = cloneDocument(state.document)
      next.view.analysis = analysis
      return applyDocument(state, next, false)
    }),

  updateMeta: (field, value) => set((state) => mutateDocument(state, (draft) => {
    const limits = { title: 120, author: 80, notes: 4000 } as const
    draft.meta[field] = value.slice(0, limits[field])
  })),

  moveEntity: (id, rawPosition) =>
    set((state) => {
      const editTime = state.boardMode === 'simulation' && isOpeningStep(state.document, state.activeStepId)
        ? 0
        : state.currentTime
      if (state.boardMode === 'simulation' && id !== 'ball') {
        const movingNow = actorSequence(state.document, id).some(
          (action) => action.type !== 'wait'
            && action.startTime + JOINT_EPSILON < editTime
            && actionEndTimeSafe(action) - JOINT_EPSILON > editTime,
        )
        if (movingNow) return { notice: '当前球员正在动作途中；请跳到该动作的开始或结束节点后再拖动。' }
      }
      let jointResult: JointEditResult | null = null
      const patch = mutateDocument(state, (draft) => {
      const position = clampPoint(rawPosition, draft.rulesSnapshot.field.width, draft.rulesSnapshot.field.height)
      if (state.boardMode === 'basic') {
        const player = draft.initialScene.players.find((candidate) => candidate.id === id)
        if (!player) return
        player.position = position
        if (draft.initialScene.ball.carrierId === id) draft.initialScene.ball.position = { ...position }
        for (const step of draft.stepMarkers) {
          if (Math.abs(step.time) > 1e-9) continue
          const stepPlayer = step.snapshot.players.find((candidate) => candidate.id === id)
          if (stepPlayer) stepPlayer.position = { ...position }
          if (step.snapshot.ball.carrierId === id) step.snapshot.ball.position = { ...position }
        }
        syncPassEndpoints(draft, id)
        syncShotOrigins(draft, id)
        return
      }
      const activeStep = draft.stepMarkers.find((step) => step.id === state.activeStepId)
      const sorted = [...draft.stepMarkers].sort((a, b) => a.time - b.time)
      const activeIndex = activeStep ? sorted.findIndex((step) => step.id === activeStep.id) : 0

      if (id === 'ball') {
        if (!activeStep || activeIndex <= 0) {
          draft.initialScene.ball = { position, carrierId: null, isFree: true }
          for (const player of draft.initialScene.players) player.hasBall = false
          if (activeStep) activeStep.snapshot = structuredClone(draft.initialScene)
          return
        }
        activeStep.snapshot.ball = { position, carrierId: null, isFree: true }
        for (const player of activeStep.snapshot.players) player.hasBall = false
        const previous = sorted[activeIndex - 1]
        const carrierId = previous?.snapshot.ball.carrierId
        if (previous && carrierId) {
          const path = [{ ...previous.snapshot.ball.position }, position]
          const action: TacticAction = {
            id: `auto-pass-${activeStep.id}`,
            type: 'pass',
            actorId: carrierId,
            path,
            startTime: previous.time,
            duration: passDuration(path, draft.rulesSnapshot),
          }
          draft.actions = [...draft.actions.filter((candidate) => candidate.id !== action.id), action]
          activeStep.time = Math.max(activeStep.time, actionEndTimeSafe(action))
        }
        return
      }

      if (!draft.initialScene.players.some((player) => player.id === id)) return
      jointResult = editPlayerJoint(draft, id, editTime, position)
      })
      const committedJoint = jointResult as JointEditResult | null
      if (!committedJoint?.ok || !committedJoint.anchorActionId) {
        return editTime === 0 && state.currentTime !== 0 ? { ...patch, currentTime: 0 } : patch
      }
      const anchor = patch.document.actions.find((action) => action.id === committedJoint.anchorActionId)
      if (!anchor) return patch
      return {
        ...patch,
        currentTime: committedJoint.anchorEdge === 'end' ? actionEndTimeSafe(anchor) : anchor.startTime,
      }
    }),

  setPlayerRole: (id, role) => set((state) => {
    const documentPatch = mutateDocument(state, (draft) => {
      const update = (scene: SceneState) => {
        const player = scene.players.find((candidate) => candidate.id === id)
        if (player) player.role = role
      }
      update(draft.initialScene)
      draft.stepMarkers.forEach((step) => update(step.snapshot))
      recalculateRuleDrivenActions(draft)
      if (!state.showAdvancedTimeline) {
        reflowSimpleLocomotion(draft, id)
        syncPassEndpoints(draft, id)
      }
    })
    const selectedActorLostEligibility = state.tool === 'eZone'
      && state.selection?.kind === 'player'
      && state.selection.id === id
      && state.document.rulesSnapshot.roles[role].e === undefined
    const cooldownViolation = state.showAdvancedTimeline
      ? firstQCooldownViolation(documentPatch.document, [id])
      : null
    return selectedActorLostEligibility
      ? {
          ...documentPatch,
          selection: null,
          notice: '该球员已不再是霜役，请重新选择冰圈施法者。',
        }
      : cooldownViolation
        ? { ...documentPatch, notice: `职业已修改；${qCooldownConflictNotice(cooldownViolation)}` }
        : documentPatch
  }),

  setPlayerTeam: (id, team) => set((state) => mutateDocument(state, (draft) => {
    const update = (scene: SceneState) => {
      const player = scene.players.find((candidate) => candidate.id === id)
      if (player) player.team = team
    }
    update(draft.initialScene)
    draft.stepMarkers.forEach((step) => update(step.snapshot))
  })),

  setPlayerFacing: (id, facing) => set((state) => {
    const normalized = normalizeAngle(facing)
    const scenes = [state.document.initialScene, ...state.document.stepMarkers.map((step) => step.snapshot)]
    const players = scenes
      .map((scene) => scene.players.find((candidate) => candidate.id === id))
      .filter((player) => player !== undefined)
    if (players.length === 0 || players.every((player) => player.facing === normalized)) return {}

    const patch = mutateDocument(state, (draft) => {
      const update = (scene: SceneState) => {
        const player = scene.players.find((candidate) => candidate.id === id)
        if (player) player.facing = normalized
      }
      update(draft.initialScene)
      draft.stepMarkers.forEach((step) => update(step.snapshot))
    })
    return patch
  }),

  givePossession: (id) => set((state) => {
    const documentPatch = mutateDocument(state, (draft) => {
      const frame = projectFrame(draft, state.currentTime)
      const target = id ? frame.players.find((player) => player.id === id) : undefined
      if (state.currentTime <= 0) {
        for (const player of draft.initialScene.players) player.hasBall = player.id === id
        draft.initialScene.ball = {
          carrierId: id,
          position: target ? { ...target.position } : { ...frame.ball.position },
          isFree: id === null,
        }
        const opening = draft.stepMarkers.find((step) => step.time === 0)
        if (opening) opening.snapshot = structuredClone(draft.initialScene)
        return
      }

      draft.actions = draft.actions.filter((action) => {
        const isPossessionEdit = action.type === 'possession'
          || (action.type === 'receive' && !action.sourceActionId)
        return !isPossessionEdit || action.startTime !== state.currentTime
      })
      if (id) {
        draft.actions.push({
          id: uid('receive'),
          type: 'receive',
          actorId: id,
          startTime: state.currentTime,
          duration: 0,
        })
      } else {
        draft.actions.push({
          id: uid('possession'),
          type: 'possession',
          carrierId: null,
          position: { ...frame.ball.position },
          startTime: state.currentTime,
          duration: 0,
        })
      }
    })
    if (state.tool !== 'pass') return documentPatch
    return id
      ? {
          ...documentPatch,
          selection: { kind: 'player' as const, id },
          notice: null,
        }
      : {
          ...documentPatch,
          selection: null,
          notice: '当前没有持球者；请先回到选择模式设置球权。',
        }
  }),

  createWait: (actorId) => set((state) => {
    const frame = projectFrame(state.document, state.currentTime)
    const actor = frame.players.find((player) => player.id === actorId)
    if (!actor) return { notice: '未找到等待球员。' }
    const plan = state.showAdvancedTimeline
      ? null
      : planSimpleWait(state.document, actorId, state.currentTime, 1)
    const action: TacticAction = {
      id: uid('wait'),
      type: 'wait',
      actorId,
      startTime: plan?.startTime ?? state.currentTime,
      duration: 1,
    }
    const next = cloneDocument(state.document)
    next.actions.push(action)
    if (!state.showAdvancedTimeline) reflowSimpleLocomotion(next, actorId)
    refreshStepSnapshots(next)
    return {
      ...applyDocument(state, next),
      tool: 'select' as const,
      selection: { kind: 'action' as const, id: action.id },
      currentTime: actionEndTime(action),
      isPlaying: false,
      notice: '已添加 1 秒等待；可在右侧修改时长。',
    }
  }),

  createShot: (actorId) => set((state) => {
    const shotTime = latestActorSequenceJoint(state.document, actorId)
    const frame = projectFrame(state.document, shotTime)
    const shooter = frame.players.find((player) => player.id === actorId)
    if (!shooter) return { notice: '未找到可射门的球员。' }
    const target = goalCenter(
      shooter.team,
      state.document.rulesSnapshot.field.width,
      state.document.rulesSnapshot.field.height,
    )
    const action: TacticAction = {
      id: uid('shoot'),
      type: 'shoot',
      actorId: shooter.id,
      charge: 'yellow',
      path: [{ ...shooter.position }, target],
      startTime: shotTime,
      duration: shotDuration(shooter, 'yellow', state.document.rulesSnapshot),
    }
    const next = cloneDocument(state.document)
    next.actions.push(action)
    return {
      ...applyDocument(state, next),
      tool: 'select' as const,
      selection: { kind: 'player' as const, id: shooter.id },
      currentTime: shotTime,
      notice: null,
      isPlaying: false,
    }
  }),

  createEZone: (actorId) => set((state) => {
    const frame = projectFrame(state.document, state.currentTime)
    const actor = frame.players.find((player) => player.id === actorId)
    if (!actor) return { notice: '未找到冰圈施法者。' }
    const e = state.document.rulesSnapshot.roles[actor.role].e
    if (!e) return { notice: '冰圈只能由霜役施放。' }
    const action: TacticAction = {
      id: uid('zone'),
      type: 'eZone',
      actorId: actor.id,
      center: { ...actor.position },
      radius: e.radius,
      startTime: state.currentTime,
      duration: e.duration,
    }
    const next = cloneDocument(state.document)
    next.actions.push(action)
    return {
      ...applyDocument(state, next),
      tool: 'select' as const,
      selection: { kind: 'player' as const, id: actor.id },
      notice: null,
      isPlaying: false,
    }
  }),

  createAction: (actorId, target, targetPlayerId) =>
    set((state) => {
      const document = state.document
      const clampedTarget = clampPoint(target, document.rulesSnapshot.field.width, document.rulesSnapshot.field.height)
      if (state.boardMode === 'basic') {
        if (state.tool !== 'move') return { notice: '基础模式只支持移动箭头。' }
        const actor = actorId
          ? document.initialScene.players.find((player) => player.id === actorId)
          : undefined
        if (!actor) return { notice: '请先选择一名球员。' }
        if (distance(actor.position, clampedTarget) < 0.05) return { notice: '箭头目标不能与球员当前位置重合。' }
        const next = cloneDocument(document)
        const existing = next.staticMoveArrows.find((arrow) => arrow.playerId === actor.id)
        next.staticMoveArrows = next.staticMoveArrows.filter((arrow) => arrow.playerId !== actor.id)
        next.staticMoveArrows.push({
          id: existing?.id ?? uid('basic-move'),
          playerId: actor.id,
          target: clampedTarget,
        })
        return {
          ...applyDocument(state, next),
          tool: 'select' as const,
          selection: { kind: 'player' as const, id: actor.id },
          notice: null,
        }
      }
      const frame = projectFrame(document, state.currentTime)
      const effectiveActorId = state.tool === 'pass' ? frame.ball.carrierId : actorId
      const actor = effectiveActorId
        ? frame.players.find((player) => player.id === effectiveActorId)
        : undefined
      let action: TacticAction | null = null

      if (isRangeInspectionTool(state.tool)) {
        const inspected = targetPlayerId
          ? frame.players.find((player) => player.id === targetPlayerId)
          : undefined
        return inspected
          ? {
              tool: state.tool,
              selection: { kind: 'player' as const, id: inspected.id },
              notice: null,
            }
          : { notice: `${state.tool === 'attack' ? '攻击范围' : '打击范围'}模式只需点击一名球员，不会创建时间轴动作。` }
      }

      if (state.tool === 'shoot') {
        return { notice: '射门无需选择落点；请直接选择射门球员。' }
      }

      if (state.tool === 'annotation') {
        const origin = actor?.position ?? frame.ball.position
        action = {
          id: uid('note'),
          type: 'annotation',
          startTime: state.currentTime,
          duration: 2,
          path: [{ ...origin }, clampedTarget],
          text: '战术说明',
        }
      } else if (!actor) {
        return { notice: '请先选择一名球员。' }
      } else if (!isToolActorEligible(state.tool, actor, frame, document.rulesSnapshot)) {
        return { notice: state.tool === 'pass' ? '传球者必须是当前持球者。' : '当前球员不能执行该动作。' }
      } else if (state.tool === 'move') {
        const plan = planSimpleLocomotion(
          document,
          actor.id,
          state.currentTime,
          (scheduledActor) => movementDuration([scheduledActor.position, clampedTarget], document.rulesSnapshot),
        )
        if (!plan) return { notice: '无法为该球员找到可用的跑动时间。' }
        const origin = plan.origin
        const path = [{ ...origin }, clampedTarget]
        if (pathLength(path) < 0.05) return { notice: '目标位置与球员当前位置重合。' }
        action = {
          id: uid('move'),
          type: 'move',
          actorId: actor.id,
          path,
          startTime: plan.startTime,
          duration: plan.duration,
        }
      } else if (state.tool === 'qMove') {
        const plan = planSimpleQ(document, actor.id, state.currentTime)
        if (!plan) return { notice: '无法为该球员找到满足冷却的 Q 时间。' }
        const scheduledActor = plan.actor
        const roleRule = document.rulesSnapshot.roles[scheduledActor.role]
        const origin = plan.origin
        let path = [{ ...origin }, clampedTarget]
        if (pathLength(path) < 0.05) return { notice: 'Q 目标不能与施法者当前位置重合。' }
        if (roleRule.q.turnable && distance(origin, clampedTarget) > 0.4) {
          const midpoint = {
            x: (origin.x + clampedTarget.x) / 2,
            y: (origin.y + clampedTarget.y) / 2,
          }
          path = [{ ...origin }, midpoint, clampedTarget]
        }
        path = resolveQPath(
          path,
          roleRule.q.maxDistance,
          roleRule.q.fixedDistance,
          document.rulesSnapshot.field.width,
          document.rulesSnapshot.field.height,
        )
        action = {
          id: uid('q'),
          type: 'qMove',
          actorId: actor.id,
          path,
          targetId: targetPlayerId && frame.players.find((player) => player.id === targetPlayerId)?.team !== actor.team
            ? targetPlayerId
            : undefined,
          startTime: plan.startTime,
          duration: plan.duration,
        }
      } else if (state.tool === 'pass') {
        const targetPlayer = targetPlayerId ? frame.players.find((player) => player.id === targetPlayerId) : undefined
        if (targetPlayer && !isToolTargetPlayerEligible('pass', actor, targetPlayer)) {
          return { notice: targetPlayer.id === actor.id ? '不能把球传给自己。' : '只能把球传给同队球员。' }
        }
        const endpoint = targetPlayer?.position ?? clampedTarget
        const path = [{ ...actor.position }, { ...endpoint }]
        if (pathLength(path) < 0.05) return { notice: '传球目标与持球者位置重合。' }
        action = {
          id: uid('pass'),
          type: 'pass',
          actorId: actor.id,
          targetPlayerId: targetPlayer?.team === actor.team ? targetPlayer.id : undefined,
          path,
          startTime: state.currentTime,
          duration: passDuration(path, document.rulesSnapshot),
        }
      } else if (state.tool === 'eZone') {
        const e = document.rulesSnapshot.roles[actor.role].e
        if (!e) return { notice: '当前职业没有已配置的 E 范围技能。' }
        action = {
          id: uid('zone'),
          type: 'eZone',
          actorId: actor.id,
          center: { ...actor.position },
          radius: e.radius,
          startTime: state.currentTime,
          duration: e.duration,
        }
      }

      if (!action) return {}
      const next = cloneDocument(document)
      next.actions.push(action)
      if (action.type === 'pass') syncPassEndpoints(next)
      refreshStepSnapshots(next)
      return {
        ...applyDocument(state, next),
        tool: 'select' as const,
        selection: actor ? { kind: 'player' as const, id: actor.id } : null,
        currentTime: action.type === 'move' || action.type === 'qMove' || action.type === 'pass'
          ? actionEndTime(action)
          : action.startTime,
        notice: null,
      }
    }),

  updateActionPathPoint: (actionId, index, rawPoint) => set((state) => {
    const currentAction = state.document.actions.find((candidate) => candidate.id === actionId)
    const currentPath = currentAction ? actionPathSafe(currentAction) : undefined
    if (!currentAction || currentAction.type === 'shoot' || !currentPath?.[index]) return {}

    const patch = mutateDocument(state, (draft) => {
      const action = draft.actions.find((candidate) => candidate.id === actionId)
      const path = action ? actionPathSafe(action) : undefined
      if (!action || !path || !path[index]) return
      const point = clampPoint(rawPoint, draft.rulesSnapshot.field.width, draft.rulesSnapshot.field.height)
      path[index] = point
      if (action.type === 'qMove') {
        const player = draft.initialScene.players.find((candidate) => candidate.id === action.actorId)
        if (player) {
          const q = draft.rulesSnapshot.roles[player.role].q
          action.path = resolveQPath(
            action.path,
            q.maxDistance,
            q.fixedDistance,
            draft.rulesSnapshot.field.width,
            draft.rulesSnapshot.field.height,
          )
        }
      }
      if (action.type === 'move') action.duration = movementDuration(resolvedMovePath(action), draft.rulesSnapshot)
      if (action.type === 'pass') syncPassEndpoints(draft)
      if (!state.showAdvancedTimeline && (action.type === 'move' || action.type === 'qMove')) {
        reflowSimpleLocomotion(draft, action.actorId)
      }
      if (action.type === 'move' || action.type === 'qMove') syncPassEndpoints(draft, action.actorId)
      refreshStepSnapshots(draft)
    })
    return {
      ...patch,
      currentTime: timeAfterActionEdit(currentAction, patch.document.actions.find((action) => action.id === actionId), patch.document, state.currentTime),
    }
  }),

  setMovePathMode: (actionId, mode) => set((state) => {
    const before = state.document.actions.find((action) => action.id === actionId)
    const patch = mutateDocument(state, (draft) => {
      const action = draft.actions.find((candidate) => candidate.id === actionId)
      if (!action || action.type !== 'move') return
      if (mode === 'straight') {
        delete action.curveControl
      } else if (!action.curveControl) {
        const start = action.path[0]
        const end = action.path.at(-1)
        if (!start || !end) return
        const dx = end.x - start.x
        const dy = end.y - start.y
        const length = Math.hypot(dx, dy) || 1
        const offset = Math.min(1, length * 0.2)
        action.curveControl = clampPoint({
          x: (start.x + end.x) / 2 - (dy / length) * offset,
          y: (start.y + end.y) / 2 + (dx / length) * offset,
        }, draft.rulesSnapshot.field.width, draft.rulesSnapshot.field.height)
      }
      action.duration = movementDuration(resolvedMovePath(action), draft.rulesSnapshot)
      if (!state.showAdvancedTimeline) reflowSimpleLocomotion(draft, action.actorId)
      syncPassEndpoints(draft, action.actorId)
      refreshStepSnapshots(draft)
    })
    return { ...patch, currentTime: timeAfterActionEdit(before, patch.document.actions.find((action) => action.id === actionId), patch.document, state.currentTime) }
  }),

  updateMoveCurveControl: (actionId, rawPoint) => set((state) => {
    const before = state.document.actions.find((action) => action.id === actionId)
    const patch = mutateDocument(state, (draft) => {
      const action = draft.actions.find((candidate) => candidate.id === actionId)
      if (!action || action.type !== 'move' || !action.curveControl) return
      action.curveControl = clampPoint(rawPoint, draft.rulesSnapshot.field.width, draft.rulesSnapshot.field.height)
      action.duration = movementDuration(resolvedMovePath(action), draft.rulesSnapshot)
      if (!state.showAdvancedTimeline) reflowSimpleLocomotion(draft, action.actorId)
      syncPassEndpoints(draft, action.actorId)
      refreshStepSnapshots(draft)
    })
    return { ...patch, currentTime: timeAfterActionEdit(before, patch.document.actions.find((action) => action.id === actionId), patch.document, state.currentTime) }
  }),

  updateActionTiming: (actionId, field, value) => set((state) => {
    const action = state.document.actions.find((candidate) => candidate.id === actionId)
    const safeValue = Math.max(0, value)
    if (action?.type === 'receive' && action.sourceActionId) {
      return { notice: '该接球节点由对应传球自动解算，不能单独修改时间。' }
    }
    if (action?.type === 'pass' && action.targetPlayerId && field === 'duration') {
      return { notice: '传球飞行时间由出球时刻与接球队员轨迹自动解算。' }
    }
    if (action?.type === 'wait' && !state.showAdvancedTimeline) {
      const patch = mutateDocument(state, (draft) => {
        const candidate = draft.actions.find((item) => item.id === actionId)
        if (!candidate || candidate.type !== 'wait') return
        if (field === 'duration') candidate.duration = safeValue
        reflowSimpleLocomotion(draft, candidate.actorId ?? '')
        syncPassEndpoints(draft, candidate.actorId)
        refreshStepSnapshots(draft)
      })
      return { ...patch, currentTime: timeAfterActionEdit(action, patch.document.actions.find((item) => item.id === actionId), patch.document, state.currentTime) }
    }
    if (action?.type === 'qMove' && field === 'startTime') {
      const validation = validateQStart(state.document, action.actorId, safeValue, action.id)
      if (!validation.valid) return { notice: qCooldownConflictNotice(validation) }
      return {
        ...mutateDocument(state, (draft) => {
          const candidate = draft.actions.find((item) => item.id === actionId)
          if (candidate && candidate.type === 'qMove') {
            candidate.startTime = safeValue
            syncPassEndpoints(draft, candidate.actorId)
            refreshStepSnapshots(draft)
          }
        }),
        notice: null,
      }
    }
    const patch = mutateDocument(state, (draft) => {
      const candidate = draft.actions.find((item) => item.id === actionId)
      if (!candidate) return
      candidate[field] = safeValue
      if (candidate.type === 'pass') syncPassEndpoints(draft)
      else if ('actorId' in candidate && candidate.actorId) syncPassEndpoints(draft, candidate.actorId)
      refreshStepSnapshots(draft)
    })
    return { ...patch, notice: null }
  }),

  setShotCharge: (actionId, charge) => set((state) => mutateDocument(state, (draft) => {
    const action = draft.actions.find((candidate) => candidate.id === actionId)
    if (!action || action.type !== 'shoot') return
    action.charge = charge
    const frame = projectFrame(draft, action.startTime)
    const player = frame.players.find((candidate) => candidate.id === action.actorId)
    if (player) action.duration = shotDuration(player, charge, draft.rulesSnapshot)
  })),

  deleteAction: (actionId) => set((state) => {
    const removed = state.document.actions.find((action) => action.id === actionId)
    const removedIds = passPairActionIds(state.document, [actionId])
    const patch = mutateDocument(state, (draft) => {
      draft.actions = draft.actions.filter((action) => !removedIds.has(action.id))
      if (!state.showAdvancedTimeline && removed && 'actorId' in removed && removed.actorId
        && (removed.type === 'move' || removed.type === 'qMove' || removed.type === 'wait')) {
        reflowSimpleLocomotion(draft, removed.actorId)
      }
      syncPassEndpoints(draft)
      refreshStepSnapshots(draft)
    })
    return {
      ...patch,
      currentTime: nearestTimelineJoint(patch.document, state.currentTime),
      selection: state.selection?.kind === 'action' && removedIds.has(state.selection.id)
        ? null
        : state.selection,
    }
  }),

  updateStaticMoveArrowTarget: (arrowId, rawTarget) => set((state) => {
    const arrow = state.document.staticMoveArrows.find((candidate) => candidate.id === arrowId)
    if (!arrow) return {}
    const target = clampPoint(rawTarget, state.document.rulesSnapshot.field.width, state.document.rulesSnapshot.field.height)
    const player = state.document.initialScene.players.find((candidate) => candidate.id === arrow.playerId)
    if (!player || distance(player.position, target) < 0.05) return { notice: '箭头目标不能与球员当前位置重合。' }
    return mutateDocument(state, (draft) => {
      const candidate = draft.staticMoveArrows.find((item) => item.id === arrowId)
      if (candidate) candidate.target = target
    })
  }),

  deleteStaticMoveArrow: (arrowId) => set((state) => {
    if (!state.document.staticMoveArrows.some((arrow) => arrow.id === arrowId)) return {}
    return {
      ...mutateDocument(state, (draft) => {
        draft.staticMoveArrows = draft.staticMoveArrows.filter((arrow) => arrow.id !== arrowId)
      }),
      selection: state.selection?.kind === 'staticArrow' && state.selection.id === arrowId
        ? null
        : state.selection,
      notice: '已删除移动箭头，可撤销。',
    }
  }),

  addStep: () => set((state) => {
    const next = cloneDocument(state.document)
    const time = Math.max(
      actionContinuationTime(next),
      isOpeningStep(next, state.activeStepId) ? FIRST_ACTION_STEP_TIME : 0,
    )
    const id = appendStepMarker(next, time)
    return {
      ...applyDocument(state, next),
      activeStepId: id,
      currentTime: time,
      isPlaying: false,
      tool: 'select' as const,
      notice: null,
    }
  }),

  selectStep: (id) => {
    const document = get().document
    const step = document.stepMarkers.find((candidate) => candidate.id === id)
    if (!step) return
    set({ activeStepId: id })
    get().setCurrentTime(step.time)
  },

  renameStep: (id, name) => set((state) => mutateDocument(state, (draft) => {
    const step = draft.stepMarkers.find((candidate) => candidate.id === id)
    if (step) step.name = name.slice(0, 100)
  })),

  updateStepNote: (id, note) => set((state) => mutateDocument(state, (draft) => {
    const step = draft.stepMarkers.find((candidate) => candidate.id === id)
    if (step) step.note = note.slice(0, 1000)
  })),

  deleteStep: (id) => set((state) => {
    const target = state.document.stepMarkers.find((step) => step.id === id)
    if (!target) return {}
    const next = cloneDocument(state.document)

    if (next.stepMarkers.length === 1) {
      next.stepMarkers = [{
        id: target.id,
        time: 0,
        name: '初始站位',
        note: '',
        snapshot: structuredClone(next.initialScene),
      }]
      return {
        ...applyDocument(state, next),
        activeStepId: target.id,
        currentTime: 0,
        isPlaying: false,
        tool: 'select' as const,
        notice: '已删除最后一个步骤，并恢复为初始站位；时间轴动作仍保留，可撤销。',
      }
    }

    const sorted = next.stepMarkers
      .map((step, index) => ({ step, index }))
      .sort((left, right) => left.step.time - right.step.time || left.index - right.index)
    const deletedIndex = sorted.findIndex(({ step }) => step.id === id)
    next.stepMarkers = next.stepMarkers.filter((step) => step.id !== id)
    const activeSurvivor = next.stepMarkers.find((step) => step.id === state.activeStepId)
    const fallback = activeSurvivor
      ?? sorted[deletedIndex - 1]?.step
      ?? sorted[deletedIndex + 1]?.step
      ?? next.stepMarkers[0]
    return {
      ...applyDocument(state, next),
      activeStepId: fallback?.id ?? '',
      currentTime: activeSurvivor ? state.currentTime : fallback?.time ?? 0,
      isPlaying: false,
      tool: 'select' as const,
      notice: `已删除步骤“${target.name}”；时间轴动作仍保留，可撤销。`,
    }
  }),

  clearStepActions: (id) => set((state) => {
    const ownership = getStepActionOwnership(state.document, id)
    if (!ownership || ownership.count === 0) return {}
    const removedIds = passPairActionIds(state.document, ownership.actionIds)
    const step = state.document.stepMarkers.find((candidate) => candidate.id === id)
    const next = cloneDocument(state.document)
    next.actions = next.actions.filter((action) => !removedIds.has(action.id))
    syncPassEndpoints(next)
    const nextDuration = timelineDuration(next)
    const selection = state.selection?.kind === 'action' && !next.actions.some((action) => action.id === state.selection?.id)
      ? null
      : state.selection
    return {
      ...applyDocument(state, next),
      selection,
      tool: 'select' as const,
      isPlaying: false,
      currentTime: Math.min(state.currentTime, nextDuration),
      notice: `已清空“${step?.name ?? '当前帧'}”的 ${ownership.count} 个动作（${formatStepActionRange(ownership)}）；步骤本身保留，可撤销恢复。`,
    }
  }),

  updateFieldRule: (key, value) => set((state) => mutateDocument(state, (draft) => {
    draft.rulesSnapshot.field[key] = Math.max(0.01, value)
    if (key === 'smallPenaltyRadius' && draft.rulesSnapshot.field.smallPenaltyRadius > draft.rulesSnapshot.field.largePenaltyRadius) {
      draft.rulesSnapshot.field.largePenaltyRadius = draft.rulesSnapshot.field.smallPenaltyRadius
    }
    if (key === 'largePenaltyRadius' && draft.rulesSnapshot.field.largePenaltyRadius < draft.rulesSnapshot.field.smallPenaltyRadius) {
      draft.rulesSnapshot.field.smallPenaltyRadius = draft.rulesSnapshot.field.largePenaltyRadius
    }
    recalculateRuleDrivenActions(draft)
    if (!state.showAdvancedTimeline && key === 'baseMoveSpeed') {
      for (const player of draft.initialScene.players) reflowSimpleLocomotion(draft, player.id)
      syncPassEndpoints(draft)
    }
  })),
  updatePassingRule: (key, value) => set((state) => mutateDocument(state, (draft) => {
    draft.rulesSnapshot.passing[key] = Math.max(0.01, value)
    if (key === 'safeDistance' && draft.rulesSnapshot.passing.safeDistance > draft.rulesSnapshot.passing.maxDistance) {
      draft.rulesSnapshot.passing.maxDistance = draft.rulesSnapshot.passing.safeDistance
    }
    if (key === 'maxDistance' && draft.rulesSnapshot.passing.maxDistance < draft.rulesSnapshot.passing.safeDistance) {
      draft.rulesSnapshot.passing.safeDistance = draft.rulesSnapshot.passing.maxDistance
    }
    recalculateRuleDrivenActions(draft)
  })),
  updateShootingRule: (key, value) => set((state) => mutateDocument(state, (draft) => {
    draft.rulesSnapshot.shooting[key] = Math.max(0.01, value)
    recalculateRuleDrivenActions(draft)
  })),
  updateRoleRule: (role, key, value) => set((state) => {
    const documentPatch = mutateDocument(state, (draft) => {
      const roleRule = draft.rulesSnapshot.roles[role]
      const safe = Math.max(0, value)
      if (key === 'attackInnerRadius') roleRule.attackInnerRadius = Math.min(safe, roleRule.attackRadius)
      if (key === 'attackRadius') roleRule.attackRadius = safe
      if (key === 'attackRadius' && (roleRule.attackInnerRadius ?? 0) > safe) roleRule.attackInnerRadius = safe
      if (key === 'qDistance') roleRule.q.maxDistance = safe
      if (key === 'qCooldown') roleRule.q.cooldown = safe
      if (key === 'qDuration') roleRule.q.duration = safe
      if (key !== 'qCooldown') recalculateRuleDrivenActions(draft)
      if (!state.showAdvancedTimeline && (key === 'qDistance' || key === 'qDuration' || key === 'qCooldown')) {
        for (const player of draft.initialScene.players.filter((candidate) => candidate.role === role)) {
          reflowSimpleLocomotion(draft, player.id)
        }
        syncPassEndpoints(draft)
      }
    })
    if (!state.showAdvancedTimeline || key !== 'qCooldown') return documentPatch
    const actorIds = documentPatch.document.initialScene.players
      .filter((player) => player.role === role)
      .map((player) => player.id)
    const violation = firstQCooldownViolation(documentPatch.document, actorIds)
    return violation
      ? { ...documentPatch, notice: `规则已修改；${qCooldownConflictNotice(violation)}` }
      : documentPatch
  }),
  updateRoleExtra: (role, key, value) => set((state) => mutateDocument(state, (draft) => {
    const roleRule = draft.rulesSnapshot.roles[role]
    const safe = Math.max(0, value)
    if (key === 'boostDuration') {
      if (roleRule.afterQBoost) roleRule.afterQBoost.duration = safe
      else if (roleRule.receiveBoost) roleRule.receiveBoost.duration = safe
    }
    if (key === 'boostGain') {
      if (roleRule.afterQBoost) roleRule.afterQBoost.netSeparationGain = safe
      else if (roleRule.receiveBoost) roleRule.receiveBoost.netSeparationGain = safe
    }
    if (key === 'freezeDuration') roleRule.q.freezeDuration = safe
    if (key === 'knockback') roleRule.q.facingKnockback = safe
    if (key === 'slowFullDuration' && roleRule.slow) roleRule.slow.duration = safe
    if (key === 'slowFullLoss' && roleRule.slow) roleRule.slow.fullSeparationLoss = safe
    if (key === 'slowDuration' && roleRule.slow) roleRule.slow.effectiveDuration = safe
    if (key === 'slowLoss' && roleRule.slow) roleRule.slow.effectiveSeparationLoss = safe
    if (key === 'eRadius' && roleRule.e) roleRule.e.radius = safe
    if (key === 'eDuration' && roleRule.e) roleRule.e.duration = safe
    if (key === 'eCooldown' && roleRule.e) roleRule.e.cooldown = safe
    if (key === 'eSlowMultiplier' && roleRule.e) roleRule.e.slowMultiplier = Math.min(1, safe)
    if (key === 'eQDistanceMultiplier' && roleRule.e) roleRule.e.qDistanceMultiplier = Math.min(1, safe)
    recalculateRuleDrivenActions(draft)
  })),
  setMatchup: (attacker, defender, value) => set((state) => mutateDocument(state, (draft) => {
    draft.rulesSnapshot.matchups[attacker][defender] = value
  })),
  setModifier: (id, field, value) => set((state) => mutateDocument(state, (draft) => {
    const modifier = draft.rulesSnapshot.modifiers.find((candidate) => candidate.id === id)
    if (!modifier) return
    if (field === 'enabled' && typeof value === 'boolean') modifier.enabled = value
    if (field === 'delta' && typeof value === 'number' && [-2, -1, 1, 2].includes(value)) {
      modifier.delta = value as -2 | -1 | 1 | 2
    }
  })),
  resetRules: () => set((state) => mutateDocument(state, (draft) => {
    draft.rulesSnapshot = cloneDefaultRules()
    recalculateRuleDrivenActions(draft)
    if (!state.showAdvancedTimeline) {
      for (const player of draft.initialScene.players) reflowSimpleLocomotion(draft, player.id)
      syncPassEndpoints(draft)
    }
  })),

  replaceDocument: (document) => set((state) => {
    const next = cloneDocument(document)
    syncPassEndpoints(next)
    ensureOpeningActionBoundary(next)
    normalizeLegacyDefaultStepNames(next)
    return {
      ...applyDocument(state, next),
      selection: null,
      tool: 'select' as const,
      boardMode: 'simulation' as const,
      activeStepId: next.stepMarkers[0]?.id ?? '',
      currentTime: 0,
      isPlaying: false,
      notice: '战术文件已导入。',
    }
  }),

  newDocument: () => set((state) => {
    const document = createDefaultDocument()
    return {
      ...applyDocument(state, document),
      selection: null,
      tool: 'select' as const,
      boardMode: 'simulation' as const,
      activeStepId: document.stepMarkers[0]?.id ?? '',
      currentTime: 0,
      isPlaying: false,
      notice: '已新建战术。',
    }
  }),

  undo: () => set((state) => {
    const previous = state.past[state.past.length - 1]
    if (!previous) return {}
    saveDraft(previous)
    return {
      document: cloneDocument(previous),
      past: state.past.slice(0, -1),
      future: [cloneDocument(state.document), ...state.future].slice(0, 50),
      selection: null,
      notice: null,
    }
  }),

  redo: () => set((state) => {
    const next = state.future[0]
    if (!next) return {}
    saveDraft(next)
    return {
      document: cloneDocument(next),
      past: [...state.past, cloneDocument(state.document)].slice(-50),
      future: state.future.slice(1),
      selection: null,
      notice: null,
    }
  }),
}))

function actionEndTimeSafe(action: TacticAction): number {
  return action.startTime + Math.max(0, action.duration)
}

function actionPathSafe(action: TacticAction): Vec2[] | undefined {
  return 'path' in action ? action.path : undefined
}

export function getActionLength(action: TacticAction): number | null {
  const path = actionPathSafe(action)
  if (action.type === 'move') return pathLength(resolvedMovePath(action))
  return path ? pathLength(path) : null
}
