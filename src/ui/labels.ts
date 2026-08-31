import type { MatchupRating, RoleId, TacticAction, ToolId } from '../domain/model/types'
import { MATCHUP_LABELS } from '../domain/rules/defaultRules'

export const roleColors: Record<RoleId, string> = {
  water: '#69d8f0',
  fire: '#ff795f',
  ice: '#b9e8ff',
}

export const toolLabels: Record<ToolId, { label: string; shortcut?: string }> = {
  select: { label: '选择', shortcut: 'V' },
  move: { label: '跑动', shortcut: 'M' },
  wait: { label: '等待', shortcut: 'W' },
  qMove: { label: 'Q 位移', shortcut: 'Q' },
  pass: { label: '传球', shortcut: 'P' },
  shoot: { label: '射门', shortcut: 'S' },
  annotation: { label: '说明', shortcut: 'A' },
  attack: { label: '攻击范围', shortcut: 'K' },
  eZone: { label: '冰圈', shortcut: 'E' },
}

export const actionLabels: Record<TacticAction['type'], string> = {
  move: '跑动',
  qMove: 'Q 位移',
  pass: '传球',
  receive: '接球',
  possession: '放下球权',
  shoot: '射门蓄力',
  attack: '攻击命中',
  eZone: '冰圈',
  status: '状态',
  wait: '等待',
  annotation: '说明',
}

export function matchupLabel(rating: MatchupRating): string {
  return rating === null ? '未评估' : MATCHUP_LABELS[rating]
}
