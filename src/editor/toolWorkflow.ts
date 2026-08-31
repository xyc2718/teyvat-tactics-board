import type { PlayerState, ProjectedFrame, RuleSetV1, ToolId } from '../domain/model/types'

const ACTOR_TOOLS: ReadonlySet<ToolId> = new Set([
  'move',
  'qMove',
  'pass',
  'shoot',
  'attack',
  'eZone',
])

export function toolNeedsActor(tool: ToolId): boolean {
  return ACTOR_TOOLS.has(tool)
}

export function isToolActorEligible(
  tool: ToolId,
  player: PlayerState,
  frame: ProjectedFrame,
  rules: RuleSetV1,
): boolean {
  if (!toolNeedsActor(tool)) return false
  if (tool === 'pass') return frame.ball.carrierId === player.id && player.hasBall
  if (tool === 'eZone') return rules.roles[player.role].e !== undefined
  return true
}

export function resolveToolActor(
  tool: ToolId,
  selectedPlayer: PlayerState | undefined,
  frame: ProjectedFrame,
  rules: RuleSetV1,
): PlayerState | undefined {
  if (!toolNeedsActor(tool)) return undefined
  if (tool === 'pass') {
    const carrier = frame.ball.carrierId
      ? frame.players.find((player) => player.id === frame.ball.carrierId)
      : undefined
    return carrier && isToolActorEligible(tool, carrier, frame, rules) ? carrier : undefined
  }
  return selectedPlayer && isToolActorEligible(tool, selectedPlayer, frame, rules)
    ? selectedPlayer
    : undefined
}

export function isToolTargetPlayerEligible(
  tool: ToolId,
  actor: PlayerState,
  target: PlayerState,
): boolean {
  if (target.id === actor.id) return false
  if (tool === 'pass') return target.team === actor.team
  if (tool === 'attack') return true
  return tool === 'qMove'
}

export function actorPrompt(tool: ToolId): string {
  if (tool === 'pass') return '当前没有持球者，请先在“选择”模式设置球权'
  if (tool === 'eZone') return '选择一名霜役立即开启随身冰圈'
  if (tool === 'attack') return '选择任意球员查看其攻击内外范围'
  if (tool === 'shoot') return '选择射门球员；点击后自动瞄准对方球门中心'
  return '第 1/2 步：选择一名球员作为动作发起者'
}

export function targetPrompt(tool: ToolId): string {
  if (tool === 'qMove') return '第 2/2 步：移动指针预览 Q 距离，再点击目标或落点'
  if (tool === 'pass') return '第 2/2 步：移动指针查看传球区间，再点击队友或空地'
  if (tool === 'eZone') return '冰圈始终以霜役为圆心并随其移动'
  if (tool === 'attack') return '点击其他球员可连续切换攻击范围查看对象'
  if (tool === 'shoot') return '选择射门球员；无需指定落点'
  return '点击球场上的目标位置'
}
