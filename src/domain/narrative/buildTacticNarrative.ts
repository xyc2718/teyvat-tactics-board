import { clampPoint, getShootZone, normalizeAngle, oppositeFacingOffset, pathLength, resolvedMovePath } from '../geometry/geometry'
import type { RuleWarning, TacticAction, TacticDocumentV1, Vec2 } from '../model/types'
import { evaluateWarnings } from '../rules/evaluateRules'
import { classifyPassThreat, highestPassThreat, PASS_THREAT_LABELS } from '../rules/passThreat'
import { evaluateShotActionPressure, shotPressureComparison, shotPressureSummary } from '../rules/shotPressure'
import { actionEndTime } from '../timeline/durations'
import { waterQMoveBoost } from '../timeline/movementEffects'
import { analyzeDocumentIceQHits, evaluateQDistanceEffect, projectedMovePath, projectFrame } from '../timeline/projectFrame'

export interface NarrativeEntry {
  id: string
  time: number
  kind: 'step' | 'action'
  title: string
  detail: string
}

export interface TacticNarrative {
  entries: NarrativeEntry[]
  hardWarnings: RuleWarning[]
}

function pointText(point: Vec2 | undefined): string {
  return point ? `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})` : '未知位置'
}

function actorName(document: TacticDocumentV1, action: TacticAction): string {
  if (!('actorId' in action) || !action.actorId) return '战术板'
  return document.initialScene.players.find((player) => player.id === action.actorId)?.name ?? action.actorId
}

function actionDetail(document: TacticDocumentV1, action: TacticAction): string {
  const startFrame = projectFrame(document, action.startTime)
  const endFrame = projectFrame(document, actionEndTime(action))
  const actor = 'actorId' in action ? startFrame.players.find((player) => player.id === action.actorId) : undefined
  const timing = `${action.startTime.toFixed(2)}–${actionEndTime(action).toFixed(2)}s`
  const name = actorName(document, action)

  switch (action.type) {
    case 'move': {
      const route = projectedMovePath(document, action)
      const boost = action.timingConstraint ? null : waterQMoveBoost(document, action)
      const boostText = boost
        ? `；其中 ${boost.overlapStart.toFixed(2)}–${boost.overlapEnd.toFixed(2)}s 为水 Q 加速段，累计身位收益 +${boost.separationGain.toFixed(2)} 格`
        : ''
      if (action.targetPlayerId) {
        const target = document.initialScene.players.find((player) => player.id === action.targetPlayerId)?.name ?? action.targetPlayerId
        return `${timing}，${name} 按自身速度贴身跟随 ${target}，路线 ${pathLength(route).toFixed(2)} 格，追上后保持约 ${(action.followGap ?? 0).toFixed(2)} 格攻击间距，并与目标动作结束时间同步${boostText}。`
      }
      const keyframeConstraint = action.timingConstraint?.kind === 'keyframe' ? action.timingConstraint : null
      const timingReferencePlayer = keyframeConstraint
        ? document.initialScene.players.find((player) => player.id === keyframeConstraint.reference.playerId)
        : null
      const timingText = action.timingConstraint?.kind === 'fixed'
        ? '；按手动时长与基础移速锁定路径长度'
        : action.timingConstraint?.kind === 'keyframe'
          ? `；按 ${timingReferencePlayer?.name ?? '其他球员'}的关键帧时长与基础移速锁定路径长度`
          : ''
      return `${timing}，${name} 从 ${pointText(action.path[0])} 沿 ${pathLength(resolvedMovePath(action)).toFixed(2)} 格${action.curveControl ? '曲线' : '直线'}跑到 ${pointText(action.path.at(-1))}${timingText}${boostText}。`
    }
    case 'qMove': {
      const rule = actor ? document.rulesSnapshot.roles[actor.role] : undefined
      const effect = evaluateQDistanceEffect(document, action)
      const reductionText = effect.reduction > 0.005
        ? `；受敌方冰圈影响，实际位移缩短为 ${effect.effectiveDistance.toFixed(2)} 格`
        : ''
      const base = `${timing}，${name} 沿 ${effect.authoredDistance.toFixed(2)} 格路径执行 ${rule?.q.kind === 'dash' ? '冲刺' : '瞬时位移'}${reductionText}。`
      if (actor?.role === 'ice') {
        const hits = analyzeDocumentIceQHits(document, action)
        if (hits.length === 0) return `${base} 完整路径未命中对手。`
        const knockback = rule?.q.facingKnockback ?? 0
        return `${base} ${hits.map((hit) => {
          const facing = normalizeAngle(hit.target.facing)
          const projectedTarget = projectFrame(document, hit.hitTime).players.find((player) => player.id === hit.targetId)
          const destination = projectedTarget?.position ?? clampPoint(
            oppositeFacingOffset(hit.target.position, facing, knockback),
            document.rulesSnapshot.field.width,
            document.rulesSnapshot.field.height,
          )
          return `${hit.hitTime.toFixed(2)}s 在 ${pointText(hit.closestPoint)} 命中 ${hit.target.name}，冻结 ${rule?.q.freezeDuration ?? 0}s，并按 ${Number(facing.toFixed(1))}° 面向反向后退 ${knockback} 格至 ${pointText(destination)}`
        }).join('；')}。`
      }
      if (rule?.afterQBoost) {
        return `${base} Q 结束后 ${rule.afterQBoost.duration.toFixed(2)}s 内可获得累计 +${rule.afterQBoost.netSeparationGain.toFixed(2)} 格身位收益。`
      }
      return base
    }
    case 'pass': {
      if (!actor) return `${timing}，记录了一次传球。`
      const segments = classifyPassThreat(action.path, actor.team, startFrame, document.rulesSnapshot)
      const threat = highestPassThreat(segments)
      const receiver = action.targetPlayerId
        ? startFrame.players.find((player) => player.id === action.targetPlayerId)?.name ?? action.targetPlayerId
        : '路径终点'
      return `${timing}，${name} 向 ${receiver} 传球 ${pathLength(action.path).toFixed(2)} 格；最高威胁为“${PASS_THREAT_LABELS[threat]}”。`
    }
    case 'shoot': {
      const zone = actor ? getShootZone(actor.position, actor.team, document.rulesSnapshot.field.width, document.rulesSnapshot.field.height, document.rulesSnapshot.field.smallPenaltyRadius, document.rulesSnapshot.field.largePenaltyRadius) : 'outside'
      const shot = endFrame.shots.find((candidate) => candidate.actionId === action.id)
      const pressure = evaluateShotActionPressure(document, action)
      const pressureText = pressure ? `；${shotPressureSummary(pressure)}，${shotPressureComparison(pressure)}` : ''
      return `${timing}，${name} 在${zone === 'inner' ? '小禁区' : zone === 'outer' ? '大禁区' : '禁区外'}进行${action.charge === 'yellow' ? '黄' : '红'}蓄力射门；${shot?.interrupted ? '蓄力被攻击打断' : shot?.completed ? '蓄力完成' : '当前规则下未形成有效射门'}${pressureText}。`
    }
    case 'eZone': {
      const eRule = actor ? document.rulesSnapshot.roles[actor.role].e : undefined
      return `${timing}，${name} 开启以自身为圆心、随移动跟随的 ${action.radius.toFixed(2)} 格冰圈，持续 ${action.duration.toFixed(2)}s；圈内敌方跑动速度为 ${eRule?.slowMultiplier ?? 1}×，仅敌方水 Q 距离为 ${eRule?.qDistanceMultiplier ?? 1}×。`
    }
    case 'receive':
      return `${timing}，${name} 接球并取得球权。`
    case 'possession':
      return `${timing}，球权在 ${pointText(action.position)} 变为自由球。`
    case 'attack': {
      const target = startFrame.players.find((player) => player.id === action.targetId)?.name ?? action.targetId
      return `${timing}，${name} 对 ${target} 执行文件中保留的攻击动作。`
    }
    case 'status': {
      const target = startFrame.players.find((player) => player.id === action.targetId)?.name ?? action.targetId
      if (action.status === 'slowed') {
        return `${timing}，${target} 处于挂冰状态；普通跑动按冰减速规则累计损失身位，Q 位移不受影响。`
      }
      return `${timing}，${target} 获得“${action.status}”状态${action.separationDelta === undefined ? '' : `，身位变化 ${action.separationDelta.toFixed(2)} 格`}。`
    }
    case 'wait':
      return `${timing}，${name} 等待 ${action.duration.toFixed(2)}s。`
    case 'annotation':
      return `${timing}，说明：“${action.text}”，标注路径 ${pathLength(action.path).toFixed(2)} 格。`
  }
}

const actionTitles: Record<TacticAction['type'], string> = {
  move: '跑动', qMove: 'Q 位移', pass: '传球', receive: '接球', possession: '球权', shoot: '射门',
  attack: '攻击', eZone: '冰圈', status: '状态', wait: '等待', annotation: '说明',
}

/** Derived live view only: no narrative text is written to the tactic document. */
export function buildTacticNarrative(document: TacticDocumentV1): TacticNarrative {
  const entries: NarrativeEntry[] = [
    ...document.stepMarkers.map((step) => ({
      id: `step-${step.id}`,
      time: step.time,
      kind: 'step' as const,
      title: `步骤：${step.name}`,
      detail: step.time <= 0
        ? `${step.time.toFixed(2)}s，初始战术状态。${step.note ? ` ${step.note}` : ''}`
        : `${step.time.toFixed(2)}s，继承此前战术的末尾状态。${step.note ? ` ${step.note}` : ''}`,
    })),
    ...document.actions.map((action) => ({
      id: `action-${action.id}`,
      time: action.startTime,
      kind: 'action' as const,
      title: action.type === 'status' && action.status === 'slowed'
        ? `挂冰 · ${document.initialScene.players.find((player) => player.id === action.targetId)?.name ?? action.targetId}`
        : `${actionTitles[action.type]} · ${actorName(document, action)}`,
      detail: actionDetail(document, action),
    })),
  ].sort((left, right) => left.time - right.time || (
    left.kind === right.kind ? 0 : left.kind === 'step' ? -1 : 1
  ))
  const warnings = evaluateWarnings(document)
  return { entries, hardWarnings: warnings.filter((warning) => warning.severity === 'hard') }
}
