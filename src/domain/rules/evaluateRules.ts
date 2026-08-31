import {
  clampPoint,
  distance,
  getShootZone,
  oppositeFacingOffset,
  pathLength,
} from '../geometry/geometry'
import type {
  MatchupEvaluation,
  MatchupModifierCondition,
  MatchupRating,
  PassAction,
  RuleWarning,
  ShootAction,
  TacticDocumentV1,
} from '../model/types'
import { actionEndTime } from '../timeline/durations'
import { analyzeDocumentIceQHits, doesEZoneSlowMove, evaluateQDistanceEffect, projectFrame } from '../timeline/projectFrame'
import { classifyPassThreat, highestPassThreat, PASS_THREAT_LABELS } from './passThreat'
import { cooldownRemainingText, qCooldownSequenceConflicts } from './qCooldown'
import { evaluateShotActionPressure, shotPressureComparison, shotPressureModeLabel, shotPressureSummary } from './shotPressure'

function clampRating(value: number): Exclude<MatchupRating, null> {
  return Math.max(-2, Math.min(2, Math.round(value))) as Exclude<MatchupRating, null>
}

function latestPassTo(document: TacticDocumentV1, playerId: string, time: number): PassAction | undefined {
  return [...document.actions]
    .filter(
      (action): action is PassAction =>
        action.type === 'pass' && action.targetPlayerId === playerId && actionEndTime(action) <= time,
    )
    .sort((a, b) => b.startTime - a.startTime)[0]
}

export function evaluateMatchup(
  document: TacticDocumentV1,
  time: number,
  attackerId: string,
  defenderId: string,
): MatchupEvaluation | null {
  const frame = projectFrame(document, time)
  const attacker = frame.players.find((player) => player.id === attackerId)
  const defender = frame.players.find((player) => player.id === defenderId)
  if (!attacker || !defender || attacker.team === defender.team) return null

  const rules = document.rulesSnapshot
  const base = rules.matchups[attacker.role][defender.role]
  const zone = getShootZone(
    attacker.position,
    attacker.team,
    rules.field.width,
    rules.field.height,
    rules.field.smallPenaltyRadius,
    rules.field.largePenaltyRadius,
  )
  const gap = distance(attacker.position, defender.position)
  const attackerControlled = frame.statuses.some(
    (status) => status.playerId === attacker.id && (status.kind === 'frozen' || status.kind === 'slowed'),
  )
  const defenderControlled = frame.statuses.some(
    (status) => status.playerId === defender.id && (status.kind === 'frozen' || status.kind === 'slowed'),
  )
  const pass = latestPassTo(document, attacker.id, time)
  const passDistance = pass ? pathLength(pass.path) : 0

  const conditions: Record<MatchupModifierCondition, boolean> = {
    innerZone: zone === 'inner',
    outerZone: zone === 'outer',
    attackerQUnavailable: (frame.cooldowns[attacker.id]?.q ?? 0) > 0,
    defenderQUnavailable: (frame.cooldowns[defender.id]?.q ?? 0) > 0,
    attackerControlled,
    defenderControlled,
    separationAdvantage: gap > rules.roles[defender.role].attackRadius + 0.5,
    longPass: passDistance > rules.passing.safeDistance,
    badFacing:
      attacker.role === 'ice' &&
      distance(
        clampPoint(
          oppositeFacingOffset(
            defender.position,
            defender.facing,
            rules.roles.ice.q.facingKnockback ?? 0,
          ),
          rules.field.width,
          rules.field.height,
        ),
        attacker.position,
      ) <= gap,
  }
  const appliedModifiers = rules.modifiers.filter(
    (modifier) => modifier.enabled && conditions[modifier.condition],
  )
  const final = base === null
    ? null
    : clampRating(base + appliedModifiers.reduce((sum, modifier) => sum + modifier.delta, 0))

  const facts = [
    `双方距离 ${gap.toFixed(2)} 格`,
    `进攻方 Q ${conditions.attackerQUnavailable ? '冷却中' : '可用'}`,
    `防守方 Q ${conditions.defenderQUnavailable ? '冷却中' : '可用'}`,
  ]
  if (zone !== 'outside') facts.push(zone === 'inner' ? '位于小禁区' : '位于大禁区')
  if (pass) facts.push(`最近传球 ${passDistance.toFixed(2)} 格`)

  return { attackerId, defenderId, base, final, appliedModifiers, facts }
}

function passWarnings(document: TacticDocumentV1, action: PassAction): RuleWarning[] {
  const rules = document.rulesSnapshot
  const length = pathLength(action.path)
  const startFrame = projectFrame(document, action.startTime)
  const actor = startFrame.players.find((player) => player.id === action.actorId)
  const segments = actor
    ? classifyPassThreat(action.path, actor.team, startFrame, rules)
    : []
  const highest = highestPassThreat(segments)
  if (length > rules.passing.maxDistance) {
    return [
      {
        id: `pass-too-long-${action.id}`,
        severity: 'hard',
        title: '传球超出有效距离',
        detail: `${length.toFixed(2)} 格 > ${rules.passing.maxDistance} 格，线路包含“${PASS_THREAT_LABELS[highest]}”，球会在最大距离处落为自由球。`,
        actionId: action.id,
        playerIds: [action.actorId],
      },
    ]
  }
  if (length <= rules.passing.safeDistance) {
    return [
      {
        id: `pass-safe-${action.id}`,
        severity: 'info',
        title: '安全距离传球',
        detail: `${length.toFixed(2)} 格 ≤ ${rules.passing.safeDistance} 格，按当前规则不会被截断。`,
        actionId: action.id,
      },
    ]
  }

  const direct = segments.some((segment) => segment.level === 'direct')
  const qReachable = highest === 'qSingle' || highest === 'qMultiple'
  const interceptorIds = [...new Set(segments.flatMap((segment) => segment.opponentIds))]
  const interceptors = startFrame.players.filter((player) => interceptorIds.includes(player.id))
  const highestLabel = PASS_THREAT_LABELS[highest]

  return [
    {
      id: `pass-risk-${action.id}`,
      severity: 'warning',
      title: direct
        ? '对手位于传球截断走廊'
        : highest === 'qMultiple'
          ? '多名对手可用 Q 触达传球线路'
          : qReachable
            ? '一名对手可用 Q 触达传球线路'
            : '传球进入截断区',
      detail: interceptors.length > 0
        ? `${length.toFixed(2)} 格传球，最高威胁为“${highestLabel}”；涉及 ${interceptors.map((player) => player.name).join('、')}。`
        : `${length.toFixed(2)} 格位于 ${rules.passing.safeDistance}–${rules.passing.maxDistance} 格普通截断区。`,
      actionId: action.id,
      playerIds: interceptors.map((player) => player.id),
    },
  ]
}

function shotWarnings(document: TacticDocumentV1, action: ShootAction): RuleWarning[] {
  const rules = document.rulesSnapshot
  const frame = projectFrame(document, action.startTime)
  const shooter = frame.players.find((player) => player.id === action.actorId)
  if (!shooter) return []
  const zone = getShootZone(
    shooter.position,
    shooter.team,
    rules.field.width,
    rules.field.height,
    rules.field.smallPenaltyRadius,
    rules.field.largePenaltyRadius,
  )
  if (zone === 'outside') {
    return [
      {
        id: `shoot-outside-${action.id}`,
        severity: 'hard',
        title: '当前位置无法蓄力射门',
        detail: `射门者位于大禁区外（半径 ${rules.field.largePenaltyRadius} 格）。`,
        actionId: action.id,
        playerIds: [shooter.id],
      },
    ]
  }
  const endFrame = projectFrame(document, actionEndTime(action))
  const shot = endFrame.shots.find((candidate) => candidate.actionId === action.id)
  const results: RuleWarning[] = []
  if (shot?.interrupted) {
    results.push({
      id: `shoot-interrupted-${action.id}`,
      severity: 'hard',
      title: '蓄力被有效攻击打断',
      detail: `${action.charge === 'yellow' ? '黄蓄' : '红蓄'}需要 ${action.duration.toFixed(2)} 秒，期间存在命中攻击。`,
      actionId: action.id,
      playerIds: [shooter.id],
    })
  } else {
    results.push({
      id: `shoot-charge-${action.id}`,
      severity: 'info',
      title: `${zone === 'inner' ? '小禁区' : '大禁区'}${action.charge === 'yellow' ? '黄蓄' : '红蓄'}`,
      detail: `按当前规则需要 ${action.duration.toFixed(2)} 秒完成蓄力。`,
      actionId: action.id,
      playerIds: [shooter.id],
    })
  }

  const pressure = evaluateShotActionPressure(document, action)
  const earliest = pressure?.earliest
  if (!pressure || !earliest) return results
  results.push({
    id: `shoot-pressure-${action.id}`,
    severity: pressure.isRisk ? 'warning' : 'info',
    title: pressure.isRisk ? '最早受击不晚于蓄力完成' : '蓄力领先最早受击',
    detail: `${shotPressureSummary(pressure)}；${shotPressureComparison(pressure)}。双方距离 ${earliest.gap.toFixed(2)} 格，${earliest.defender.name} 需进入 ${earliest.attackInnerRadius.toFixed(2)}–${earliest.attackOuterRadius.toFixed(2)} 格攻击环，采用${shotPressureModeLabel(earliest.mode)}${earliest.frozenDelay > 0 ? `，先等待冻结 ${earliest.frozenDelay.toFixed(2)} 秒` : ''}${earliest.mode === 'q' ? `，起始 Q CD ${earliest.qCooldownAtStart.toFixed(2)} 秒、Q 用时 ${earliest.qDuration.toFixed(2)} 秒` : ''}。`,
    actionId: action.id,
    playerIds: [shooter.id, earliest.defender.id],
  })

  const mirrorPressure = pressure.defenders.find((candidate) =>
    action.charge === 'yellow' &&
    shooter.role === 'water' &&
    candidate.defender.role === 'water' &&
    (frame.cooldowns[shooter.id]?.q ?? 0) <= 0 &&
    (frame.cooldowns[candidate.defender.id]?.q ?? 0) <= 0 &&
    candidate.gap <= candidate.attackOuterRadius + candidate.qMaxDistance,
  )
  if (mirrorPressure) {
    const defender = mirrorPressure.defender
    const matchup = evaluateMatchup(document, action.startTime, shooter.id, defender.id)
    results.push({
      id: `water-mirror-yellow-${action.id}`,
      severity: 'warning',
      title: '水防水黄蓄力对位提示',
      detail: `双方 Q 均可用，距离 ${mirrorPressure.gap.toFixed(2)} 格；配置的进攻方对位等级为${ratingText(matchup?.final ?? null)}。此提示不使用反应时间参数。`,
      actionId: action.id,
      playerIds: [shooter.id, defender.id],
    })
  }
  return results
}

function ratingText(rating: MatchupRating): string {
  if (rating === null) return '未评估'
  return ({ [-2]: '极不利', [-1]: '不利', 0: '均势', 1: '有利', 2: '极有利' } as const)[rating]
}

export function evaluateWarnings(document: TacticDocumentV1): RuleWarning[] {
  const warnings: RuleWarning[] = []
  const qByPlayer = new Map<string, Array<Extract<(typeof document.actions)[number], { type: 'qMove' }>>>()
  const eByPlayer = new Map<string, Array<Extract<(typeof document.actions)[number], { type: 'eZone' }>>>()

  for (const action of document.actions) {
    if (action.type === 'pass') warnings.push(...passWarnings(document, action))
    if (action.type === 'shoot') warnings.push(...shotWarnings(document, action))
    if (action.type === 'qMove') {
      const list = qByPlayer.get(action.actorId) ?? []
      list.push(action)
      qByPlayer.set(action.actorId, list)
      const actor = document.initialScene.players.find((player) => player.id === action.actorId)
      if (actor) {
        const maxDistance = document.rulesSnapshot.roles[actor.role].q.maxDistance
        const length = pathLength(action.path)
        if (length > maxDistance + 1e-6) {
          warnings.push({
            id: `q-too-long-${action.id}`,
            severity: 'hard',
            title: `${actor.name} 的 Q 路径超出上限`,
            detail: `${length.toFixed(2)} 格 > ${maxDistance} 格；请缩短路径或调整规则参数。`,
            actionId: action.id,
            playerIds: [actor.id],
          })
        }
        if (actor.role === 'ice' && analyzeDocumentIceQHits(document, action).length === 0) {
          warnings.push({
            id: `ice-q-miss-${action.id}`,
            severity: 'hard',
            title: '冰 Q 路径未命中对手',
            detail: `完整冲刺路径未进入任何对手周围 ${document.rulesSnapshot.roles.ice.attackRadius} 格，当前不会施加冻结或面向后退。`,
            actionId: action.id,
            playerIds: [actor.id, ...(action.targetId ? [action.targetId] : [])],
          })
        }
      }
    }
    if (action.type === 'eZone') {
      const list = eByPlayer.get(action.actorId) ?? []
      list.push(action)
      eByPlayer.set(action.actorId, list)
    }
  }

  for (const [playerId, actions] of qByPlayer) {
    const player = document.initialScene.players.find((candidate) => candidate.id === playerId)
    if (!player) continue
    const cooldown = document.rulesSnapshot.roles[player.role].q.cooldown
    actions.sort((a, b) => a.startTime - b.startTime)
    for (const conflict of qCooldownSequenceConflicts(document, playerId)) {
      warnings.push({
        id: `q-cd-${conflict.later.id}`,
        severity: 'hard',
        title: `${player.name} 的 Q 尚未冷却`,
        detail: `还差 ${cooldownRemainingText(conflict.remaining)} 秒，当前 Q CD 为 ${conflict.requiredGap} 秒。`,
        actionId: conflict.later.id,
        playerIds: [player.id],
      })
    }

    for (const action of actions) {
      const opponents = document.initialScene.players.filter((candidate) => candidate.team !== player.team)
      const faster = opponents
        .map((candidate) => ({ player: candidate, cooldown: document.rulesSnapshot.roles[candidate.role].q.cooldown }))
        .filter((candidate) => candidate.cooldown < cooldown)
        .sort((a, b) => a.cooldown - b.cooldown)[0]
      if (faster) {
        warnings.push({
          id: `q-window-${action.id}`,
          severity: 'info',
          title: '存在 Q 冷却差窗口',
          detail: `${player.name} 的 Q 为 ${cooldown} 秒，${faster.player.name} 为 ${faster.cooldown} 秒，可围绕 ${(cooldown - faster.cooldown).toFixed(1)} 秒差组织下一轮。`,
          actionId: action.id,
          playerIds: [player.id, faster.player.id],
        })
      }
    }
  }

  for (const [playerId, actions] of eByPlayer) {
    const player = document.initialScene.players.find((candidate) => candidate.id === playerId)
    const cooldown = player ? document.rulesSnapshot.roles[player.role].e?.cooldown : undefined
    if (!player || !cooldown) continue
    actions.sort((a, b) => a.startTime - b.startTime)
    for (let index = 1; index < actions.length; index += 1) {
      const previous = actions[index - 1]
      const current = actions[index]
      if (previous && current && current.startTime < previous.startTime + cooldown) {
        warnings.push({
          id: `e-cd-${current.id}`,
          severity: 'hard',
          title: `${player.name} 的 E 尚未冷却`,
          detail: `还差 ${(previous.startTime + cooldown - current.startTime).toFixed(2)} 秒。`,
          actionId: current.id,
          playerIds: [player.id],
        })
      }
    }
  }

  for (const qAction of document.actions.filter((action) => action.type === 'qMove')) {
    const actor = document.initialScene.players.find((player) => player.id === qAction.actorId)
    if (!actor || actor.role !== 'ice') continue
    const hits = analyzeDocumentIceQHits(document, qAction)
    const knockback = document.rulesSnapshot.roles.ice.q.facingKnockback ?? 0
    for (const hit of hits) {
      const freezeStart = hit.hitTime
      const freezeEnd = freezeStart + (document.rulesSnapshot.roles.ice.q.freezeDuration ?? 0)
      const conflict = document.actions.find(
        (action) =>
          (action.type === 'move' || action.type === 'qMove') &&
          action.actorId === hit.targetId &&
          action.startTime < freezeEnd &&
          actionEndTime(action) > freezeStart,
      )
      if (conflict) {
        warnings.push({
          id: `freeze-conflict-${qAction.id}-${hit.targetId}-${conflict.id}`,
          severity: 'hard',
          title: '冻结与移动动作冲突',
          detail: `${hit.target.name} 在 ${freezeStart.toFixed(2)} 秒被命中并冻结至 ${freezeEnd.toFixed(2)} 秒，重叠移动会在命中时中断。`,
          actionId: conflict.id,
          playerIds: [hit.targetId],
        })
      }

      if (knockback <= 0) continue
      const after = clampPoint(
        oppositeFacingOffset(hit.target.position, hit.target.facing, knockback),
        document.rulesSnapshot.field.width,
        document.rulesSnapshot.field.height,
      )
      if (distance(after, hit.closestPoint) <= distance(hit.target.position, hit.closestPoint)) {
        warnings.push({
          id: `ice-facing-${qAction.id}-${hit.targetId}`,
          severity: 'warning',
          title: '冻结面向不利于拉开身位',
          detail: `${hit.target.name} 会沿当前面向反向后退 ${knockback} 格，但该方向没有扩大与命中点的距离。`,
          actionId: qAction.id,
          playerIds: [qAction.actorId, hit.targetId],
        })
      }
    }
  }


  const locomotion = document.actions.filter(
    (action): action is Extract<(typeof document.actions)[number], { type: 'move' | 'qMove' }> =>
      action.type === 'move' || action.type === 'qMove',
  )
  for (let left = 0; left < locomotion.length; left += 1) {
    const first = locomotion[left]
    if (!first) continue
    for (let right = left + 1; right < locomotion.length; right += 1) {
      const second = locomotion[right]
      if (!second || first.actorId !== second.actorId) continue
      const overlaps = first.startTime < actionEndTime(second) && second.startTime < actionEndTime(first)
      if (!overlaps) continue
      warnings.push({
        id: `movement-overlap-${first.id}-${second.id}`,
        severity: 'hard',
        title: '同一球员的位移动作重叠',
        detail: '时间投影会采用较晚开始的动作，请调整开始时间或持续时间。',
        actionId: second.id,
        playerIds: [first.actorId],
      })
    }
  }

  for (const zone of document.actions.filter((action) => action.type === 'eZone')) {
    const owner = document.initialScene.players.find((player) => player.id === zone.actorId)
    const eRule = owner ? document.rulesSnapshot.roles[owner.role].e : undefined
    if (!owner || !eRule) continue
    for (const move of document.actions.filter((action) => action.type === 'move')) {
      const runner = document.initialScene.players.find((player) => player.id === move.actorId)
      if (!runner || runner.team === owner.team || !doesEZoneSlowMove(document, zone, move)) continue
      warnings.push({
        id: `slow-chase-${zone.id}-${move.id}`,
        severity: 'warning',
        title: '跑动进入随身冰圈',
        detail: `${runner.name} 在跑动中进入以 ${owner.name} 为圆心、半径 ${zone.radius} 格的移动冰圈；圈内移速按 ${eRule.slowMultiplier}× 计算。`,
        actionId: move.id,
        playerIds: [runner.id, owner.id],
      })
    }
  }

  for (const qAction of document.actions.filter((action) => action.type === 'qMove')) {
    const actor = document.initialScene.players.find((player) => player.id === qAction.actorId)
    if (!actor) continue
    const effect = evaluateQDistanceEffect(document, qAction)
    if (effect.reduction <= 0.005) continue
    const enemyZoneOwners = document.actions
      .filter((action) => action.type === 'eZone')
      .map((zone) => document.initialScene.players.find((player) => player.id === zone.actorId))
      .filter((owner): owner is NonNullable<typeof owner> => Boolean(owner && owner.team !== actor.team))
    warnings.push({
      id: `q-slowed-by-e-${qAction.id}`,
      severity: 'warning',
      title: 'Q 经过敌方随身冰圈',
      detail: `${actor.name} 的 Q 原路径 ${effect.authoredDistance.toFixed(2)} 格，圈内经过部分按冰圈规则折算后实际位移为 ${effect.effectiveDistance.toFixed(2)} 格。`,
      actionId: qAction.id,
      playerIds: [actor.id, ...enemyZoneOwners.map((owner) => owner.id)],
    })
  }

  return warnings.sort((a, b) => {
    const order = { hard: 0, warning: 1, info: 2 }
    return order[a.severity] - order[b.severity]
  })
}
