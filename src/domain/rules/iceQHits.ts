import { clamp, closestPointOnPath, distance, pathLength, pointAlongPath } from '../geometry/geometry'
import type { PlayerState, QMoveAction, RuleSetV1, Vec2 } from '../model/types'

const EPSILON = 1e-6
const DYNAMIC_SAMPLE_SECONDS = 0.025
const DYNAMIC_SAMPLE_DISTANCE = 0.05

export interface IceQHit {
  actionId: string
  targetId: string
  target: PlayerState
  closestPoint: Vec2
  pathDistance: number
  pathProgress: number
  distance: number
  hitTime: number
}

export type ProjectIceQPlayersAtTime = (time: number) => PlayerState[]

function interpolatePoint(start: Vec2, end: Vec2, progress: number): Vec2 {
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  }
}

function pathVertexProgresses(path: Vec2[]): number[] {
  const total = pathLength(path)
  if (total <= EPSILON) return [0, 1]
  const progresses = [0]
  let traveled = 0
  for (let index = 1; index < path.length; index += 1) {
    traveled += distance(path[index - 1]!, path[index]!)
    progresses.push(clamp(traveled / total, 0, 1))
  }
  return progresses
}

function dynamicSampleProgresses(action: QMoveAction): number[] {
  const length = pathLength(action.path)
  const steps = Math.max(
    1,
    Math.ceil(Math.max(0, action.duration) / DYNAMIC_SAMPLE_SECONDS),
    Math.ceil(length / DYNAMIC_SAMPLE_DISTANCE),
  )
  const progresses = new Set(pathVertexProgresses(action.path).map((progress) => progress.toFixed(9)))
  for (let index = 0; index <= steps; index += 1) progresses.add((index / steps).toFixed(9))
  return [...progresses].map(Number).sort((left, right) => left - right)
}

interface DynamicClosestApproach {
  progress: number
  qPosition: Vec2
  targetPosition: Vec2
  distance: number
}

function closestSynchronizedApproach(
  action: QMoveAction,
  targetId: string,
  playersAtProgress: Map<number, PlayerState[]>,
  progresses: number[],
): DynamicClosestApproach | undefined {
  let best: DynamicClosestApproach | undefined
  for (let index = 1; index < progresses.length; index += 1) {
    const startProgress = progresses[index - 1]!
    const endProgress = progresses[index]!
    const startTarget = playersAtProgress.get(startProgress)?.find((player) => player.id === targetId)
    const endTarget = playersAtProgress.get(endProgress)?.find((player) => player.id === targetId)
    if (!startTarget || !endTarget) continue

    const startQ = pointAlongPath(action.path, startProgress)
    const endQ = pointAlongPath(action.path, endProgress)
    const relativeStart = {
      x: startTarget.position.x - startQ.x,
      y: startTarget.position.y - startQ.y,
    }
    const relativeDelta = {
      x: (endTarget.position.x - startTarget.position.x) - (endQ.x - startQ.x),
      y: (endTarget.position.y - startTarget.position.y) - (endQ.y - startQ.y),
    }
    const denominator = relativeDelta.x ** 2 + relativeDelta.y ** 2
    const intervalProgress = denominator <= EPSILON
      ? 0
      : clamp(
          -(relativeStart.x * relativeDelta.x + relativeStart.y * relativeDelta.y) / denominator,
          0,
          1,
        )
    const qPosition = interpolatePoint(startQ, endQ, intervalProgress)
    const targetPosition = interpolatePoint(startTarget.position, endTarget.position, intervalProgress)
    const candidate = {
      progress: startProgress + (endProgress - startProgress) * intervalProgress,
      qPosition,
      targetPosition,
      distance: distance(qPosition, targetPosition),
    }
    if (
      !best ||
      candidate.distance < best.distance - EPSILON ||
      (Math.abs(candidate.distance - best.distance) <= EPSILON && candidate.progress < best.progress)
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * Pure geometry analysis. With a time projector, moving opponents are compared
 * against the Q position at the same time; without one, this retains the exact
 * static-path calculation used by isolated geometry callers.
 */
export function analyzeIceQHits(
  action: QMoveAction,
  actor: PlayerState,
  playersAtStart: PlayerState[],
  rules: RuleSetV1,
  projectPlayersAtTime?: ProjectIceQPlayersAtTime,
): IceQHit[] {
  if (actor.role !== 'ice' || action.path.length < 2) return []
  const radius = rules.roles.ice.attackRadius
  if (projectPlayersAtTime && action.duration > EPSILON) {
    const progresses = dynamicSampleProgresses(action)
    const playersAtProgress = new Map(progresses.map((progress) => [
      progress,
      projectPlayersAtTime(action.startTime + action.duration * progress),
    ]))
    return playersAtStart
      .filter((player) => player.team !== actor.team)
      .flatMap((target) => {
        const closest = closestSynchronizedApproach(action, target.id, playersAtProgress, progresses)
        if (!closest || closest.distance > radius + EPSILON) return []
        const hitTime = action.startTime + action.duration * closest.progress
        const projectedTarget = projectPlayersAtTime(hitTime).find((player) => player.id === target.id)
        const hitTarget = projectedTarget ?? { ...target, position: closest.targetPosition }
        const exactDistance = distance(closest.qPosition, hitTarget.position)
        if (exactDistance > radius + EPSILON) return []
        return [{
          actionId: action.id,
          targetId: target.id,
          target: { ...hitTarget, position: { ...hitTarget.position } },
          closestPoint: closest.qPosition,
          pathDistance: pathLength(action.path) * closest.progress,
          pathProgress: closest.progress,
          distance: exactDistance,
          hitTime,
        }]
      })
      .sort((left, right) => left.hitTime - right.hitTime || left.targetId.localeCompare(right.targetId))
  }
  return playersAtStart
    .filter((player) => player.team !== actor.team)
    .flatMap((target) => {
      const closest = closestPointOnPath(target.position, action.path)
      if (!closest || closest.distance > radius + EPSILON) return []
      return [{
        actionId: action.id,
        targetId: target.id,
        target: { ...target, position: { ...target.position } },
        closestPoint: closest.point,
        pathDistance: closest.pathDistance,
        pathProgress: closest.progress,
        distance: closest.distance,
        hitTime: action.startTime + Math.max(0, action.duration) * closest.progress,
      }]
    })
    .sort((left, right) => left.hitTime - right.hitTime || left.targetId.localeCompare(right.targetId))
}
