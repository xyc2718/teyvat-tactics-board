import { distance, pathLength } from '../geometry/geometry'
import type {
  MatchupEvaluation,
  PassAction,
  PlayerState,
  ProjectedFrame,
  TacticDocumentV1,
  TeamId,
} from '../model/types'
import { actionEndTime } from '../timeline/durations'
import { projectFrame } from '../timeline/projectFrame'
import { evaluateMatchup } from './evaluateRules'
import { evaluateReachTiming, type ReachTiming } from './reachTime'

const EPSILON = 1e-6
const CONTEST_TIE_SECONDS = 0.01

export interface PossessionMatchupSituation {
  kind: 'matchup'
  possessionSource: 'carrier' | 'pass'
  offenseTeam: TeamId
  possessionPlayer: PlayerState
  selectedPerspective: 'attacking' | 'defending'
  attacker: PlayerState
  defender: PlayerState
  opponent: PlayerState
  evaluation: MatchupEvaluation
}

export interface BallArrival extends ReachTiming {
  player: PlayerState
  ballDistance: number
}

export interface LooseBallSituation {
  kind: 'looseBall'
  selectedArrival: BallArrival
  opponentArrival: BallArrival
  outcome: 'ahead' | 'level' | 'behind'
  margin: number
}

export type PlayerSituation = PossessionMatchupSituation | LooseBallSituation

function nearestOpponent(frame: ProjectedFrame, selected: PlayerState): PlayerState | undefined {
  return frame.players
    .filter((player) => player.team !== selected.team)
    .sort(
      (left, right) =>
        distance(selected.position, left.position) - distance(selected.position, right.position)
        || left.id.localeCompare(right.id),
    )[0]
}

function passStillFlying(document: TacticDocumentV1, pass: PassAction, time: number): boolean {
  const length = pathLength(pass.path)
  const maxProgress = Math.min(1, document.rulesSnapshot.passing.maxDistance / Math.max(length, 0.001))
  const flightEnd = pass.startTime + Math.max(0, pass.duration) * maxProgress
  return time + EPSILON >= pass.startTime && time < flightEnd - EPSILON && time < actionEndTime(pass) - EPSILON
}

function latestFlyingPass(
  document: TacticDocumentV1,
  frame: ProjectedFrame,
  time: number,
): { pass: PassAction; passer: PlayerState } | null {
  const passes = document.actions
    .map((action, index) => ({ action, index }))
    .filter(
      (entry): entry is { action: PassAction; index: number } =>
        entry.action.type === 'pass' && passStillFlying(document, entry.action, time),
    )
    .sort((left, right) => right.action.startTime - left.action.startTime || right.index - left.index)
  const pass = passes[0]?.action
  const passer = pass ? frame.players.find((player) => player.id === pass.actorId) : undefined
  return pass && passer ? { pass, passer } : null
}

function arrivalToBall(
  document: TacticDocumentV1,
  frame: ProjectedFrame,
  player: PlayerState,
): BallArrival {
  const ballDistance = distance(player.position, frame.ball.position)
  return {
    player,
    ballDistance,
    ...evaluateReachTiming(frame, player, ballDistance, document.rulesSnapshot),
  }
}

export function evaluatePlayerSituation(
  document: TacticDocumentV1,
  time: number,
  selectedPlayerId: string,
): PlayerSituation | null {
  const frame = projectFrame(document, time)
  const selected = frame.players.find((player) => player.id === selectedPlayerId)
  if (!selected) return null

  const carrier = frame.ball.carrierId
    ? frame.players.find((player) => player.id === frame.ball.carrierId)
    : undefined
  const flyingPass = carrier ? null : latestFlyingPass(document, frame, time)
  const possessionPlayer = carrier ?? flyingPass?.passer

  if (possessionPlayer) {
    const opponent = nearestOpponent(frame, selected)
    if (!opponent) return null
    const selectedPerspective = selected.team === possessionPlayer.team ? 'attacking' : 'defending'
    const attacker = selectedPerspective === 'attacking' ? selected : opponent
    const defender = selectedPerspective === 'attacking' ? opponent : selected
    const evaluation = evaluateMatchup(document, time, attacker.id, defender.id)
    if (!evaluation) return null
    return {
      kind: 'matchup',
      possessionSource: carrier ? 'carrier' : 'pass',
      offenseTeam: possessionPlayer.team,
      possessionPlayer,
      selectedPerspective,
      attacker,
      defender,
      opponent,
      evaluation,
    }
  }

  const selectedArrival = arrivalToBall(document, frame, selected)
  const opponentArrival = frame.players
    .filter((player) => player.team !== selected.team)
    .map((player) => arrivalToBall(document, frame, player))
    .sort(
      (left, right) =>
        left.earliestTime - right.earliestTime || left.player.id.localeCompare(right.player.id),
    )[0]
  if (!opponentArrival) return null
  const signedMargin = opponentArrival.earliestTime - selectedArrival.earliestTime
  const outcome = Math.abs(signedMargin) <= CONTEST_TIE_SECONDS
    ? 'level'
    : signedMargin > 0 ? 'ahead' : 'behind'
  return {
    kind: 'looseBall',
    selectedArrival,
    opponentArrival,
    outcome,
    margin: Math.abs(signedMargin),
  }
}
