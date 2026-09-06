import type { BasicRoleId, PlayerState, RoleId, RoleRule, RuleSetV1, TacticDocumentV1 } from './types'

export const BASIC_ROLE_IDS = ['water', 'fire', 'ice', 'electro', 'geo', 'anemo'] as const satisfies readonly BasicRoleId[]

const extraRoleLabels = {
  electro: { label: '雷', shortLabel: '雷' },
  geo: { label: '岩', shortLabel: '岩' },
  anemo: { label: '风', shortLabel: '风' },
}

export function isBasicRoleId(value: unknown): value is BasicRoleId {
  return BASIC_ROLE_IDS.some((role) => role === value)
}

function isSimulationRole(role: BasicRoleId): role is RoleId {
  return role === 'water' || role === 'fire' || role === 'ice'
}

export function effectiveBasicRole(document: TacticDocumentV1, player: PlayerState): BasicRoleId {
  const roles = document.basicPlayerRoles
  return roles && Object.hasOwn(roles, player.id) ? roles[player.id] ?? player.role : player.role
}

export function basicRoleDisplay(role: BasicRoleId, rules: RuleSetV1): Pick<RoleRule, 'label' | 'shortLabel'> {
  return isSimulationRole(role) ? rules.roles[role] : extraRoleLabels[role]
}

export function basicRoleRule(role: BasicRoleId, rules: RuleSetV1): RoleRule | undefined {
  return isSimulationRole(role) ? rules.roles[role] : undefined
}
