import {
  clamp,
  clampPoint,
  distance,
  getShootZone,
  oppositeFacingOffset,
  pathLength,
  pointAlongPath,
  resolvedMovePath,
  slicePath,
  truncatePath,
} from '../geometry/geometry'
import type {
  EZoneAction,
  MoveAction,
  PlayerState,
  PlayerStatus,
  ProjectedFrame,
  QMoveAction,
  ShootAction,
  TacticAction,
  TacticDocumentV1,
} from '../model/types'
import { analyzeIceQHits, type IceQHit } from '../rules/iceQHits'
import { actionEndTime, passPathProgress } from './durations'
import {
  movementReceiveBoostWindowFor,
  receiveBoostWindowFor,
  waterQGainAtTime,
  waterQMoveBoost,
} from './movementEffects'

type IceQHitMap = Map<string, IceQHit[]>

const iceQHitMapCache = new WeakMap<TacticDocumentV1, { signature: string; hitMap: IceQHitMap }>()

const E_ZONE_SAMPLE_SECONDS = 0.05
const E_ZONE_SAMPLE_DISTANCE = 0.05
const FOLLOW_SAMPLE_SECONDS = 0.05
const POSITION_EPSILON = 1e-6

type EZoneEffect = 'move' | 'qMove'

function clonePlayers(players: PlayerState[]): PlayerState[] {
  return players.map((player) => ({ ...player, position: { ...player.position } }))
}

function getActorRole(document: TacticDocumentV1, actorId: string) {
  return document.initialScene.players.find((player) => player.id === actorId)?.role
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

  // An explicit timing constraint is an authored arrival contract. It scales
  // the route uniformly to reach the endpoint at that time instead of adding
  // rule-derived boosts that could make the actor arrive early.
  if (action.timingConstraint) return traveled

  const role = getActorRole(document, action.actorId)
  const boostRule = role ? document.rulesSnapshot.roles[role].afterQBoost : undefined
  if (boostRule) {
    traveled += waterQGainAtTime(waterQMoveBoost(document, action), boostRule.duration, effectiveTime)
  }

  const receiveWindow = movementReceiveBoostWindowFor(document, action.actorId, action.startTime, effectiveTime)
  if (receiveWindow) {
    const elapsed = Math.max(
      0,
      Math.min(effectiveTime, receiveWindow.end) - Math.max(action.startTime, receiveWindow.start),
    )
    traveled += (elapsed / receiveWindow.boost.duration) * receiveWindow.boost.netSeparationGain
  }
  return traveled
}

function followMoveDistanceBudget(
  document: TacticDocumentV1,
  action: MoveAction,
  startTime: number,
  endTime: number,
): number {
  if (endTime <= startTime) return 0
  let budget = (endTime - startTime) * document.rulesSnapshot.field.baseMoveSpeed
  const role = getActorRole(document, action.actorId)
  const boostRule = role ? document.rulesSnapshot.roles[role].afterQBoost : undefined
  if (boostRule) {
    const source = [...document.actions]
      .filter((candidate): candidate is QMoveAction => (
        candidate.type === 'qMove'
        && candidate.actorId === action.actorId
        && actionEndTime(candidate) < actionEndTime(action)
        && actionEndTime(candidate) + boostRule.duration > action.startTime
      ))
      .sort((left, right) => actionEndTime(right) - actionEndTime(left))[0]
    if (source) {
      const boostStart = actionEndTime(source)
      const overlapStart = Math.max(startTime, action.startTime, boostStart)
      const overlapEnd = Math.min(endTime, actionEndTime(action), boostStart + boostRule.duration)
      if (overlapEnd > overlapStart) {
        budget += ((overlapEnd - overlapStart) / boostRule.duration) * boostRule.netSeparationGain
      }
    }
  }
  const receiveWindow = movementReceiveBoostWindowFor(document, action.actorId, action.startTime, endTime)
  if (receiveWindow) {
    const overlapStart = Math.max(startTime, action.startTime, receiveWindow.start)
    const overlapEnd = Math.min(endTime, receiveWindow.end)
    if (overlapEnd > overlapStart) {
      budget += ((overlapEnd - overlapStart) / receiveWindow.boost.duration)
        * receiveWindow.boost.netSeparationGain
    }
  }
  return budget
}

function eZoneMultiplierAt(
  document: TacticDocumentV1,
  movingActor: PlayerState,
  position: PlayerState['position'],
  time: number,
  effect: EZoneEffect,
  applyControlEffects: boolean,
  hitMap: IceQHitMap,
  ignoredActionIds: ReadonlySet<string> = new Set(),
): number {
  if (effect === 'qMove' && movingActor.role !== 'water') return 1
  const activeZones = document.actions.filter(
    (candidate): candidate is EZoneAction =>
      candidate.type === 'eZone' &&
      candidate.startTime <= time &&
      actionEndTime(candidate) > time,
  )
  if (activeZones.length === 0) return 1

  // Resolve moving zone centers without E effects to avoid recursive zone-to-zone projection.
  const centerFrame = projectSceneCore(document, time, false, applyControlEffects, hitMap, false, ignoredActionIds)
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
  return traceMoveWithEZoneSlow(document, action, time, applyControlEffects, hitMap).traveled
}

export interface EZoneSlowSegment {
  startTime: number
  endTime: number
  multiplier: number
  path: PlayerState['position'][]
}

interface EZoneMoveTrace {
  traveled: number
  segments: EZoneSlowSegment[]
}

interface FollowMoveTrace extends EZoneMoveTrace {
  position: PlayerState['position']
  path: PlayerState['position'][]
}

function traceFollowMove(
  document: TacticDocumentV1,
  action: MoveAction,
  time: number,
  applyControlEffects: boolean,
  hitMap: IceQHitMap,
  applyEZoneEffects: boolean,
  ignoredActionIds: ReadonlySet<string>,
): FollowMoveTrace {
  const movingActor = document.initialScene.players.find((player) => player.id === action.actorId)
  const origin = action.path[0]
  const targetPlayerId = action.targetPlayerId
  if (!movingActor || !origin || !targetPlayerId || time <= action.startTime) {
    const position = { ...(origin ?? movingActor?.position ?? { x: 0, y: 0 }) }
    return { traveled: 0, position, path: [position, { ...position }], segments: [] }
  }

  let end = Math.min(time, actionEndTime(action))
  if (applyControlEffects) {
    const freeze = freezeWindowsFor(document, action.actorId, hitMap).find(
      (window) => window.start < actionEndTime(action) && window.end > action.startTime,
    )
    if (freeze) end = Math.min(end, freeze.start)
  }
  if (end <= action.startTime) {
    return { traveled: 0, position: { ...origin }, path: [{ ...origin }, { ...origin }], segments: [] }
  }

  const nextIgnored = new Set(ignoredActionIds)
  nextIgnored.add(action.id)
  const steps = Math.max(1, Math.ceil((end - action.startTime) / FOLLOW_SAMPLE_SECONDS))
  const gap = Math.max(0, action.followGap ?? document.rulesSnapshot.roles[movingActor.role].attackRadius)
  const path: PlayerState['position'][] = [{ ...origin }]
  const segments: EZoneSlowSegment[] = []
  let position = { ...origin }
  let traveled = 0
  let fallbackUnit = { x: movingActor.team === 'blue' ? -1 : 1, y: 0 }

  for (let index = 0; index < steps; index += 1) {
    const stepStart = action.startTime + ((end - action.startTime) * index) / steps
    const stepEnd = action.startTime + ((end - action.startTime) * (index + 1)) / steps
    const targetFrame = projectSceneCore(
      document,
      stepEnd,
      false,
      applyControlEffects,
      hitMap,
      applyEZoneEffects,
      nextIgnored,
    )
    const target = targetFrame.players.find((player) => player.id === targetPlayerId)
    if (!target) continue

    const offsetX = position.x - target.position.x
    const offsetY = position.y - target.position.y
    const separation = Math.hypot(offsetX, offsetY)
    if (separation > POSITION_EPSILON) fallbackUnit = { x: offsetX / separation, y: offsetY / separation }
    const desired = {
      x: target.position.x + fallbackUnit.x * gap,
      y: target.position.y + fallbackUnit.y * gap,
    }
    const deltaX = desired.x - position.x
    const deltaY = desired.y - position.y
    const remaining = Math.hypot(deltaX, deltaY)
    const probe = remaining > POSITION_EPSILON
      ? { x: position.x + deltaX * 0.5, y: position.y + deltaY * 0.5 }
      : position
    const multiplier = applyControlEffects && applyEZoneEffects
      ? eZoneMultiplierAt(
          document,
          movingActor,
          probe,
          (stepStart + stepEnd) / 2,
          'move',
          applyControlEffects,
          hitMap,
          nextIgnored,
        )
      : 1
    const budget = followMoveDistanceBudget(document, action, stepStart, stepEnd) * multiplier
    const advance = Math.min(remaining, Math.max(0, budget))
    const previous = { ...position }
    if (remaining > POSITION_EPSILON && advance > POSITION_EPSILON) {
      position = clampPoint({
        x: position.x + (deltaX / remaining) * advance,
        y: position.y + (deltaY / remaining) * advance,
      }, document.rulesSnapshot.field.width, document.rulesSnapshot.field.height)
      traveled += distance(previous, position)
      path.push({ ...position })
    }
    if (multiplier < 1 - POSITION_EPSILON && distance(previous, position) > POSITION_EPSILON) {
      const last = segments.at(-1)
      if (last && Math.abs(last.endTime - stepStart) <= POSITION_EPSILON && Math.abs(last.multiplier - multiplier) <= POSITION_EPSILON) {
        last.endTime = stepEnd
        last.path.push({ ...position })
      } else {
        segments.push({ startTime: stepStart, endTime: stepEnd, multiplier, path: [previous, { ...position }] })
      }
    }
  }

  if (path.length === 1) path.push({ ...position })
  return { traveled, position, path, segments }
}

function traceMoveWithEZoneSlow(
  document: TacticDocumentV1,
  action: MoveAction,
  time: number,
  applyControlEffects: boolean,
  hitMap: IceQHitMap,
): EZoneMoveTrace {
  if (action.targetPlayerId && action.syncActionId) {
    return traceFollowMove(document, action, time, applyControlEffects, hitMap, true, new Set())
  }
  const movingActor = document.initialScene.players.find((player) => player.id === action.actorId)
  const route = resolvedMovePath(action)
  const routeLength = pathLength(route)
  const end = Math.min(Math.max(time, action.startTime), actionEndTime(action))
  if (!movingActor || routeLength <= 0 || end <= action.startTime) return { traveled: 0, segments: [] }

  // Fixed/keyframe timing is an explicit presentation contract and therefore
  // takes precedence over automatic speed modifiers for this one move.
  if (action.timingConstraint) {
    return { traveled: moveDistanceWithoutEZoneSlow(document, action, end), segments: [] }
  }

  const hasOverlappingEnemyZone = document.actions.some((candidate) => {
    if (candidate.type !== 'eZone') return false
    const owner = document.initialScene.players.find((player) => player.id === candidate.actorId)
    return owner?.team !== movingActor.team && candidate.startTime < end && actionEndTime(candidate) > action.startTime
  })
  if (!hasOverlappingEnemyZone) {
    return { traveled: moveDistanceWithoutEZoneSlow(document, action, end), segments: [] }
  }

  const steps = Math.max(1, Math.ceil((end - action.startTime) / E_ZONE_SAMPLE_SECONDS))
  let traveled = 0
  const sampledSegments: Array<{
    startDistance: number
    endDistance: number
    startTime: number
    endTime: number
    multiplier: number
  }> = []
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
    const multiplier = eZoneMultiplierAt(
      document,
      movingActor,
      probePosition,
      probeTime,
      'move',
      applyControlEffects,
      hitMap,
    )
    const nextTraveled = traveled + unslowedStep * multiplier
    if (multiplier < 1 - 1e-6 && nextTraveled > traveled + 1e-6) {
      const previous = sampledSegments.at(-1)
      if (previous && Math.abs(previous.endDistance - traveled) <= 1e-6 && Math.abs(previous.multiplier - multiplier) <= 1e-6) {
        previous.endDistance = nextTraveled
        previous.endTime = stepEnd
      } else {
        sampledSegments.push({
          startDistance: traveled,
          endDistance: nextTraveled,
          startTime: stepStart,
          endTime: stepEnd,
          multiplier,
        })
      }
    }
    traveled = nextTraveled
  }
  return {
    traveled,
    segments: sampledSegments.map((segment) => ({
      startTime: segment.startTime,
      endTime: segment.endTime,
      multiplier: segment.multiplier,
      path: slicePath(
        route,
        segment.startDistance / routeLength,
        Math.min(segment.endDistance, routeLength) / routeLength,
      ),
    })),
  }
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
  // The ice field only shortens Water's Q. Fire blink and Ice dash keep their
  // authored distance, while ordinary running remains slowed for every enemy role.
  if (movingActor.role !== 'water') return authoredDistance
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
  ignoredActionIds: ReadonlySet<string> = new Set(),
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
    if (ignoredActionIds.has(action.id)) continue
    if (action.startTime > time) continue
    const actor = 'actorId' in action
      ? players.find((player) => player.id === action.actorId)
      : undefined

    if (action.type === 'move' || action.type === 'qMove') {
      if (!actor || action.path.length < 2) continue
      if (action.type === 'move' && action.targetPlayerId && action.syncActionId) {
        actor.position = traceFollowMove(
          document,
          action,
          time,
          applyControlEffects,
          hitMap,
          applyEZoneEffects,
          ignoredActionIds,
        ).position
        continue
      }
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
      const progress = passPathProgress(action.path, time - action.startTime, action.duration, rules)
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
  const signature = JSON.stringify([document.rulesSnapshot, document.initialScene, document.actions])
  const cached = iceQHitMapCache.get(document)
  if (cached?.signature === signature) return cached.hitMap

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
    hitMap.set(action.id, analyzeIceQHits(
      effectiveAction,
      actor,
      startFrame.players,
      document.rulesSnapshot,
      (time) => projectSceneCore(document, time, false, true, hitMap).players,
    ))
  }
  iceQHitMapCache.set(document, { signature, hitMap })
  return hitMap
}

/**
 * Returns every frozen interval that belongs on a player's timeline.
 * Ice-Q freezes are derived from the same effective-path hit map used by
 * projection, so the editor never persists a second, drift-prone status action.
 */
export function documentFreezeWindows(
  document: TacticDocumentV1,
  playerId?: string,
): PlayerStatus[] {
  const hitMap = buildIceQHitMap(document)
  const derived = document.actions.flatMap((action): PlayerStatus[] => {
    if (action.type !== 'qMove' || getActorRole(document, action.actorId) !== 'ice') return []
    const freezeDuration = document.rulesSnapshot.roles.ice.q.freezeDuration ?? 0
    if (freezeDuration <= 0) return []
    return (hitMap.get(action.id) ?? []).map((hit) => ({
      id: `${action.id}-${hit.targetId}-freeze`,
      playerId: hit.targetId,
      kind: 'frozen',
      sourceActionId: action.id,
      startsAt: hit.hitTime,
      endsAt: hit.hitTime + freezeDuration,
    }))
  })
  const authored = document.actions.flatMap((action): PlayerStatus[] => (
    action.type === 'status' && action.status === 'frozen'
      ? [{
          id: `${action.id}-status`,
          playerId: action.targetId,
          kind: 'frozen',
          sourceActionId: action.id,
          startsAt: action.startTime,
          endsAt: actionEndTime(action),
          separationDelta: action.separationDelta,
        }]
      : []
  ))
  const unique = new Map<string, PlayerStatus>()
  for (const status of [...document.initialScene.statuses, ...authored, ...derived]) {
    if (status.kind !== 'frozen' || status.endsAt <= status.startsAt) continue
    if (playerId && status.playerId !== playerId) continue
    const key = `${status.playerId}:${status.sourceActionId}:${status.startsAt}:${status.endsAt}`
    unique.set(key, { ...status })
  }
  return [...unique.values()].sort(
    (left, right) => left.startsAt - right.startsAt || left.endsAt - right.endsAt || left.playerId.localeCompare(right.playerId),
  )
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

/** Returns the actual portions of an ordinary run completed under an opposing ice-field slow. */
export function eZoneSlowSegmentsForMove(
  document: TacticDocumentV1,
  action: MoveAction,
): EZoneSlowSegment[] {
  const hitMap = buildIceQHitMap(document)
  const freeze = freezeWindowsFor(document, action.actorId, hitMap).find(
    (window) => window.start < actionEndTime(action) && window.end > action.startTime,
  )
  const end = freeze ? Math.min(actionEndTime(action), freeze.start) : actionEndTime(action)
  return traceMoveWithEZoneSlow(document, action, end, true, hitMap).segments
}

/** Shared formal route for both fixed-point and player-following moves. */
export function projectedMovePath(document: TacticDocumentV1, action: MoveAction): PlayerState['position'][] {
  if (!action.targetPlayerId || !action.syncActionId) return resolvedMovePath(action)
  const hitMap = buildIceQHitMap(document)
  return traceFollowMove(document, action, actionEndTime(action), true, hitMap, true, new Set()).path
}

export function projectedMovePathSegment(
  document: TacticDocumentV1,
  action: MoveAction,
  startTime: number,
  endTime: number,
): PlayerState['position'][] {
  if (!action.targetPlayerId || !action.syncActionId) {
    const route = resolvedMovePath(action)
    return slicePath(
      route,
      clamp((startTime - action.startTime) / Math.max(action.duration, 0.0001), 0, 1),
      clamp((endTime - action.startTime) / Math.max(action.duration, 0.0001), 0, 1),
    )
  }
  const hitMap = buildIceQHitMap(document)
  const full = traceFollowMove(document, action, actionEndTime(action), true, hitMap, true, new Set())
  if (full.traveled <= POSITION_EPSILON) return full.path
  const start = traceFollowMove(document, action, startTime, true, hitMap, true, new Set())
  const end = traceFollowMove(document, action, endTime, true, hitMap, true, new Set())
  return slicePath(
    full.path,
    clamp(start.traveled / full.traveled, 0, 1),
    clamp(end.traveled / full.traveled, 0, 1),
  )
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
