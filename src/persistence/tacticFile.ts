import { z } from 'zod'
import { normalizeAngle } from '../domain/geometry/geometry'
import type { TacticDocumentV1 } from '../domain/model/types'

export const MAX_TACTIC_FILE_BYTES = 2 * 1024 * 1024
export const DRAFT_STORAGE_KEY = 'teyvat-tactics-board:draft:v1'

const finiteNumber = z.number().finite()
const nonNegative = finiteNumber.nonnegative()
const positive = finiteNumber.positive()
const vec2Schema = z.object({ x: finiteNumber, y: finiteNumber })
const teamSchema = z.enum(['blue', 'red'])
const roleSchema = z.enum(['water', 'fire', 'ice'])
const ratingSchema = z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.null()])

const playerSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(80),
  team: teamSchema,
  role: roleSchema,
  position: vec2Schema,
  facing: finiteNumber,
  hasBall: z.boolean(),
})

const statusSchema = z.object({
  id: z.string().min(1).max(120),
  playerId: z.string().min(1).max(100),
  kind: z.enum(['frozen', 'slowed', 'boosted']),
  sourceActionId: z.string().min(1).max(120),
  startsAt: nonNegative,
  endsAt: nonNegative,
  separationDelta: finiteNumber.optional(),
})

const sceneSchema = z.object({
  players: z.array(playerSchema).min(1).max(20),
  ball: z.object({
    position: vec2Schema,
    carrierId: z.string().max(100).nullable(),
    isFree: z.boolean(),
  }),
  statuses: z.array(statusSchema).max(100),
})

const actionBase = {
  id: z.string().min(1).max(120),
  startTime: nonNegative,
  duration: nonNegative,
  label: z.string().max(120).optional(),
}

const actionSchema = z.discriminatedUnion('type', [
  z.object({ ...actionBase, type: z.literal('move'), actorId: z.string(), path: z.array(vec2Schema).min(2).max(20) }),
  z.object({
    ...actionBase,
    type: z.literal('qMove'),
    actorId: z.string(),
    path: z.array(vec2Schema).min(2).max(20),
    targetId: z.string().optional(),
  }),
  z.object({
    ...actionBase,
    type: z.literal('pass'),
    actorId: z.string(),
    targetPlayerId: z.string().optional(),
    path: z.array(vec2Schema).min(2).max(20),
  }),
  z.object({ ...actionBase, type: z.literal('receive'), actorId: z.string(), sourceActionId: z.string().optional() }),
  z.object({ ...actionBase, type: z.literal('possession'), carrierId: z.null(), position: vec2Schema }),
  z.object({
    ...actionBase,
    type: z.literal('shoot'),
    actorId: z.string(),
    charge: z.enum(['yellow', 'red']),
    path: z.array(vec2Schema).min(2).max(20),
  }),
  z.object({ ...actionBase, type: z.literal('attack'), actorId: z.string(), targetId: z.string() }),
  z.object({ ...actionBase, type: z.literal('eZone'), actorId: z.string(), center: vec2Schema, radius: positive }),
  z.object({
    ...actionBase,
    type: z.literal('status'),
    actorId: z.string(),
    targetId: z.string(),
    status: z.enum(['frozen', 'slowed', 'boosted']),
    separationDelta: finiteNumber.optional(),
  }),
  z.object({ ...actionBase, type: z.literal('wait'), actorId: z.string().optional() }),
  z.object({
    ...actionBase,
    type: z.literal('annotation'),
    path: z.array(vec2Schema).min(2).max(20),
    text: z.string().max(300),
  }),
])

const qRuleSchema = z.object({
  kind: z.enum(['blink', 'dash']),
  maxDistance: positive,
  cooldown: nonNegative,
  duration: nonNegative,
  turnable: z.boolean(),
  freezeDuration: nonNegative.optional(),
  facingKnockback: nonNegative.optional(),
})

const roleRuleSchema = z.object({
  id: roleSchema,
  label: z.string().max(30),
  shortLabel: z.string().max(8),
  attackInnerRadius: nonNegative.optional(),
  attackRadius: nonNegative,
  q: qRuleSchema,
  afterQBoost: z.object({ duration: nonNegative, netSeparationGain: finiteNumber }).optional(),
  receiveBoost: z.object({
    duration: nonNegative,
    netSeparationGain: finiteNumber,
    transfersOnPass: z.boolean(),
  }).optional(),
  slow: z.object({
    duration: nonNegative,
    fullSeparationLoss: nonNegative,
    effectiveDuration: nonNegative,
    effectiveSeparationLoss: nonNegative,
  }).optional(),
  e: z.object({
    radius: positive,
    duration: nonNegative,
    cooldown: nonNegative,
    slowMultiplier: nonNegative.max(1).default(0.5),
    qDistanceMultiplier: nonNegative.max(1).default(0.7),
  }).optional(),
})

const matchupRowSchema = z.object({ water: ratingSchema, fire: ratingSchema, ice: ratingSchema })

const rulesSchema = z.object({
  version: z.string().min(1).max(80),
  field: z.object({
    width: z.literal(20),
    height: z.literal(10),
    baseMoveSpeed: positive,
    smallPenaltyRadius: positive,
    largePenaltyRadius: positive,
  }),
  passing: z.object({
    safeDistance: positive,
    maxDistance: positive,
    ballSpeed: positive,
    interceptStartWidth: nonNegative,
    interceptEndWidth: nonNegative,
  }),
  shooting: z.object({
    outerYellow: positive,
    outerRed: positive,
    innerYellow: positive,
    innerRed: positive,
    interruptedByAttack: z.boolean(),
  }),
  roles: z.object({ water: roleRuleSchema, fire: roleRuleSchema, ice: roleRuleSchema }),
  matchups: z.object({ water: matchupRowSchema, fire: matchupRowSchema, ice: matchupRowSchema }),
  modifiers: z.array(
    z.object({
      id: z.string().min(1).max(100),
      label: z.string().max(100),
      condition: z.enum([
        'innerZone',
        'outerZone',
        'attackerQUnavailable',
        'defenderQUnavailable',
        'attackerControlled',
        'defenderControlled',
        'separationAdvantage',
        'longPass',
        'badFacing',
      ]),
      delta: z.union([z.literal(-2), z.literal(-1), z.literal(1), z.literal(2)]),
      enabled: z.boolean(),
    }),
  ).max(100),
})

const documentSchema = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    title: z.string().max(120),
    author: z.string().max(80),
    notes: z.string().max(4000),
    updatedAt: z.string().max(80),
  }),
  rulesSnapshot: rulesSchema,
  initialScene: sceneSchema,
  staticMoveArrows: z.array(z.object({
    id: z.string().min(1).max(120),
    playerId: z.string().min(1).max(100),
    target: vec2Schema,
  })).max(6).default([]),
  stepMarkers: z.array(
    z.object({
      id: z.string().min(1).max(120),
      time: nonNegative,
      name: z.string().max(100),
      note: z.string().max(1000),
      snapshot: sceneSchema,
    }),
  ).min(1).max(100),
  actions: z.array(actionSchema).max(500),
  view: z.object({ analysis: z.boolean() }),
})

function sanitizeDocument(document: TacticDocumentV1): TacticDocumentV1 {
  const clean = structuredClone(document)
  const sanitize = (value: string) => value.replace(/[<>]/g, '')
  clean.meta.title = sanitize(clean.meta.title).trim() || '未命名战术'
  clean.meta.author = sanitize(clean.meta.author).trim()
  clean.meta.notes = sanitize(clean.meta.notes)
  for (const player of clean.initialScene.players) {
    player.name = sanitize(player.name)
    player.facing = normalizeAngle(player.facing)
  }
  for (const step of clean.stepMarkers) {
    step.name = sanitize(step.name).trim() || '未命名步骤'
    step.note = sanitize(step.note)
    for (const player of step.snapshot.players) {
      player.name = sanitize(player.name)
      player.facing = normalizeAngle(player.facing)
    }
  }
  for (const action of clean.actions) {
    if (action.label) action.label = sanitize(action.label)
    if (action.type === 'annotation') action.text = sanitize(action.text)
  }
  for (const role of Object.values(clean.rulesSnapshot.roles)) {
    role.label = sanitize(role.label)
    role.shortLabel = sanitize(role.shortLabel)
  }
  for (const modifier of clean.rulesSnapshot.modifiers) modifier.label = sanitize(modifier.label)
  return clean
}

function validateDocumentIntegrity(document: TacticDocumentV1): string | null {
  const field = document.rulesSnapshot.field
  const playerIds = document.initialScene.players.map((player) => player.id)
  const knownPlayers = new Set(playerIds)
  if (playerIds.length !== 6) return '初始场景必须包含 6 名球员。'
  if (knownPlayers.size !== playerIds.length) return '球员 ID 不能重复。'
  if (field.smallPenaltyRadius > field.largePenaltyRadius) return '小禁区半径不能大于大禁区半径。'
  if (document.rulesSnapshot.passing.safeDistance > document.rulesSnapshot.passing.maxDistance) {
    return '安全传球距离不能大于最大有效距离。'
  }
  for (const [roleId, role] of Object.entries(document.rulesSnapshot.roles)) {
    if (role.id !== roleId) return `职业规则 ${roleId} 的内部 ID 不一致。`
    if ((role.attackInnerRadius ?? 0) > role.attackRadius) return `${role.label}的攻击内半径不能大于外半径。`
  }

  const pointInField = (point: { x: number; y: number }) =>
    point.x >= 0 && point.x <= field.width && point.y >= 0 && point.y <= field.height
  const validateScene = (scene: TacticDocumentV1['initialScene'], label: string): string | null => {
    const ids = scene.players.map((player) => player.id)
    if (ids.length !== playerIds.length || ids.some((id) => !knownPlayers.has(id)) || new Set(ids).size !== ids.length) {
      return `${label}的球员列表与初始场景不一致。`
    }
    if (scene.players.some((player) => !pointInField(player.position)) || !pointInField(scene.ball.position)) {
      return `${label}包含球场范围外的坐标。`
    }
    const carriers = scene.players.filter((player) => player.hasBall)
    if (scene.ball.carrierId === null) {
      if (!scene.ball.isFree || carriers.length !== 0) return `${label}的自由球状态不一致。`
    } else if (
      !knownPlayers.has(scene.ball.carrierId) ||
      scene.ball.isFree ||
      carriers.length !== 1 ||
      carriers[0]?.id !== scene.ball.carrierId
    ) {
      return `${label}的持球者状态不一致。`
    }
    if (scene.statuses.some((status) => !knownPlayers.has(status.playerId) || status.endsAt < status.startsAt)) {
      return `${label}包含无效的球员状态。`
    }
    return null
  }

  const initialError = validateScene(document.initialScene, '初始场景')
  if (initialError) return initialError
  const stepIds = new Set<string>()
  for (const step of document.stepMarkers) {
    if (stepIds.has(step.id)) return '步骤 ID 不能重复。'
    stepIds.add(step.id)
    const error = validateScene(step.snapshot, `步骤“${step.name}”`)
    if (error) return error
  }

  const actionIds = new Set<string>()
  for (const action of document.actions) {
    if (actionIds.has(action.id)) return '动作 ID 不能重复。'
    actionIds.add(action.id)
    if ('actorId' in action && action.actorId && !knownPlayers.has(action.actorId)) return `动作 ${action.id} 的执行者不存在。`
    if ('targetId' in action && action.targetId && !knownPlayers.has(action.targetId)) return `动作 ${action.id} 的目标不存在。`
    if (action.type === 'pass' && action.targetPlayerId && !knownPlayers.has(action.targetPlayerId)) return `动作 ${action.id} 的接球队员不存在。`
    if ('path' in action && action.path.some((point) => !pointInField(point))) return `动作 ${action.id} 包含球场范围外的坐标。`
    // V1 keeps the activation snapshot for compatibility, but the live E-zone center is its actor.
    if (action.type === 'possession' && !pointInField(action.position)) return `动作 ${action.id} 的球权位置超出球场。`
  }
  const staticArrowIds = new Set<string>()
  const staticArrowPlayers = new Set<string>()
  for (const arrow of document.staticMoveArrows) {
    if (staticArrowIds.has(arrow.id)) return '基础移动箭头 ID 不能重复。'
    if (staticArrowPlayers.has(arrow.playerId)) return '每名球员最多保留一条基础移动箭头。'
    if (!knownPlayers.has(arrow.playerId)) return `基础移动箭头 ${arrow.id} 的球员不存在。`
    if (!pointInField(arrow.target)) return `基础移动箭头 ${arrow.id} 的目标超出球场。`
    staticArrowIds.add(arrow.id)
    staticArrowPlayers.add(arrow.playerId)
  }
  return null
}

export type ParseResult =
  | { ok: true; document: TacticDocumentV1 }
  | { ok: false; error: string }

export function serializeTactic(document: TacticDocumentV1): string {
  const saved: TacticDocumentV1 = {
    ...structuredClone(document),
    meta: { ...document.meta, updatedAt: new Date().toISOString() },
  }
  return JSON.stringify(saved, null, 2)
}

export function parseTactic(text: string): ParseResult {
  if (new Blob([text]).size > MAX_TACTIC_FILE_BYTES) {
    return { ok: false, error: '文件超过 2 MB 限制。' }
  }
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw === 'object' && raw !== null && 'schemaVersion' in raw && raw.schemaVersion !== 1) {
      return { ok: false, error: `暂不支持战术文件版本 ${String(raw.schemaVersion)}。` }
    }
    const result = documentSchema.safeParse(raw)
    if (!result.success) {
      const issue = result.error.issues[0]
      return {
        ok: false,
        error: `文件结构无效：${issue?.path.join('.') || '根节点'} ${issue?.message ?? ''}`.trim(),
      }
    }
    const document = result.data as TacticDocumentV1
    const integrityError = validateDocumentIntegrity(document)
    if (integrityError) return { ok: false, error: `文件结构无效：${integrityError}` }
    return { ok: true, document: sanitizeDocument(document) }
  } catch {
    return { ok: false, error: '无法解析 JSON 文件。' }
  }
}

export function saveDraft(document: TacticDocumentV1): void {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, serializeTactic(document))
  } catch {
    // Storage may be disabled or full; editing must remain available.
  }
}

export function loadDraft(): TacticDocumentV1 | null {
  try {
    const text = localStorage.getItem(DRAFT_STORAGE_KEY)
    if (!text) return null
    const result = parseTactic(text)
    return result.ok ? result.document : null
  } catch {
    return null
  }
}

export function downloadTactic(document: TacticDocumentV1): void {
  const blob = new Blob([serializeTactic(document)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  const safeTitle = document.meta.title.replace(/[\\/:*?"<>|]/g, '-').trim() || '提瓦特战术'
  anchor.href = url
  anchor.download = `${safeTitle}.teyvat-tactic.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
