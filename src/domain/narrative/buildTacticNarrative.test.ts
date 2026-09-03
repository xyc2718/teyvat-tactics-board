import { describe, expect, it } from 'vitest'
import { createDefaultDocument } from '../model/createDocument'
import type { EZoneAction, MoveAction, PassAction, QMoveAction, ShootAction } from '../model/types'
import { buildTacticNarrative } from './buildTacticNarrative'

describe('tactic narrative', () => {
  it('derives chronological ice hits, acceleration, pass threat, zones and hard warnings', () => {
    const document = createDefaultDocument()
    document.initialScene.players.find((player) => player.id === 'red-water')!.position = { x: 4.5, y: 7.8 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 6.5, y: 7.8 }
    const iceQ: QMoveAction = { id: 'narrative-ice', type: 'qMove', actorId: 'blue-ice', startTime: 0, duration: 1, path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }] }
    const waterQ: QMoveAction = { id: 'narrative-water', type: 'qMove', actorId: 'blue-water', startTime: 2, duration: 0, path: [{ x: 5.5, y: 5 }, { x: 8, y: 5 }] }
    const move: MoveAction = { id: 'narrative-move', type: 'move', actorId: 'blue-water', startTime: 2, duration: 5, path: [{ x: 8, y: 5 }, { x: 13, y: 5 }] }
    const pass: PassAction = { id: 'narrative-pass', type: 'pass', actorId: 'blue-water', startTime: 8, duration: 1.2, path: [{ x: 13, y: 5 }, { x: 4, y: 5 }] }
    const zone: EZoneAction = { id: 'narrative-zone', type: 'eZone', actorId: 'blue-ice', startTime: 10, duration: 5, center: { x: 10, y: 5 }, radius: 2 }
    document.actions.push(iceQ, waterQ, move, pass, zone)

    const narrative = buildTacticNarrative(document)
    const iceText = narrative.entries.find((entry) => entry.id === 'action-narrative-ice')?.detail ?? ''
    const moveText = narrative.entries.find((entry) => entry.id === 'action-narrative-move')?.detail ?? ''
    const passText = narrative.entries.find((entry) => entry.id === 'action-narrative-pass')?.detail ?? ''
    const zoneText = narrative.entries.find((entry) => entry.id === 'action-narrative-zone')?.detail ?? ''

    expect(iceText).toContain('命中 红方 1')
    expect(iceText).toContain('命中 红方 2')
    expect(iceText).toContain('0° 面向反向后退 0.45 格至')
    expect(moveText).toContain('水 Q 加速段')
    expect(passText).toContain('最高威胁')
    expect(zoneText).toContain('随移动跟随')
    expect(zoneText).toContain('0.5×')
    expect(zoneText).toContain('0.7×')
    expect(narrative.hardWarnings.some((warning) => warning.actionId === pass.id)).toBe(true)
    expect(narrative.entries[0]?.kind).toBe('step')
  })

  it('updates ice knockback narration from the target facing', () => {
    const document = createDefaultDocument()
    const target = document.initialScene.players.find((player) => player.id === 'red-water')!
    target.position = { x: 4.5, y: 7.8 }
    document.actions.push({
      id: 'facing-narrative', type: 'qMove', actorId: 'blue-ice', startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
    })

    target.facing = 0
    const rightFacing = buildTacticNarrative(document).entries.find((entry) => entry.id === 'action-facing-narrative')?.detail
    target.facing = 180
    const leftFacing = buildTacticNarrative(document).entries.find((entry) => entry.id === 'action-facing-narrative')?.detail

    expect(rightFacing).toContain('0° 面向')
    expect(rightFacing).toContain('(4.0, 7.8)')
    expect(leftFacing).toContain('180° 面向')
    expect(leftFacing).toContain('(5.0, 7.8)')
  })

  it('derives shot pressure and charge comparison in the live narrative', () => {
    const document = createDefaultDocument()
    const shooter = document.initialScene.players.find((player) => player.id === 'blue-water')!
    const defender = document.initialScene.players.find((player) => player.id === 'red-water')!
    shooter.position = { x: 17, y: 7 }
    defender.position = { x: 18.5, y: 7 }
    document.initialScene.players.find((player) => player.id === 'red-fire')!.position = { x: 10, y: 0 }
    document.initialScene.players.find((player) => player.id === 'red-ice')!.position = { x: 10, y: 14 }
    const shot: ShootAction = {
      id: 'pressure-narrative', type: 'shoot', actorId: shooter.id, charge: 'yellow', startTime: 0, duration: 0.4,
      path: [{ ...shooter.position }, { x: 20, y: 7 }],
    }
    document.actions.push(shot)

    const detail = buildTacticNarrative(document).entries.find((entry) => entry.id === 'action-pressure-narrative')?.detail
    expect(detail).toContain('最早受击')
    expect(detail).toContain('Q逼近')
    expect(detail).toContain('风险')

    shot.charge = 'red'
    shot.duration = 0.8
    expect(buildTacticNarrative(document).entries.find((entry) => entry.id === 'action-pressure-narrative')?.detail).toContain('红蓄力射门')
  })

  it('narrates the projected moving-target knockback and clamps it to the field', () => {
    const movingDocument = createDefaultDocument()
    const movingTarget = movingDocument.initialScene.players.find((player) => player.id === 'red-water')!
    movingTarget.position = { x: 4.5, y: 7.8 }
    movingTarget.facing = 0
    movingDocument.actions.push(
      {
        id: 'moving-target', type: 'move', actorId: movingTarget.id, startTime: 0, duration: 5,
        path: [{ ...movingTarget.position }, { x: 9.5, y: 7.8 }],
      },
      {
        id: 'moving-target-q', type: 'qMove', actorId: 'blue-ice', startTime: 0, duration: 1,
        path: [{ x: 3.5, y: 7.3 }, { x: 6.5, y: 7.3 }],
      },
    )
    const hitText = buildTacticNarrative(movingDocument).entries.find((entry) => entry.id === 'action-moving-target-q')?.detail
    expect(hitText).toContain('(4.5, 7.8)')

    const boundaryDocument = createDefaultDocument()
    const boundaryTarget = boundaryDocument.initialScene.players.find((player) => player.id === 'red-water')!
    boundaryTarget.position = { x: 0.1, y: 7.3 }
    boundaryTarget.facing = 0
    boundaryDocument.actions.push({
      id: 'boundary-q', type: 'qMove', actorId: 'blue-ice', startTime: 0, duration: 1,
      path: [{ x: 3.5, y: 7.3 }, { x: 0.5, y: 7.3 }],
    })
    const boundaryText = buildTacticNarrative(boundaryDocument).entries.find((entry) => entry.id === 'action-boundary-q')?.detail
    expect(boundaryText).toContain('格至 (0.0, 7.3)')
  })

  it('handles a structurally empty draft and keeps user text as inert narrative content', () => {
    const document = createDefaultDocument()
    document.stepMarkers = []
    document.actions = []
    expect(buildTacticNarrative(document)).toEqual({ entries: [], hardWarnings: [] })

    document.actions.push({
      id: 'untrusted-note', type: 'annotation', startTime: 0, duration: 1,
      path: [{ x: 1, y: 1 }, { x: 2, y: 2 }], text: '</p><script>window.bad = true</script>',
    })
    expect(buildTacticNarrative(document).entries[0]?.detail).toContain('<script>')
  })
})
