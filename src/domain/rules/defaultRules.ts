import type { MatchupRating, RoleId, RuleSetV1 } from '../model/types'

export const ROLE_IDS: RoleId[] = ['water', 'fire', 'ice']

export const MATCHUP_LABELS: Record<Exclude<MatchupRating, null>, string> = {
  [-2]: '极不利',
  [-1]: '不利',
  0: '均势',
  1: '有利',
  2: '极有利',
}

export const defaultRules: RuleSetV1 = {
  version: 'teyvat-mvp-2',
  field: {
    width: 20,
    height: 14,
    baseMoveSpeed: 1,
    smallPenaltyRadius: 4,
    largePenaltyRadius: 7,
  },
  passing: {
    safeDistance: 4,
    maxDistance: 8,
    ballSpeed: 8,
    interceptStartWidth: 0.18,
    interceptEndWidth: 0.8,
  },
  shooting: {
    outerYellow: 0.8,
    outerRed: 1.6,
    innerYellow: 0.4,
    innerRed: 0.8,
    interruptedByAttack: true,
  },
  roles: {
    water: {
      id: 'water',
      label: '水灵',
      shortLabel: '水',
      attackInnerRadius: 0.2,
      attackRadius: 1,
      q: {
        kind: 'blink',
        maxDistance: 2.5,
        fixedDistance: false,
        cooldown: 7,
        duration: 0,
        turnable: true,
      },
      afterQBoost: {
        duration: 4.3,
        netSeparationGain: 0.8,
      },
    },
    fire: {
      id: 'fire',
      label: '蛮牛',
      shortLabel: '火',
      attackRadius: 1.5,
      q: {
        kind: 'blink',
        maxDistance: 2.3,
        fixedDistance: true,
        cooldown: 9,
        duration: 0,
        turnable: false,
      },
    },
    ice: {
      id: 'ice',
      label: '霜役',
      shortLabel: '冰',
      attackRadius: 0.5,
      q: {
        kind: 'dash',
        maxDistance: 3,
        fixedDistance: false,
        cooldown: 7,
        duration: 1,
        turnable: false,
        freezeDuration: 1.75,
        facingKnockback: 0.45,
      },
      receiveBoost: {
        duration: 4.3,
        netSeparationGain: 0.8,
        transfersOnPass: true,
      },
      slow: {
        duration: 7,
        fullSeparationLoss: 1.2,
        effectiveDuration: 4.5,
        effectiveSeparationLoss: 0.77,
      },
      e: {
        radius: 2,
        duration: 5,
        cooldown: 10,
        slowMultiplier: 0.5,
        qDistanceMultiplier: 0.7,
      },
    },
  },
  matchups: {
    water: { water: 1, fire: -2, ice: 1 },
    fire: { water: 0, fire: 0, ice: 1 },
    ice: { water: -1, fire: 0, ice: 1 },
  },
  modifiers: [
    {
      id: 'defender-q-down',
      label: '防守方 Q 冷却中',
      condition: 'defenderQUnavailable',
      delta: 1,
      enabled: true,
    },
    {
      id: 'attacker-q-down',
      label: '进攻方 Q 冷却中',
      condition: 'attackerQUnavailable',
      delta: -1,
      enabled: true,
    },
    {
      id: 'inner-zone',
      label: '进攻方位于小禁区',
      condition: 'innerZone',
      delta: 1,
      enabled: true,
    },
    {
      id: 'defender-controlled',
      label: '防守方受控',
      condition: 'defenderControlled',
      delta: 2,
      enabled: true,
    },
    {
      id: 'attacker-controlled',
      label: '进攻方受控',
      condition: 'attackerControlled',
      delta: -2,
      enabled: true,
    },
    {
      id: 'separation',
      label: '进攻方身位领先',
      condition: 'separationAdvantage',
      delta: 1,
      enabled: true,
    },
    {
      id: 'long-pass',
      label: '接球来自风险传球',
      condition: 'longPass',
      delta: -1,
      enabled: true,
    },
    {
      id: 'bad-facing',
      label: '冰的面向不利于摆脱',
      condition: 'badFacing',
      delta: -1,
      enabled: true,
    },
  ],
}

export function cloneDefaultRules(): RuleSetV1 {
  return structuredClone(defaultRules)
}
