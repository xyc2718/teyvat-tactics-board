import {
  clamp,
  clampPoint,
  distance,
  getShootZone,
  oppositeFacingOffset,
  pathLength,
  pointAlongPath,
  resolvedMovePath,
  truncatePath,
} from '../geometry/geometry'
import type {
  EZoneAction,
  MoveAction,
  PassAction,
  PlayerState,
  PlayerStatus,
  ProjectedFrame,
  QMoveAction,
  ShootAction,
  TacticAction,
  TacticDocumentV1,
} from '../model/types'
import { analyzeIceQHits, type IceQHit } from '../rules/iceQHits'
import { actionEndTime } from './durations'
import { waterQGainAtTime, waterQMoveBoost } from './movementEffects'

type IceQHitMap = Map<string, IceQHit[]>

const E_ZONE_SAMPLE_SECONDS = 0.05
const E_ZONE_SAMPLE_DISTANCE = 0.05

type EZoneEffect = 'move' | 'qMove'

function clonePlayers(players: PlayerState[]): PlayerState[] {
  return players.map((player) => ({ ...player, position: { ...player.position } }))
}

function getActorRole(document: TacticDocumentV1, actorId: string) {
  return document.initialScene.players.find((player) => player.id === actorId)?.role
}

function receiveBoostWindowFor(document: TacticDocumentV1, playerId: string, time: number) {
  const role = getActorRole(document, playerId)
  const boost = role ? document.rulesSnapshot.roles[role].receiveBoost : undefined
  if (!boost || boost.duration <= 0) return undefined
  const source = [...document.actions]
    .filter(
      (candidate): candidate is PassAction =>
        candidate.type === 'pass' &&
        candidate.targetPlayerId === playerId &&
        pathLength(candidate.path) <= document.rulesSnapshot.passing.maxDistance &&
        actionEndTime(candidate) <= time &&
        actionEndTime(candidate) + boost.duration > time,
    )
    .sort((a, b) => actionEndTime(b) - actionEndTime(a))[0]
  return source ? { start: actionEndTime(source), end: actionEndTime(source) + boost.duration, boost } : undefined
}

function movementBoostWindowFor(
  document: TacticDocumentV1,
  playerId: string,
  actionStart: number,
  time: number,
) {
  const receiverRole = getActorRole(document, playerId)
  const ownBoost = receiverRole ? document.rulesSnapshot.roles[receiverRole].receiveBoost : undefined
  for (const source of [...document.actions]
    .filter(
      (candidate): candidate is PassAction =>
        candidate.type === 'pass' &&
        candidate.targetPlayerId === playerId &&
        pathLength(candidate.path) <= document.rulesSnapshot.passing.maxDistance &&
        actionEndTime(candidate) <= time,
    )
    .sort((a, b) => actionEndTime(b) - actionEndTime(a))) {
    let boost = ownBoost
    if (!boost) {
      const passerRole = getActorRole(document, source.actorId)
      const passerBoost = passerRole ? document.rulesSnapshot.roles[passerRole].receiveBoost : undefined
      if (passerBoost?.transfersOnPass && receiveBoostWindowFor(document, source.actorId, source.startTime)) {
        boost = passerBoost
      }
    }
    if (boost && boost.duration > 0 && actionEndTime(source) + boost.duration > actionStart) {
      return { start: actionEndTime(source), end: actionEndTime(source) + boost.duration, boost }
    }
  }
  return undefined
}

function freezeWindowsFor(document: TacticDocumentV1, actorId: string, hitMap: IceQHitMap): Array<{ start: number; end: number }> {
  return [...hitMap.entries()].flatMap(([actionId, hits]) => {
    const candidate = document.actions.find(
      (action): action is QMoveAction => action.id === actionId && action.type === 'qMove',
    )
    if (!candidate) return []
    const role = getActorRole(document, candidate.actorId)
    const freeze = role ? document.rulesSnapshot.roles[role].q.freezeDuration : undefined
    if (!freeze) return []
    return hits
      .filter((hit) => hit.targetId === actorId)
      .map((hit) => ({ start: hit.hitTime, end: hit.hitTime + freeze }))
  }).sort((left, right) => left.start - right.start)
}

function moveDistanceWithoutEZoneSlow(
  document: TacticDocumentV1,
  action: MoveAction,
  time: number,
): number {
  const routeLength = pathLength(resolvedMovePath(action))
  const effectiveTime = Math.min(Math.max(time, action.startTime), actionEndTime(action))
  let traveled = clamp((effectiveTime - action.startTime) / Math.max(action.duration, 0.0001), 0, 1) * routeLength

  const role = getActorRole(document, action.actorId)
  const boostRule = role ? document.rulesSnapshot.roles[role].afterQBoost : undefined
  if (boostRule) {
    traveled += waterQGainAtTime(waterQMoveBoost(document, action), boostRule.duration, effectiveTime)
  }

  const receiveWindow = movementBoostWindowFor(document, action.actorId, action.startTime, effectiveTime)
  if (receiveWindow) {
    const elapsed = Math.max(
      0,
      Math.min(effectiveTime, receiveWindow.end) - Math.max(action.startTime, receiveWindow.start),
    )
    traveled += (elapsed / receiveWindow.boost.duration) * receiveWindow.boost.netSeparationGain
  }
  return traveled
}

function eZoneMultiplierAt(
  document: TacticDocumentV1,
  movingActor: PlayerState,
  position: PlayerState['position'],
  time: number,
  effect: EZoneEffect,
  applyControlEffects: boolean,
  hitMap: IceQHitMap,
): number {
  const activeZones = document.actions.filter(
    (candidate): candidate is EZoneAction =>
      candidate.type === 'eZone' &&
      candidate.startTime <= time &&
      actionEndTime(candidate) > time,
  )
  if (activeZones.length === 0) return 1

  // Resolve moving zone centers without E effects to avoid recursive zone-to-zone projection.
  const centerFrame = projectSceneCore(document, time, false, applyControlEffects, hitMap, false)
  let multiplier = 1
  for (const zone of activeZones) {
    const owner = centerFrame.players.find((player) => player.id === zone.actorId)
    if (!owner || owner.team === movingActor.team) continue
    const eRule = document.rulesSnapshot.roles[owner.role].e
    const configured = effect === 'move' ? eRule?.slowMultiplier : eRule?.qDistanceMultiplier
    if (configured === undefined || distance(position, owner.position) > zone.radius) continue
    multiplier = Math.min(multiplier, configured)
  }
  return multiplier
}

function moveDistanceWithEZoneSlow(
  document: TacticDocumentV1,
  action: MoveAction,
  time: number,
  applyControlEffects: boolean,
  hitMap: IceQHitMap,
): number {
  const movingActor = document.initialScene.players.find((player) => player.id === action.actorId)
  const route = resolvedMovePath(action)
  const routeLength = pathLength(route)
  const end = Math.min(Math.max(time, action.startTime), actionEndTime(action))
  if (!movingActor || routeLength <= 0 || end <= action.startTime) return 0

  const hasOverlappingEnemyZone = document.actions.some((candidate) => {
    if (candidate.type !== 'eZone') return false
    const owner = document.initialScene.players.find((player) => player.id === candidate.actorId)
    return owner?.team !== movingActor.team && candidate.startTime < end && actionEndTime(candidate) > action.startTime
  })
  if (!hasOverlappingEnemyZone) return moveDistanceWithoutEZoneSlow(document, action, end)

  const steps = Math.max(1, Math.ceil((end - action.startTime) / E_ZONE_SAMPLE_SECONDS))
  let traveled = 0
  for (let index = 0; index < steps; index += 1) {
    const stepStart = action.startTime + ((end - action.startTime) * index) / steps
    const stepEnd = action.startTime + ((end - action.startTime) * (index + 1)) / steps
    const unslowedStep = Math.max(
      0,
      moveDistanceWithoutEZoneSlow(document, action, stepEnd) -
        moveDistanceWithoutEZoneSlow(document, action, stepStart),
    )
    const probeDistance = Math.min(routeLength, traveled + unslowedStep / 2)
    const probePosition = pointAlongPath(route, probeDistance / Math.max(routeLength, 0.0001))
    const probeTime = (stepStart + stepEnd) / 2
    traveled += unslowedStep * eZoneMultiplierAt(
      document,
      movingActor,
      probePosition,
      probeTime,
      'move',
      applyControlEffects,
      hitMap,
    )
  }
  return traveled
}

function qDistanceWithEZoneEffect(
  document: TacticDocumentV1,
  action: QMoveAction,
  time: number,
  applyControlEffects: boolean,
  hitMap: IceQHitMap,
): number {
  const movingActor = document.initialScene.players.find((player) => player.id === action.actorId)
  const routeLength = pathLength(action.path)
  if (!movingActor || routeLength <= 0 || time < action.startTime) return 0

  const qRule = document.rulesSnapshot.roles[movingActor.role].q
  const baseProgress = qRule.kind === 'dash' && action.duration > 0
    ? clamp((time - action.startTime) / action.duration, 0, 1)
    : 1
  const authoredDistance = routeLength * baseProgress
  const steps = Math.max(1, Math.ceil(authoredDistance / E_ZONE_SAMPLE_DISTANCE))
  // The Q's own hit cannot move its slowing zone early enough to redefine the
  // same Q path. Earlier control effects still move the live zone center.
  const priorHitMap = hitMap.has(action.id)
    ? new Map([...hitMap].filter(([actionId]) => actionId !== action.id))
    : hitMap
  let traveled = 0

  for (let index = 0; index < steps; index += 1) {
    const stepStart = (authoredDistance * index) / steps
    const stepEnd = (authoredDistance * (index + 1)) / steps
    const probeDistance = (stepStart + stepEnd) / 2
    const pathProgress = probeDistance / routeLength
    const probePosition = pointAlongPath(action.path, pathProgress)
    const probeTime = qRule.kind === 'dash' && action.duration > 0
      ? action.startTime + action.duration * pathProgress
      : action.startTime
    traveled += (stepEnd - stepStart) * eZoneMultiplierAt(
      document,
      movingActor,
      probePosition,
      probeTime,
      'qMove',
      applyControlEffects,
      priorHitMap,
    )
  }
  return traveled
}

function effectiveQPathWithHitMap(
  document: TacticDocumentV1,
  action: QMoveAction,
  hitMap: IceQHitMap,
): PlayerState['position'][] {
  return truncatePath(
    action.path,
    qDistanceWithEZoneEffect(document, action, actionEndTime(action), true, hitMap),
  )
}

function movementProgress(
  document: TacticDocumentV1,
  action: Extract<TacticAction, { type: 'move' | 'qMove' }>,
  time: number,
  applyControlEffects: boolean,
  hitMap: IceQHitMap,
  applyEZoneEffects = true,
): number {
  if (action.duration <= 0 && action.type !== 'qMove') return time >= action.startTime ? 1 : 0
  let effectiveTime = time
  const freeze = applyControlEffects
    ? freezeWindowsFor(document, action.actorId, hitMap).find(
        (window) => window.start < actionEndTime(action) && window.end > action.startTime,
      )
    : undefined
  if (freeze) effectiveTime = Math.min(effectiveTime, freeze.start)

  if (action.type === 'qMove') {
    const role = getActorRole(document, action.actorId)
    const q = role ? document.rulesSnapshot.roles[role].q : undefined
    const baseProgress = q?.kind === 'dash' && action.duration > 0
      ? clamp((effectiveTime - action.startTime) / action.duration, 0, 1)
      : effectiveTime >= action.startTime ? 1 : 0
    if (applyControlEffects && applyEZoneEffects) {
      return clamp(
        qDistanceWithEZoneEffect(document, action, effectiveTime, applyControlEffects, hitMap) /
          Math.max(pathLength(action.path), 0.0001),
        0,
        1,
      )
    }
    if (q?.kind === 'dash') {
      return baseProgress
    }
    return baseProgress
  }

  const routeLength = pathLength(resolvedMovePath(action))
  const traveled = applyControlEffects && applyEZoneEffects
    ? moveDistanceWithEZoneSlow(document, action, effectiveTime, applyControlEffects, hitMap)
    : moveDistanceWithoutEZoneSlow(document, action, effectiveTime)

  return clamp(traveled / Math.max(routeLength, 0.0001), 0, 1)
}

function addStatus(statuses: PlayerStatus[], status: PlayerStatus) {
  if (!statuses.some((candidate) => candidate.id === status.id)) statuses.push(status)
}

function isShotInterrupted(
  document: TacticDocumentV1,
  shot: ShootAction,
  hitMap: IceQHitMap,
): boolean {
  if (!document.rulesSnapshot.shooting.interruptedByAttack) return false
  return document.actions.some((action) => {
    if (action.type !== 'attack' || action.targetId !== shot.actorId) return false
    if (action.startTime < shot.startTime || action.startTime >= actionEndTime(shot)) return false
    const frame = projectSceneCore(document, action.startTime, false, true, hitMap)
    const attacker = frame.players.find((player) => player.id === action.actorId)
    const target = frame.players.find((player) => player.id === action.targetId)
    if (!attacker || !target) return false
    const rule = document.rulesSnapshot.roles[attacker.role]
    const gap = distance(attacker.position, target.position)
    return gap >= (rule.attackInnerRadius ?? 0) && gap <= rule.attackRadius
  })
}

function projectSceneCore(
  document: TacticDocumentV1,
  rawTime: number,
  includeShots: boolean,
  applyControlEffects = true,
  hitMap: IceQHitMap = new Map(),
  applyEZoneEffects = true,
): ProjectedFrame {
  const time = Math.max(0, rawTime)
  const rules = document.rulesSnapshot
  const players = clonePlayers(document.initialScene.players)
  const ball = { ...document.initialScene.ball, position: { ...document.initialScene.ball.position } }
  const statuses = document.initialScene.statuses.map((status) => ({ ...status }))
  const cooldowns = Object.fromEntries(players.map((player) => [player.id, { q: 0, e: 0 }]))
  const shots: ProjectedFrame['shots'] = []

  const ordered = [...document.actions].sort((a, b) => {
    const timeOrder = a.startTime - b.startTime
    if (timeOrder !== 0) return timeOrder
    const isInstantQ = (action: TacticAction) => {
      if (action.type !== 'qMove') return false
      const role = getActorRole(document, action.actorId)
      return role ? rules.roles[role].q.kind === 'blink' : false
    }
    return Number(isInstantQ(b)) - Number(isInstantQ(a))
  })

  for (const action of ordered) {
    if (action.startTime > time) continue
    const actor = 'actorId' in action
      ? players.find((player) => player.id === action.actorId)
      : undefined

    if (action.type === 'move' || action.type === 'qMove') {
      if (!actor || action.path.length < 2) continue
      const route = action.type === 'move' ? resolvedMovePath(action) : action.path
      actor.position = clampPoint(
        pointAlongPath(route, movementProgress(document, action, time, applyControlEffects, hitMap, applyEZoneEffects)),
        rules.field.width,
        rules.field.height,
      )
      if (action.type === 'qMove') {
        const roleRule = rules.roles[actor.role]
        const remaining = roleRule.q.cooldown - (time - action.startTime)
        const cd = cooldowns[actor.id]
        if (cd) cd.q = Math.max(cd.q, remaining, 0)
        if (roleRule.afterQBoost && time < actionEndTime(action) + roleRule.afterQBoost.duration) {
          addStatus(statuses, {
            id: `${action.id}-boost`,
            playerId: actor.id,
            kind: 'boosted',
            sourceActionId: action.id,
            startsAt: actionEndTime(action),
            endsAt: actionEndTime(action) + roleRule.afterQBoost.duration,
            separationDelta: roleRule.afterQBoost.netSeparationGain,
          })
        }
      }
      continue
    }

    if (action.type === 'pass') {
      if (!actor || action.path.length < 2) continue
      const length = pathLength(action.path)
      const effectiveProgress = clamp((time - action.startTime) / Math.max(action.duration, 0.001), 0, 1)
      const maxProgress = Math.min(1, rules.passing.maxDistance / Math.max(length, 0.001))
      const progress = Math.min(effectiveProgress, maxProgress)
      ball.carrierId = null
      ball.isFree = true
      ball.position = pointAlongPath(action.path, progress)
      for (const player of players) player.hasBall = false

      if (time >= actionEndTime(action) && length <= rules.passing.maxDistance && action.targetPlayerId) {
        const receiver = players.find((player) => player.id === action.targetPlayerId)
        if (receiver) {
          receiver.hasBall = true
          ball.carrierId = receiver.id
          ball.isFree = false
          ball.position = { ...receiver.position }
          const passerRule = rules.roles[actor.role]
          const receiverRule = rules.roles[receiver.role]
          const transferWindow = passerRule.receiveBoost?.transfersOnPass
            ? receiveBoostWindowFor(document, actor.id, action.startTime)
            : undefined
          const transfer = transferWindow?.boost
          const boost = transfer ?? receiverRule.receiveBoost
          if (boost && time < actionEndTime(action) + boost.duration) {
            addStatus(statuses, {
              id: `${action.id}-receive-boost`,
              playerId: receiver.id,
              kind: 'boosted',
              sourceActionId: action.id,
              startsAt: actionEndTime(action),
              endsAt: actionEndTime(action) + boost.duration,
              separationDelta: boost.netSeparationGain,
            })
          }
        }
      }
      continue
    }

    if (action.type === 'receive' && actor && time >= action.startTime) {
      for (const player of players) player.hasBall = player.id === actor.id
      ball.carrierId = actor.id
      ball.isFree = false
      ball.position = { ...actor.position }
      continue
    }

    if (action.type === 'possession') {
      for (const player of players) player.hasBall = false
      ball.carrierId = null
      ball.isFree = true
      ball.position = { ...action.position }
      continue
    }

    if (action.type === 'eZone' && actor) {
      const eRule = rules.roles[actor.role].e
      const cd = cooldowns[actor.id]
      if (eRule && cd) cd.e = Math.max(cd.e, eRule.cooldown - (time - action.startTime), 0)
      continue
    }

    if (action.type === 'status' && time <= actionEndTime(action)) {
      addStatus(statuses, {
        id: `${action.id}-status`,
        playerId: action.targetId,
        kind: action.status,
        sourceActionId: action.id,
        startsAt: action.startTime,
        endsAt: actionEndTime(action),
        separationDelta: action.separationDelta,
      })
      continue
    }

    if (action.type === 'shoot' && actor && includeShots) {
      const interrupted = isShotInterrupted(document, action, hitMap)
      const progress = clamp((time - action.startTime) / Math.max(action.duration, 0.001), 0, 1)
      const zone = getShootZone(
        projectSceneCore(document, action.startTime, false, true, hitMap).players.find((player) => player.id === actor.id)?.position ?? actor.position,
        actor.team,
        rules.field.width,
        rules.field.height,
        rules.field.smallPenaltyRadius,
        rules.field.largePenaltyRadius,
      )
      const completed = time >= actionEndTime(action) && !interrupted && zone !== 'outside'
      shots.push({ actionId: action.id, actorId: actor.id, progress, interrupted, completed })
      if (completed && action.path.length >= 2) {
        ball.carrierId = null
        ball.isFree = true
        ball.position = { ...(action.path[action.path.length - 1] ?? actor.position) }
        actor.hasBall = false
      }
    }
  }

  if (applyControlEffects) for (const qAction of ordered.filter((action): action is QMoveAction => action.type === 'qMove')) {
    const roleRule = rules.roles.ice.q
    if (!roleRule.freezeDuration) continue
    for (const hit of hitMap.get(qAction.id) ?? []) {
      const target = players.find((player) => player.id === hit.targetId)
      if (!target || time < hit.hitTime) continue
      const resumedAfterFreeze = ordered.some(
        (action) =>
          (action.type === 'move' || action.type === 'qMove') &&
          action.actorId === target.id &&
          action.startTime >= hit.hitTime + roleRule.freezeDuration! &&
          action.startTime <= time,
      )
      if (!resumedAfterFreeze) {
        target.position = clampPoint(
          oppositeFacingOffset(target.position, target.facing, roleRule.facingKnockback ?? 0),
          rules.field.width,
          rules.field.height,
        )
      }
      if (time < hit.hitTime + roleRule.freezeDuration) {
        addStatus(statuses, {
          id: `${qAction.id}-${target.id}-freeze`,
          playerId: target.id,
          kind: 'frozen',
          sourceActionId: qAction.id,
          startsAt: hit.hitTime,
          endsAt: hit.hitTime + roleRule.freezeDuration,
        })
      }
    }
  }

  if (applyControlEffects) for (const zone of ordered.filter((action): action is EZoneAction => action.type === 'eZone')) {
    if (time < zone.startTime || time >= actionEndTime(zone)) continue
    const owner = players.find((player) => player.id === zone.actorId)
    const eRule = owner ? rules.roles[owner.role].e : undefined
    if (!owner || !eRule) continue
    for (const target of players.filter((player) => player.team !== owner.team)) {
      if (distance(target.position, owner.position) > zone.radius) continue
      addStatus(statuses, {
        id: `${zone.id}-${target.id}-slow`,
        playerId: target.id,
        kind: 'slowed',
        sourceActionId: zone.id,
        startsAt: zone.startTime,
        endsAt: actionEndTime(zone),
      })
    }
  }

  const activeStatuses = statuses.filter((status) => status.startsAt <= time && status.endsAt > time)
  const carrier = ball.carrierId
    ? players.find((player) => player.id === ball.carrierId)
    : undefined
  for (const player of players) player.hasBall = player.id === carrier?.id
  if (carrier) {
    ball.position = { ...carrier.position }
    ball.isFree = false
  } else {
    ball.carrierId = null
    ball.isFree = true
  }

  return { players, ball, statuses: activeStatuses, time, cooldowns, shots }
}

function buildIceQHitMap(document: TacticDocumentV1): IceQHitMap {
  const hitMap: IceQHitMap = new Map()
  const actions = [...document.actions]
    .filter((action): action is QMoveAction => action.type === 'qMove')
    .sort((left, right) => left.startTime - right.startTime)
  for (const action of actions) {
    if (getActorRole(document, action.actorId) !== 'ice') continue
    // Project with only already-known earlier hits. The pure analyzer never calls projection.
    const startFrame = projectSceneCore(document, action.startTime, false, true, hitMap)
    const actor = startFrame.players.find((player) => player.id === action.actorId)
    if (!actor) continue
    const effectiveAction = { ...action, path: effectiveQPathWithHitMap(document, action, hitMap) }
    hitMap.set(action.id, analyzeIceQHits(effectiveAction, actor, startFrame.players, document.rulesSnapshot))
  }
  return hitMap
}

export interface QDistanceEffect {
  authoredDistance: number
  effectiveDistance: number
  reduction: number
}

export function evaluateQDistanceEffect(document: TacticDocumentV1, action: QMoveAction): QDistanceEffect {
  const authoredDistance = pathLength(action.path)
  const effectiveDistance = qDistanceWithEZoneEffect(
    document,
    action,
    actionEndTime(action),
    true,
    buildIceQHitMap(document),
  )
  return {
    authoredDistance,
    effectiveDistance,
    reduction: Math.max(0, authoredDistance - effectiveDistance),
  }
}

export function effectiveQPath(document: TacticDocumentV1, action: QMoveAction): PlayerState['position'][] {
  return truncatePath(action.path, evaluateQDistanceEffect(document, action).effectiveDistance)
}

export function analyzeDocumentIceQHits(document: TacticDocumentV1, action: QMoveAction): IceQHit[] {
  return buildIceQHitMap(document).get(action.id) ?? []
}

export function doesEZoneSlowMove(
  document: TacticDocumentV1,
  zone: EZoneAction,
  move: MoveAction,
): boolean {
  const owner = document.initialScene.players.find((player) => player.id === zone.actorId)
  const runner = document.initialScene.players.find((player) => player.id === move.actorId)
  const start = Math.max(zone.startTime, move.startTime)
  const end = Math.min(actionEndTime(zone), actionEndTime(move))
  if (!owner || !runner || owner.team === runner.team || end <= start) return false

  const hitMap = buildIceQHitMap(document)
  const steps = Math.max(1, Math.ceil((end - start) / E_ZONE_SAMPLE_SECONDS))
  for (let index = 0; index <= steps; index += 1) {
    const sampleTime = start + ((end - start) * index) / steps
    const frame = projectSceneCore(document, sampleTime, false, true, hitMap)
    const projectedOwner = frame.players.find((player) => player.id === owner.id)
    const projectedRunner = frame.players.find((player) => player.id === runner.id)
    if (projectedOwner && projectedRunner && distance(projectedOwner.position, projectedRunner.position) <= zone.radius) {
      return true
    }
  }
  return false
}

/** Retained for compatibility with existing rule callers and imported files with targetId. */
export function doesIceQHit(document: TacticDocumentV1, action: QMoveAction): boolean {
  const hits = analyzeDocumentIceQHits(document, action)
  return action.targetId ? hits.some((hit) => hit.targetId === action.targetId) : hits.length > 0
}

export function projectFrame(document: TacticDocumentV1, time: number): ProjectedFrame {
  const hitMap = buildIceQHitMap(document)
  return projectSceneCore(document, time, true, true, hitMap)
}
