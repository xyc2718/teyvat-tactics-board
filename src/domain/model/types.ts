export type TeamId = 'blue' | 'red'
export type RoleId = 'water' | 'fire' | 'ice'
export type MatchupRating = -2 | -1 | 0 | 1 | 2 | null
export type BoardMode = 'simulation' | 'basic'
export type ToolId =
  | 'select'
  | 'move'
  | 'qMove'
  | 'pass'
  | 'shoot'
  | 'annotation'
  | 'attack'
  | 'eZone'

export interface Vec2 {
  x: number
  y: number
}

export interface PlayerState {
  id: string
  name: string
  team: TeamId
  role: RoleId
  position: Vec2
  facing: number
  hasBall: boolean
}

export interface BallState {
  position: Vec2
  carrierId: string | null
  isFree: boolean
}

export type StatusKind = 'frozen' | 'slowed' | 'boosted'

export interface PlayerStatus {
  id: string
  playerId: string
  kind: StatusKind
  sourceActionId: string
  startsAt: number
  endsAt: number
  separationDelta?: number
}

export interface SceneState {
  players: PlayerState[]
  ball: BallState
  statuses: PlayerStatus[]
}

interface BaseAction {
  id: string
  startTime: number
  duration: number
  label?: string
}

export interface MoveAction extends BaseAction {
  type: 'move'
  actorId: string
  path: Vec2[]
}

export interface QMoveAction extends BaseAction {
  type: 'qMove'
  actorId: string
  path: Vec2[]
  targetId?: string
}

export interface PassAction extends BaseAction {
  type: 'pass'
  actorId: string
  targetPlayerId?: string
  path: Vec2[]
}

export interface ReceiveAction extends BaseAction {
  type: 'receive'
  actorId: string
  sourceActionId?: string
}

export interface PossessionAction extends BaseAction {
  type: 'possession'
  carrierId: null
  position: Vec2
}

export interface ShootAction extends BaseAction {
  type: 'shoot'
  actorId: string
  charge: 'yellow' | 'red'
  path: Vec2[]
}

export interface AttackAction extends BaseAction {
  type: 'attack'
  actorId: string
  targetId: string
}

export interface EZoneAction extends BaseAction {
  type: 'eZone'
  actorId: string
  /** Legacy activation snapshot. The live zone center is always the actor position. */
  center: Vec2
  radius: number
}

export interface StatusAction extends BaseAction {
  type: 'status'
  actorId: string
  targetId: string
  status: StatusKind
  separationDelta?: number
}

export interface WaitAction extends BaseAction {
  type: 'wait'
  actorId?: string
}

export interface AnnotationAction extends BaseAction {
  type: 'annotation'
  path: Vec2[]
  text: string
}

export interface StaticMoveArrow {
  id: string
  playerId: string
  target: Vec2
}

export type TacticAction =
  | MoveAction
  | QMoveAction
  | PassAction
  | ReceiveAction
  | PossessionAction
  | ShootAction
  | AttackAction
  | EZoneAction
  | StatusAction
  | WaitAction
  | AnnotationAction

export interface StepMarker {
  id: string
  time: number
  name: string
  note: string
  snapshot: SceneState
}

export interface ViewPreferences {
  analysis: boolean
}

export interface RoleRule {
  id: RoleId
  label: string
  shortLabel: string
  attackInnerRadius?: number
  attackRadius: number
  q: {
    kind: 'blink' | 'dash'
    maxDistance: number
    cooldown: number
    duration: number
    turnable: boolean
    freezeDuration?: number
    facingKnockback?: number
  }
  afterQBoost?: {
    duration: number
    netSeparationGain: number
  }
  receiveBoost?: {
    duration: number
    netSeparationGain: number
    transfersOnPass: boolean
  }
  slow?: {
    duration: number
    fullSeparationLoss: number
    effectiveDuration: number
    effectiveSeparationLoss: number
  }
  e?: {
    radius: number
    duration: number
    cooldown: number
    slowMultiplier: number
    qDistanceMultiplier: number
  }
}

export type MatchupModifierCondition =
  | 'innerZone'
  | 'outerZone'
  | 'attackerQUnavailable'
  | 'defenderQUnavailable'
  | 'attackerControlled'
  | 'defenderControlled'
  | 'separationAdvantage'
  | 'longPass'
  | 'badFacing'

export interface MatchupModifier {
  id: string
  label: string
  condition: MatchupModifierCondition
  delta: -2 | -1 | 1 | 2
  enabled: boolean
}

export interface RuleSetV1 {
  version: string
  field: {
    width: number
    height: number
    baseMoveSpeed: number
    smallPenaltyRadius: number
    largePenaltyRadius: number
  }
  passing: {
    safeDistance: number
    maxDistance: number
    ballSpeed: number
    interceptStartWidth: number
    interceptEndWidth: number
  }
  shooting: {
    outerYellow: number
    outerRed: number
    innerYellow: number
    innerRed: number
    interruptedByAttack: boolean
  }
  roles: Record<RoleId, RoleRule>
  matchups: Record<RoleId, Record<RoleId, MatchupRating>>
  modifiers: MatchupModifier[]
}

export interface TacticDocumentV1 {
  schemaVersion: 1
  meta: {
    title: string
    author: string
    notes: string
    updatedAt: string
  }
  rulesSnapshot: RuleSetV1
  initialScene: SceneState
  staticMoveArrows: StaticMoveArrow[]
  stepMarkers: StepMarker[]
  actions: TacticAction[]
  view: ViewPreferences
}

export interface CooldownState {
  q: number
  e: number
}

export interface ShotState {
  actionId: string
  actorId: string
  progress: number
  interrupted: boolean
  completed: boolean
}

export interface ProjectedFrame extends SceneState {
  time: number
  cooldowns: Record<string, CooldownState>
  shots: ShotState[]
}

export type WarningSeverity = 'info' | 'warning' | 'hard'

export interface RuleWarning {
  id: string
  severity: WarningSeverity
  title: string
  detail: string
  actionId?: string
  playerIds?: string[]
}

export interface MatchupEvaluation {
  attackerId: string
  defenderId: string
  base: MatchupRating
  final: MatchupRating
  appliedModifiers: MatchupModifier[]
  facts: string[]
}
