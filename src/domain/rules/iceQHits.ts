import { closestPointOnPath } from '../geometry/geometry'
import type { PlayerState, QMoveAction, RuleSetV1, Vec2 } from '../model/types'

const EPSILON = 1e-6

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

/**
 * Pure geometry analysis. Callers provide the projected actor/opponents at Q start;
 * this function deliberately never projects the document itself.
 */
export function analyzeIceQHits(
  action: QMoveAction,
  actor: PlayerState,
  playersAtStart: PlayerState[],
  rules: RuleSetV1,
): IceQHit[] {
  if (actor.role !== 'ice' || action.path.length < 2) return []
  const radius = rules.roles.ice.attackRadius
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
