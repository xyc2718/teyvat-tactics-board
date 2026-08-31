import { cloneDefaultRules } from '../rules/defaultRules'
import type { PlayerState, SceneState, TacticDocumentV1 } from './types'

function player(
  id: string,
  name: string,
  team: 'blue' | 'red',
  role: 'water' | 'fire' | 'ice',
  x: number,
  y: number,
  facing: number,
): PlayerState {
  return { id, name, team, role, position: { x, y }, facing, hasBall: false }
}

export function createInitialScene(): SceneState {
  const players = [
    player('blue-water', '蓝方 1', 'blue', 'water', 5.5, 7, 0),
    player('blue-fire', '蓝方 2', 'blue', 'fire', 3.5, 4.7, 0),
    player('blue-ice', '蓝方 3', 'blue', 'ice', 3.5, 9.3, 0),
    player('red-water', '红方 1', 'red', 'water', 14.5, 7, 180),
    player('red-fire', '红方 2', 'red', 'fire', 16.5, 4.7, 180),
    player('red-ice', '红方 3', 'red', 'ice', 16.5, 9.3, 180),
  ]
  const carrier = players[0]
  if (carrier) carrier.hasBall = true
  return {
    players,
    ball: { position: { x: 5.85, y: 7 }, carrierId: carrier?.id ?? null, isFree: false },
    statuses: [],
  }
}

export function createDefaultDocument(): TacticDocumentV1 {
  const scene = createInitialScene()
  return {
    schemaVersion: 1,
    meta: {
      title: '未命名战术',
      author: '',
      notes: '',
      updatedAt: new Date().toISOString(),
    },
    rulesSnapshot: cloneDefaultRules(),
    initialScene: structuredClone(scene),
    staticMoveArrows: [],
    stepMarkers: [
      {
        id: 'step-opening',
        time: 0,
        name: '初始站位',
        note: '',
        snapshot: structuredClone(scene),
      },
    ],
    actions: [],
    view: { analysis: false },
  }
}
