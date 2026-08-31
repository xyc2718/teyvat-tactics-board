import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { QMoveAction } from '../model/types'
import { cooldownRemainingText, earliestLegalQStart, qCooldownConflictNotice, qCooldownSequenceConflicts, validateQStart } from './qCooldown'

function q(id: string, actorId: string, startTime: number): QMoveAction {
  return { id, type: 'qMove', actorId, startTime, duration: 0, path: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }
}

describe('Q cooldown scheduling', () => {
  it.each([
    ['blue-water', 7],
    ['blue-fire', 9],
    ['blue-ice', 7],
  ] as const)('uses the configurable role cooldown for %s', (actorId, cooldown) => {
    const document = createDefaultDocument()
    document.actions.push(q('first', actorId, 0))
    expect(earliestLegalQStart(document, actorId, 0)).toBe(cooldown)
    expect(validateQStart(document, actorId, cooldown).valid).toBe(true)
  })

  it('finds the first gap after multiple existing Q windows', () => {
    const document = createDefaultDocument()
    document.actions.push(q('first', 'blue-water', 0), q('second', 'blue-water', 7))
    expect(earliestLegalQStart(document, 'blue-water', 1)).toBe(14)
    expect(earliestLegalQStart(document, 'blue-water', 14)).toBe(14)
  })

  it('handles configurable cooldowns, future Q windows, and other actors independently', () => {
    const document = createDefaultDocument()
    document.rulesSnapshot.roles.water.q.cooldown = 8.5
    document.actions.push(
      q('past', 'blue-water', 0),
      q('future', 'blue-water', 17),
      q('other-actor', 'red-water', 8.5),
    )

    expect(earliestLegalQStart(document, 'blue-water', 1)).toBe(8.5)
    expect(validateQStart(document, 'blue-water', 8.5).valid).toBe(true)
    expect(earliestLegalQStart(document, 'blue-water', 9)).toBe(25.5)
  })

  it('reports the precise missing gap and can ignore the edited action', () => {
    const document = createDefaultDocument()
    document.actions.push(q('first', 'blue-water', 0), q('edited', 'blue-water', 7))
    const invalid = validateQStart(document, 'blue-water', 5, 'edited')
    expect(invalid.valid).toBe(false)
    if (!invalid.valid) expect(invalid.conflict.remaining).toBeCloseTo(2)
    expect(validateQStart(document, 'blue-water', 7, 'edited').valid).toBe(true)
  })

  it('reports legacy-invalid sequence pairs while accepting exact boundaries', () => {
    const document = createDefaultDocument()
    document.actions.push(q('first', 'blue-water', 0), q('invalid', 'blue-water', 5), q('boundary', 'blue-water', 12))
    const conflicts = qCooldownSequenceConflicts(document, 'blue-water')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.later.id).toBe('invalid')
    expect(conflicts[0]?.remaining).toBe(2)
  })

  it('never formats a real near-boundary conflict as zero remaining time', () => {
    const document = createDefaultDocument()
    document.actions.push(q('first', 'blue-water', 0))
    const validation = validateQStart(document, 'blue-water', 6.999)
    expect(validation.valid).toBe(false)
    if (!validation.valid) expect(qCooldownConflictNotice(validation)).toContain('还差 不足 0.01 秒')
    expect(cooldownRemainingText(0.01)).toBe('0.01')
  })
})
