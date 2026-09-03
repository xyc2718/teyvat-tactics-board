import type { MoveKeyframeReference, QMoveAction, TacticAction, TacticDocumentV1 } from '../model/types'
import { actionEndTime } from './durations'

const INSTANT_ACTION_EPSILON = 1e-6

export interface PlayerActionKeyframe {
  id: string
  playerId: string
  actionId: string
  edge: 'start' | 'end'
  time: number
  label: string
  reference: MoveKeyframeReference
}

export function actionActorId(action: TacticAction | undefined): string | null {
  if (!action || !('actorId' in action)) return null
  return action.actorId ?? null
}

export function instantQActionAtKeyframe(
  document: TacticDocumentV1,
  reference: MoveKeyframeReference | null | undefined,
): QMoveAction | null {
  if (!reference) return null
  const action = document.actions.find((candidate) => candidate.id === reference.actionId)
  return action?.type === 'qMove'
    && action.actorId === reference.playerId
    && action.duration <= INSTANT_ACTION_EPSILON
    ? action
    : null
}

export function actionTimelineKeyframes(action: TacticAction): Array<{ edge: 'start' | 'end'; time: number }> {
  if (action.type === 'qMove' && action.duration <= INSTANT_ACTION_EPSILON) {
    return [
      { edge: 'start', time: action.startTime },
      { edge: 'end', time: action.startTime },
    ]
  }
  if (action.type === 'pass' || action.duration <= INSTANT_ACTION_EPSILON) {
    return [{ edge: 'start', time: action.startTime }]
  }
  return [
    { edge: 'start', time: action.startTime },
    { edge: 'end', time: actionEndTime(action) },
  ]
}

export function playerActionKeyframes(
  document: TacticDocumentV1,
  playerId: string,
): PlayerActionKeyframe[] {
  return document.actions
    .filter((action) => actionActorId(action) === playerId)
    .flatMap((action) => actionTimelineKeyframes(action).map(({ edge, time }) => ({
      id: `${action.id}-${edge}`,
      playerId,
      actionId: action.id,
      edge,
      time,
      label: `${action.label?.trim() || actionTypeLabel(action.type)}${edge === 'start' ? '开始' : '结束'}`,
      reference: { playerId, actionId: action.id, edge },
    })))
    .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id))
}

export function resolveMoveKeyframeTime(
  document: TacticDocumentV1,
  reference: MoveKeyframeReference,
): number | null {
  const action = document.actions.find((candidate) => candidate.id === reference.actionId)
  if (!action || actionActorId(action) !== reference.playerId) return null
  return reference.edge === 'start' ? action.startTime : actionEndTime(action)
}

function actionTypeLabel(type: TacticAction['type']): string {
  const labels: Record<TacticAction['type'], string> = {
    move: '跑动',
    qMove: 'Q 技能',
    pass: '传球',
    receive: '接球',
    possession: '球权',
    shoot: '射门',
    attack: '攻击',
    eZone: '冰圈',
    status: '状态',
    wait: '等待',
    annotation: '说明',
  }
  return labels[type]
}
