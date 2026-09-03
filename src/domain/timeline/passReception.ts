import { pathLength } from '../geometry/geometry'
import type { PassAction, TacticDocumentV1, Vec2 } from '../model/types'
import { passDuration } from './durations'
import { projectFrame, projectFrameAtKeyframe } from './projectFrame'

const SOLVER_SAMPLES = 256
const SOLVER_ITERATIONS = 36
const DISTANCE_EPSILON = 1e-6
const TIME_EPSILON = 1e-5

export interface PassReceptionResolution {
  path: Vec2[]
  duration: number
  arrivalTime: number
  received: boolean
  receiverPosition?: Vec2
}

function withoutPassPair(document: TacticDocumentV1, passId: string): TacticDocumentV1 {
  return {
    ...document,
    actions: document.actions.filter(
      (action) => action.id !== passId
        && !(action.type === 'receive' && action.sourceActionId === passId),
    ),
  }
}

/**
 * Solves the earliest meeting between a pass started now and the named
 * receiver's projected future movement. The pass itself and its generated
 * receive event are removed from projection so the receive boost cannot move
 * the target before the catch that creates that boost.
 */
export function solvePassReception(
  document: TacticDocumentV1,
  pass: PassAction,
): PassReceptionResolution {
  const projectionDocument = withoutPassPair(document, pass.id)
  const startFrame = projectFrameAtKeyframe(
    projectionDocument,
    pass.startTime,
    pass.originKeyframe ?? null,
  )
  const passer = startFrame.players.find((player) => player.id === pass.actorId)
  const origin = passer?.position ?? pass.path[0]
  const authoredEndpoint = pass.path.at(-1) ?? origin

  if (!origin) {
    return {
      path: pass.path.map((point) => ({ ...point })),
      duration: passDuration(pass.path, document.rulesSnapshot),
      arrivalTime: pass.startTime,
      received: false,
    }
  }

  if (!pass.targetPlayerId) {
    const path = [{ ...origin }, ...pass.path.slice(1).map((point) => ({ ...point }))]
    const duration = passDuration(path, document.rulesSnapshot)
    return {
      path,
      duration,
      arrivalTime: pass.startTime + duration,
      received: false,
    }
  }

  const receiverAt = (elapsed: number) => projectFrame(
    projectionDocument,
    pass.startTime + elapsed,
  ).players.find((player) => player.id === pass.targetPlayerId)?.position

  const candidateAt = (elapsed: number) => {
    const receiverPosition = receiverAt(elapsed)
    if (!receiverPosition) return null
    const path = [{ ...origin }, { ...receiverPosition }]
    const length = pathLength(path)
    if (length > document.rulesSnapshot.passing.maxDistance + DISTANCE_EPSILON) return null
    return {
      path,
      receiverPosition: { ...receiverPosition },
      flightTime: passDuration(path, document.rulesSnapshot),
    }
  }

  const maxFlightTime = document.rulesSnapshot.passing.maxDistance
    / Math.max(document.rulesSnapshot.passing.ballSpeed, DISTANCE_EPSILON)
  let previousTime = 0
  let previous = candidateAt(previousTime)

  if (previous && Math.abs(previous.flightTime) <= TIME_EPSILON) {
    return {
      path: previous.path,
      duration: 0,
      arrivalTime: pass.startTime,
      received: true,
      receiverPosition: previous.receiverPosition,
    }
  }

  for (let sample = 1; sample <= SOLVER_SAMPLES; sample += 1) {
    const sampleTime = (maxFlightTime * sample) / SOLVER_SAMPLES
    const candidate = candidateAt(sampleTime)
    const previousDelta = previous ? previous.flightTime - previousTime : null
    const sampleDelta = candidate ? candidate.flightTime - sampleTime : null

    if (
      previous
      && candidate
      && previousDelta !== null
      && sampleDelta !== null
      && previousDelta >= -TIME_EPSILON
      && sampleDelta <= TIME_EPSILON
    ) {
      let low = previousTime
      let high = sampleTime
      for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
        const middle = (low + high) / 2
        const middleCandidate = candidateAt(middle)
        if (!middleCandidate || middleCandidate.flightTime - middle > 0) low = middle
        else high = middle
      }
      const solvedTime = (low + high) / 2
      const solved = candidateAt(solvedTime)
      if (solved && Math.abs(solved.flightTime - solvedTime) <= 0.002) {
        return {
          path: solved.path,
          duration: solved.flightTime,
          arrivalTime: pass.startTime + solved.flightTime,
          received: true,
          receiverPosition: solved.receiverPosition,
        }
      }
    }

    previousTime = sampleTime
    previous = candidate
  }

  const lastReceiver = receiverAt(maxFlightTime)
  const fallbackEndpoint = lastReceiver ?? authoredEndpoint ?? origin
  const path = [{ ...origin }, { ...fallbackEndpoint }]
  const duration = passDuration(path, document.rulesSnapshot)
  return {
    path,
    duration,
    arrivalTime: pass.startTime + duration,
    received: false,
    receiverPosition: lastReceiver ? { ...lastReceiver } : undefined,
  }
}
