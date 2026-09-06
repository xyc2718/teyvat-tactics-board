import type { PlayerState, ProjectedFrame, RuleSetV1, ToolId } from '../domain/model/types'

const ACTOR_TOOLS: ReadonlySet<ToolId> = new Set([
  'move',
  'wait',
  'qMove',
  'pass',
  'loosePass',
  'shoot',
  'attack',
  'strikeRange',
  'eZone',
])

export function isRangeInspectionTool(tool: ToolId): boolean {
  return tool === 'attack' || tool === 'strikeRange'
}

export function isBallReleaseTool(tool: ToolId): tool is 'pass' | 'loosePass' {
  return tool === 'pass' || tool === 'loosePass'
}

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
  if (isBallReleaseTool(tool)) return frame.ball.carrierId === player.id
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
  if (isBallReleaseTool(tool)) {
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
  if (tool === 'move') return true
  if (isRangeInspectionTool(tool)) return true
  return false
}

export function actorPrompt(tool: ToolId): string {
  if (isBallReleaseTool(tool)) return '当前没有持球者，请先在“选择”模式设置球权'
  if (tool === 'eZone') return '选择一名霜役立即开启随身冰圈'
  if (tool === 'attack') return '选择任意球员查看其攻击内外范围'
  if (tool === 'strikeRange') return '选择任意球员查看其 Q 技能加攻击的最大打击范围'
  if (tool === 'shoot') return '选择射门球员；点击后自动瞄准对方球门中心'
  if (tool === 'wait') return '选择一名球员，为其动作链添加等待'
  if (tool === 'move') return '第 1/2 步：选择球员；画面会自动跳到该球员的最新关键帧'
  if (tool === 'qMove') return '第 1/2 步：选择球员；画面会自动跳到下一个可用 Q 起点'
  return '第 1/2 步：选择一名球员作为动作发起者'
}

export function targetPrompt(tool: ToolId): string {
  if (tool === 'qMove') return '第 2/2 步：点击落点，或点击自由球用 Q 捡球；可返回第 1 步'
  if (tool === 'pass') return '第 2/2 步：参考安全/最远距离圈；点击队友后系统按其移动轨迹解算接球点，也可点击空地'
  if (tool === 'loosePass') return '第 2/2 步：点击空地指定空传方向；球会沿直线飞行，遇墙反弹'
  if (tool === 'eZone') return '冰圈始终以霜役为圆心并随其移动'
  if (tool === 'attack') return '点击其他球员可连续切换攻击范围查看对象'
  if (tool === 'strikeRange') return '点击其他球员可连续切换打击范围查看对象'
  if (tool === 'shoot') return '选择射门球员；无需指定落点'
  if (tool === 'wait') return '选择球员后立即添加 1 秒等待，并可在右侧修改时长'
  if (tool === 'move') return '第 2/2 步：点击空地跑动、球员跟随或自由球捡球；可返回第 1 步'
  return '点击球场上的目标位置'
}
