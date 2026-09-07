export type TeamId = 'blue' | 'red'
export type RoleId = 'water' | 'fire' | 'ice'
export type BasicRoleId = RoleId | 'electro' | 'geo' | 'anemo'
export type MatchupRating = -2 | -1 | 0 | 1 | 2 | null
export type BoardMode = 'simulation' | 'basic'
export type ToolId =
  | 'select'
  | 'move'
  | 'wait'
  | 'qMove'
  | 'pass'
  | 'loosePass'
  | 'shoot'
  | 'annotation'
  | 'attack'
  | 'strikeRange'
  | 'slow'
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

export interface MoveKeyframeReference {
  playerId: string
  actionId: string
  edge: 'start' | 'end'
}

/** A particular free-ball episode, not a moving nearest-ball query. */
export interface BallTargetReference {
  sourceActionId: string | null
}

/** Ordinary pass reception plus an explicitly authored carrying delay. */
export interface ReceptionOriginReference {
  sourceActionId: string
  offset: number
}

export interface PickupTracePoint {
  time: number
  position: Vec2
}

export type MoveTimingConstraint =
  | { kind: 'fixed' }
  | { kind: 'keyframe'; reference: MoveKeyframeReference }
  | { kind: 'qCooldown'; sourceActionId: string }

export interface MoveAction extends BaseAction {
  type: 'move'
  actorId: string
  path: Vec2[]
  /** Optional quadratic Bezier control point. Omitted paths are straight. */
  curveControl?: Vec2
  /** Optional player-following contract. All three fields are persisted together. */
  targetPlayerId?: string
  syncActionId?: string
  followGap?: number
  /** Optional fixed-point timing override. Omitted moves keep rule-derived timing. */
  timingConstraint?: MoveTimingConstraint
  ballTarget?: BallTargetReference
  /** Resolved absolute-time pursuit samples; do not apply movement effects twice. */
  pickupTrace?: PickupTracePoint[]
}

export interface QMoveAction extends BaseAction {
  type: 'qMove'
  actorId: string
  path: Vec2[]
  targetId?: string
  ballTarget?: BallTargetReference
}

export interface PassAction extends BaseAction {
  type: 'pass'
  actorId: string
  targetPlayerId?: string
  /** Optional same-time action edge that fixes whether the pass starts before or after an instant Q. */
  originKeyframe?: MoveKeyframeReference
  originPickupActionId?: string
  originReception?: ReceptionOriginReference
  /** Resolved named-pass result. Missing only on legacy or unaddressed passes. */
  flightOutcome?: 'received' | 'dropped'
  path: Vec2[]
}

export interface LoosePassAction extends BaseAction {
  type: 'loosePass'
  actorId: string
  aimDirection: Vec2
  path: Vec2[]
  originKeyframe?: MoveKeyframeReference
  originPickupActionId?: string
  originReception?: ReceptionOriginReference
  flightOutcome: 'grounded' | 'goal' | 'pickedUp'
}

export interface ReceiveAction extends BaseAction {
  type: 'receive'
  actorId: string
  sourceActionId?: string
  pickupActionId?: string
  ballSourceActionId?: string | null
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
  /** Legacy imports may identify a source, but authored statuses belong only to their target. */
  actorId?: string
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
  | LoosePassAction
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
    fixedDistance: boolean
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
  /** Absent in legacy snapshots; materialized only when authoring an empty pass. */
  loosePassing?: { maxDistance: number; maxDuration: number }
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
  /** Display identities for the basic board; never simulation roles or step state. */
  basicPlayerRoles?: Record<string, BasicRoleId>
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
