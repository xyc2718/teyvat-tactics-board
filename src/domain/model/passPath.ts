import type { PassAction, Vec2 } from './types'

export function anchorPassPathToPlayer(
  action: PassAction,
  playerId: string,
  position: Vec2,
): Vec2[] {
  const path = action.path.map((point) => ({ ...point }))
  if (path.length === 0) return path
  if (action.actorId === playerId) path[0] = { ...position }
  if (action.targetPlayerId === playerId) path[path.length - 1] = { ...position }
  return path
}
