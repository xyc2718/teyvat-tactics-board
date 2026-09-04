import { useEffect, useMemo, useRef, useState } from 'react'
import { angleToVector, directionAngle, normalizeAngle, pathLength, pointAlongPath } from '../domain/geometry/geometry'
import type { PlayerState, ProjectedFrame, RuleSetV1, StaticMoveArrow, TacticAction, TacticDocumentV1, ToolId, Vec2 } from '../domain/model/types'
import {
  classifyPassThreat,
  PASS_THREAT_LABELS,
  PASS_THREAT_ORDER,
} from '../domain/rules/passThreat'
import {
  evaluateShotActionPressure,
  shotPressureSummary,
} from '../domain/rules/shotPressure'
import { receiveMoveBoost, waterQMoveBoost } from '../domain/timeline/movementEffects'
import { analyzeDocumentIceQHits, effectiveQPath, evaluateQDistanceEffect, eZoneSlowSegmentsForMove, projectedMovePath, projectedMovePathSegment, projectFrame, projectFrameAtKeyframe, statusSlowSegmentsForMove } from '../domain/timeline/projectFrame'
import { isOpeningStep } from '../domain/timeline/steps'
import { useTacticStore } from '../editor/useTacticStore'
import {
  actorPrompt,
  isRangeInspectionTool,
  isToolActorEligible,
  isToolTargetPlayerEligible,
  resolveToolActor,
  targetPrompt,
  toolNeedsActor,
} from '../editor/toolWorkflow'
import { toolLabels } from '../ui/labels'
import { clientPointToSvgViewBox } from './svgCoordinates'

const SCALE = 50
const VIEW_PADDING = { x: 36, y: 22 }
const BOARD_ZOOM_MIN = 0.5
const BOARD_ZOOM_MAX = 2
const BOARD_ZOOM_STEP = 0.25

function toSvg(point: Vec2) {
  return { x: point.x * SCALE, y: point.y * SCALE }
}

function pointsAttribute(path: Vec2[]) {
  return path.map((point) => `${Number((point.x * SCALE).toFixed(3))},${Number((point.y * SCALE).toFixed(3))}`).join(' ')
}

function actionPath(action: TacticAction): Vec2[] | null {
  return 'path' in action ? action.path : null
}

function openingFrame(document: TacticDocumentV1): ProjectedFrame {
  const carrier = document.initialScene.ball.carrierId
    ? document.initialScene.players.find((player) => player.id === document.initialScene.ball.carrierId)
    : undefined
  return {
    ...document.initialScene,
    players: document.initialScene.players.map((player) => ({
      ...player,
      position: { ...player.position },
      hasBall: player.id === document.initialScene.ball.carrierId,
    })),
    ball: {
      ...document.initialScene.ball,
      position: carrier ? { ...carrier.position } : { ...document.initialScene.ball.position },
    },
    statuses: [],
    time: 0,
    cooldowns: Object.fromEntries(document.initialScene.players.map((player) => [player.id, { q: 0, e: 0 }])),
    shots: [],
  }
}

type DragState =
  | { kind: 'entity'; id: string; point: Vec2 }
  | { kind: 'path'; actionId: string; index: number; point: Vec2 }
  | { kind: 'curve'; actionId: string; point: Vec2 }
  | { kind: 'staticArrow'; arrowId: string; point: Vec2 }
  | { kind: 'facing'; playerId: string; center: Vec2; initialFacing: number; facing: number }
  | { kind: 'viewport'; clientX: number; clientY: number; scrollLeft: number; scrollTop: number }
  | null

export function TacticsBoard({ initialZoom = 1, touchOptimized = false }: { initialZoom?: number; touchOptimized?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const boardViewportRef = useRef<HTMLDivElement>(null)
  const knownPassActionIdsRef = useRef(new Set<string>())
  const [drag, setDrag] = useState<DragState>(null)
  const [boardZoom, setBoardZoom] = useState(() => Math.max(BOARD_ZOOM_MIN, Math.min(BOARD_ZOOM_MAX, initialZoom)))
  const [isPassLegendDismissed, setIsPassLegendDismissed] = useState(false)
  const document = useTacticStore((state) => state.document)
  const currentTime = useTacticStore((state) => state.currentTime)
  const currentKeyframe = useTacticStore((state) => state.currentKeyframe)
  const activeStepId = useTacticStore((state) => state.activeStepId)
  const isPlaying = useTacticStore((state) => state.isPlaying)
  const selection = useTacticStore((state) => state.selection)
  const tool = useTacticStore((state) => state.tool)
  const boardMode = useTacticStore((state) => state.boardMode)
  const select = useTacticStore((state) => state.select)
  const chooseActor = useTacticStore((state) => state.chooseActorForTool)
  const reselectToolActor = useTacticStore((state) => state.reselectToolActor)
  const setNotice = useTacticStore((state) => state.setNotice)
  const moveEntity = useTacticStore((state) => state.moveEntity)
  const setPlayerFacing = useTacticStore((state) => state.setPlayerFacing)
  const createAction = useTacticStore((state) => state.createAction)
  const updateActionPathPoint = useTacticStore((state) => state.updateActionPathPoint)
  const updateMoveCurveControl = useTacticStore((state) => state.updateMoveCurveControl)
  const updateStaticMoveArrowTarget = useTacticStore((state) => state.updateStaticMoveArrowTarget)
  const deleteStaticMoveArrow = useTacticStore((state) => state.deleteStaticMoveArrow)
  const frame = useMemo(
    () => boardMode === 'basic' || (isOpeningStep(document, activeStepId) && !isPlaying)
      ? openingFrame(document)
      : projectFrameAtKeyframe(document, currentTime, currentKeyframe),
    [activeStepId, boardMode, currentKeyframe, currentTime, document, isPlaying],
  )
  const rules = document.rulesSnapshot
  const fieldWidth = rules.field.width * SCALE
  const fieldHeight = rules.field.height * SCALE
  const fieldCenterX = fieldWidth / 2
  const fieldCenterY = fieldHeight / 2
  const view = {
    x: -VIEW_PADDING.x,
    y: -VIEW_PADDING.y,
    width: fieldWidth + VIEW_PADDING.x * 2,
    height: fieldHeight + VIEW_PADDING.y * 2,
  }

  const selectedPlayer = selection?.kind === 'player'
    ? frame.players.find((player) => player.id === selection.id)
    : undefined
  const toolActor = resolveToolActor(tool, selectedPlayer, frame, rules)
  const actionActor = toolNeedsActor(tool) ? toolActor : selectedPlayer
  const selectedPass = selection?.kind === 'action'
    ? document.actions.find((action) => action.id === selection.id && action.type === 'pass')
    : undefined
  const selectedAction = selection?.kind === 'action'
    ? document.actions.find((action) => action.id === selection.id)
    : undefined
  const selectedStaticArrow = selection?.kind === 'staticArrow'
    ? document.staticMoveArrows.find((arrow) => arrow.id === selection.id)
    : undefined

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      const viewport = boardViewportRef.current
      if (!viewport) return
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2)
      viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2)
    })
    return () => cancelAnimationFrame(frameId)
  }, [boardZoom])

  useEffect(() => {
    const nextPassActionIds = new Set(
      document.actions.filter((action) => action.type === 'pass').map((action) => action.id),
    )
    const addedPass = [...nextPassActionIds].some((actionId) => !knownPassActionIdsRef.current.has(actionId))
    knownPassActionIdsRef.current = nextPassActionIds
    if (addedPass) setIsPassLegendDismissed(false)
  }, [document.actions])

  function changeBoardZoom(direction: -1 | 1) {
    setBoardZoom((current) => Math.max(
      BOARD_ZOOM_MIN,
      Math.min(BOARD_ZOOM_MAX, Number((current + direction * BOARD_ZOOM_STEP).toFixed(2))),
    ))
  }
  function clientToLogicalPoint(clientX: number, clientY: number): Vec2 {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const svgPoint = clientPointToSvgViewBox({ x: clientX, y: clientY }, rect, view)
    return { x: svgPoint.x / SCALE, y: svgPoint.y / SCALE }
  }

  function clientToField(clientX: number, clientY: number): Vec2 {
    const point = clientToLogicalPoint(clientX, clientY)
    return {
      x: Math.max(0, Math.min(rules.field.width, point.x)),
      y: Math.max(0, Math.min(rules.field.height, point.y)),
    }
  }

  function beginEntityDrag(event: React.PointerEvent, id: string, point: Vec2) {
    if (event.button !== 0 || isPlaying) return
    event.stopPropagation()
    if (tool !== 'select') {
      if (tool === 'shoot') {
        if (id === 'ball') setNotice('射门只需选择一名球员。')
        else chooseActor(id)
        return
      }
      if (isRangeInspectionTool(tool)) {
        if (id === 'ball') setNotice(`${toolLabels[tool].label}模式请点击一名球员。`)
        else chooseActor(id)
        return
      }
      if (tool === 'move' && id !== 'ball') {
        if (!toolActor || toolActor.id === id) chooseActor(id)
        else createAction(actionActor?.id ?? null, point, id)
        return
      }
      if (tool === 'qMove' && id !== 'ball') {
        chooseActor(id)
        return
      }
      if (toolNeedsActor(tool) && !toolActor) {
        if (id === 'ball') setNotice('当前步骤需要先选择一名可用球员。')
        else chooseActor(id)
        return
      }
      createAction(actionActor?.id ?? null, point, id === 'ball' ? undefined : id)
      return
    }
    if (touchOptimized) event.preventDefault()
    select(id === 'ball' ? { kind: 'ball', id: 'ball' } : { kind: 'player', id })
    setDrag({ kind: 'entity', id, point })
    svgRef.current?.setPointerCapture?.(event.pointerId)
  }

  function beginFacingDrag(event: React.PointerEvent<SVGGElement>, player: PlayerState, center: Vec2) {
    if (tool !== 'select' || event.button !== 0 || isPlaying) return
    event.preventDefault()
    event.stopPropagation()
    const facing = normalizeAngle(player.facing)
    setDrag({ kind: 'facing', playerId: player.id, center: { ...center }, initialFacing: facing, facing })
    event.currentTarget.ownerSVGElement?.setPointerCapture?.(event.pointerId)
  }

  function onBoardPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || isPlaying) return
    const point = clientToField(event.clientX, event.clientY)
    if (tool === 'select') {
      select(null)
      if (touchOptimized && boardViewportRef.current) {
        event.preventDefault()
        setDrag({
          kind: 'viewport',
          clientX: event.clientX,
          clientY: event.clientY,
          scrollLeft: boardViewportRef.current.scrollLeft,
          scrollTop: boardViewportRef.current.scrollTop,
        })
        svgRef.current?.setPointerCapture?.(event.pointerId)
      }
      return
    }
    if (isRangeInspectionTool(tool)) {
      setNotice(`${toolLabels[tool].label}模式请点击一名球员，可连续切换查看对象。`)
      return
    }
    if (tool === 'shoot') {
      setNotice('射门无需选择落点；请点击一名射门球员。')
      return
    }
    if (tool === 'eZone') {
      setNotice(actorPrompt(tool))
      return
    }
    if (toolNeedsActor(tool) && !toolActor) {
      setNotice(actorPrompt(tool))
      return
    }
    createAction(actionActor?.id ?? null, point)
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (drag && touchOptimized) event.preventDefault()
    if (drag?.kind === 'viewport') {
      const viewport = boardViewportRef.current
      if (!viewport) return
      viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.clientX)
      viewport.scrollTop = drag.scrollTop - (event.clientY - drag.clientY)
      return
    }
    const logicalPoint = clientToLogicalPoint(event.clientX, event.clientY)
    const point = clientToField(event.clientX, event.clientY)
    if (drag?.kind === 'facing') {
      setDrag({ ...drag, facing: directionAngle(drag.center, logicalPoint, drag.facing) })
    } else if (drag) {
      setDrag({ ...drag, point })
    }
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (!drag) return
    if (touchOptimized) event.preventDefault()
    if (drag.kind === 'entity') moveEntity(drag.id, drag.point)
    if (drag.kind === 'path') updateActionPathPoint(drag.actionId, drag.index, drag.point)
    if (drag.kind === 'curve') updateMoveCurveControl(drag.actionId, drag.point)
    if (drag.kind === 'staticArrow') updateStaticMoveArrowTarget(drag.arrowId, drag.point)
    if (drag.kind === 'facing') {
      const delta = Math.abs(normalizeAngle(drag.facing - drag.initialFacing))
      if (delta > 0.001 && Math.abs(delta - 360) > 0.001) setPlayerFacing(drag.playerId, drag.facing)
    }
    setDrag(null)
    if (svgRef.current?.hasPointerCapture?.(event.pointerId)) svgRef.current.releasePointerCapture?.(event.pointerId)
  }

  function onPointerCancel(event: React.PointerEvent<SVGSVGElement>) {
    setDrag(null)
    if (svgRef.current?.hasPointerCapture?.(event.pointerId)) svgRef.current.releasePointerCapture?.(event.pointerId)
  }

  function onLostPointerCapture() {
    setDrag(null)
  }

  function previewPath(action: TacticAction): Vec2[] | null {
    const path = actionPath(action)
    if (!path) return null
    if (drag?.kind === 'path' && drag.actionId === action.id) {
      return path.map((point, index) => index === drag.index ? drag.point : point)
    }
    if (action.type === 'pass' && drag?.kind === 'entity' && drag.id !== 'ball') {
      return action.actorId === drag.id
        ? path.map((point, index) => index === 0 ? drag.point : point)
        : path
    }
    if (action.type === 'shoot' && drag?.kind === 'entity' && drag.id === action.actorId) {
      return path.map((point, index) => index === 0 ? drag.point : point)
    }
    return path
  }

  function renderAction(action: TacticAction, elevated: boolean) {
    const isSelected = selection?.kind === 'action' && selection.id === action.id
    if (action.type === 'eZone') {
      const endTime = action.startTime + action.duration
      const active = currentTime >= action.startTime && currentTime < endTime
      if (!elevated && !document.view.analysis && !active) return null
      const sampleTime = Math.max(action.startTime, Math.min(currentTime, endTime))
      const zoneFrame = active ? frame : projectFrame(document, sampleTime)
      const center = zoneFrame.players.find((player) => player.id === action.actorId)?.position ?? action.center
      const owner = zoneFrame.players.find((player) => player.id === action.actorId)
      const multiplier = owner ? rules.roles[owner.role].e?.slowMultiplier : undefined
      return (
        <g key={action.id} data-action-id={action.id} className={isSelected ? 'selected-action' : ''} pointerEvents={elevated ? 'none' : undefined} onPointerDown={(event) => { event.stopPropagation(); select({ kind: 'action', id: action.id }) }}>
          <circle cx={center.x * SCALE} cy={center.y * SCALE} r={action.radius * SCALE} className={`ice-zone ${active ? 'active' : ''}`}>
            <title>随身冰圈 · 持续 {action.duration.toFixed(1)} 秒 · 敌方圈内移速 {multiplier ?? 1}× · 仅敌方水 Q 距离 {owner ? rules.roles[owner.role].e?.qDistanceMultiplier ?? 1 : 1}×</title>
          </circle>
        </g>
      )
    }
    const path = previewPath(action)
    if (!path) return null
    const qAction = action.type === 'qMove' ? { ...action, path } : null
    const qEffect = qAction ? evaluateQDistanceEffect(document, qAction) : null
    const moveAction = action.type === 'move'
      ? { ...action, path, curveControl: drag?.kind === 'curve' && drag.actionId === action.id ? drag.point : action.curveControl }
      : null
    const renderedPath = qAction ? effectiveQPath(document, qAction) : moveAction ? projectedMovePath(document, moveAction) : path
    const isCurrent = currentTime >= action.startTime && currentTime <= action.startTime + Math.max(action.duration, 0.1)
    const atJoint = Math.abs(currentTime - action.startTime) <= 1e-5 || Math.abs(currentTime - (action.startTime + action.duration)) <= 1e-5
    const remainingPlannedPath = (action.type === 'move' || action.type === 'qMove' || action.type === 'shoot')
      && action.startTime + action.duration >= currentTime - 1e-5
    if (!elevated && !(isPlaying ? isCurrent : atJoint || remainingPlannedPath)) return null
    const rawWaterBoost = moveAction ? waterQMoveBoost(document, moveAction) : null
    const waterBoost = rawWaterBoost && moveAction?.targetPlayerId
      ? { ...rawWaterBoost, path: projectedMovePathSegment(document, moveAction, rawWaterBoost.overlapStart, rawWaterBoost.overlapEnd) }
      : rawWaterBoost
    const rawReceiveBoost = moveAction ? receiveMoveBoost(document, moveAction) : null
    const receiveBoost = rawReceiveBoost && moveAction?.targetPlayerId
      ? { ...rawReceiveBoost, path: projectedMovePathSegment(document, moveAction, rawReceiveBoost.overlapStart, rawReceiveBoost.overlapEnd) }
      : rawReceiveBoost
    const eZoneSlowSegments = moveAction ? eZoneSlowSegmentsForMove(document, moveAction) : []
    const statusSlowSegments = moveAction ? statusSlowSegmentsForMove(document, moveAction) : []
    const shotPressure = action.type === 'shoot' ? evaluateShotActionPressure(document, action) : null
    return (
      <g
        key={action.id}
        data-action-id={action.id}
        className={isSelected ? 'selected-action' : ''}
        pointerEvents={elevated ? 'none' : undefined}
        onPointerDown={(event) => { event.stopPropagation(); select({ kind: 'action', id: action.id }) }}
      >
        {action.type === 'pass'
          ? <PassThreatLines
              path={path}
              passerId={action.actorId}
              frame={projectFrame(document, action.startTime)}
              rules={rules}
              markerEnd="url(#arrow-pass)"
            />
          : <polyline
              points={pointsAttribute(renderedPath)}
              className={`action-path action-${action.type} ${moveAction?.targetPlayerId ? 'action-move-follow' : ''}`}
              markerEnd={`url(#arrow-${action.type === 'qMove' ? 'q' : action.type === 'shoot' ? 'shoot' : action.type === 'annotation' ? 'note' : 'move'})`}
            >
              {qEffect && qEffect.reduction > 0.005 && <title>冰圈影响：原路径 {qEffect.authoredDistance.toFixed(2)} 格，实际 Q 位移 {qEffect.effectiveDistance.toFixed(2)} 格</title>}
              {moveAction?.targetPlayerId && <title>贴身跟随 · 同步至目标动作结束 · 间距 {moveAction.followGap?.toFixed(2)} 格</title>}
            </polyline>}
        {waterBoost && <WaterBoostRoute effect={waterBoost} />}
        {receiveBoost && <ReceiveBoostRoute effect={receiveBoost} />}
        {eZoneSlowSegments.length > 0 && <EZoneSlowRoute segments={eZoneSlowSegments} />}
        {statusSlowSegments.length > 0 && <StatusSlowRoute segments={statusSlowSegments} />}
        {document.view.analysis && action.type === 'pass' && <PassAnalysis path={path} document={document} />}
        {document.view.analysis && action.type === 'qMove' && <QAnalysis action={action} document={document} scale={SCALE} />}
        {action.type === 'shoot' && shotPressure && <ShotPressureLabel path={path} evaluation={shotPressure} />}
        {elevated && action.type !== 'shoot' && !(action.type === 'pass' && action.targetPlayerId) && !(action.type === 'move' && action.targetPlayerId) && path.map((point, index) => (
          <g
            key={`${action.id}-handle-${index}`}
            className="path-handle-target"
            onPointerDown={(event) => {
              if (touchOptimized) event.preventDefault()
              event.stopPropagation()
              setDrag({ kind: 'path', actionId: action.id, index, point })
              svgRef.current?.setPointerCapture?.(event.pointerId)
            }}
          >
            {touchOptimized && <circle cx={point.x * SCALE} cy={point.y * SCALE} r="20" className="svg-touch-hit-area" />}
            <circle cx={point.x * SCALE} cy={point.y * SCALE} r="8" className="path-handle" pointerEvents="all" />
          </g>
        ))}
        {elevated && action.type === 'move' && !action.targetPlayerId && action.curveControl && <g
          className="path-handle-target"
          role="slider"
          aria-label="调整跑动曲线"
          onPointerDown={(event) => {
            if (touchOptimized) event.preventDefault()
            event.stopPropagation()
            setDrag({ kind: 'curve', actionId: action.id, point: action.curveControl! })
            svgRef.current?.setPointerCapture?.(event.pointerId)
          }}
        >
          {touchOptimized && <circle
            cx={(drag?.kind === 'curve' && drag.actionId === action.id ? drag.point.x : action.curveControl.x) * SCALE}
            cy={(drag?.kind === 'curve' && drag.actionId === action.id ? drag.point.y : action.curveControl.y) * SCALE}
            r="20"
            className="svg-touch-hit-area"
          />}
          <circle
            cx={(drag?.kind === 'curve' && drag.actionId === action.id ? drag.point.x : action.curveControl.x) * SCALE}
            cy={(drag?.kind === 'curve' && drag.actionId === action.id ? drag.point.y : action.curveControl.y) * SCALE}
            r="9"
            className="path-handle curve-handle"
            pointerEvents="all"
          />
        </g>}
      </g>
    )
  }

  function playerPosition(id: string, fallback: Vec2) {
    return drag?.kind === 'entity' && drag.id === id ? drag.point : fallback
  }

  function renderStaticArrow(arrow: StaticMoveArrow, elevated: boolean) {
    const player = frame.players.find((candidate) => candidate.id === arrow.playerId)
    if (!player) return null
    const start = playerPosition(player.id, player.position)
    const target = drag?.kind === 'staticArrow' && drag.arrowId === arrow.id ? drag.point : arrow.target
    const selected = selection?.kind === 'staticArrow' && selection.id === arrow.id
    return <g
      key={arrow.id}
      data-static-arrow-id={arrow.id}
      className={`static-move-arrow-group ${selected ? 'selected' : ''}`}
      pointerEvents={elevated ? 'none' : undefined}
      onPointerDown={(event) => {
        event.stopPropagation()
        select({ kind: 'staticArrow', id: arrow.id })
      }}
    >
      <line
        x1={start.x * SCALE}
        y1={start.y * SCALE}
        x2={target.x * SCALE}
        y2={target.y * SCALE}
        className={`static-move-arrow team-${player.team}`}
        markerEnd={`url(#arrow-basic-${player.team})`}
      >
        <title>{player.name} 移动箭头</title>
      </line>
      {elevated && <g
        className="path-handle-target"
        role="slider"
        tabIndex={0}
        aria-label={`调整${player.name}移动箭头终点`}
        onPointerDown={(event) => {
          if (touchOptimized) event.preventDefault()
          event.stopPropagation()
          setDrag({ kind: 'staticArrow', arrowId: arrow.id, point: target })
          svgRef.current?.setPointerCapture?.(event.pointerId)
        }}
      >
        {touchOptimized && <circle cx={target.x * SCALE} cy={target.y * SCALE} r="20" className="svg-touch-hit-area" />}
        <circle cx={target.x * SCALE} cy={target.y * SCALE} r="9" className="path-handle static-arrow-handle" pointerEvents="all" />
      </g>}
    </g>
  }

  const ballPosition = drag?.kind === 'entity' && (drag.id === 'ball' || drag.id === frame.ball.carrierId)
    ? drag.point
    : frame.ball.position
  const zoomPercent = Math.round(boardZoom * 100)
  const zoomSurfacePercent = Math.max(1, boardZoom) * 100
  const boardRenderPercent = Math.min(1, boardZoom) * 100
  const hasPassLegendContext = boardMode === 'simulation'
    && Boolean(tool === 'pass' || selectedPass || document.actions.some((action) => action.type === 'pass'))
  const showsSimulationAnalysis = boardMode === 'simulation' && document.view.analysis
  const basicToolName = tool === 'move' ? '移动箭头' : toolLabels[tool].label
  const basicToolPrompt = isRangeInspectionTool(tool)
    ? toolActor ? targetPrompt(tool) : actorPrompt(tool)
    : toolActor ? '点击球场设置箭头终点' : '选择一名球员'

  return (
    <div
      className="board-shell"
      aria-label={`${rules.field.width} 乘 ${rules.field.height} 格战术球场`}
      data-board-zoom={zoomPercent}
      data-touch-optimized={touchOptimized ? 'true' : 'false'}
    >
      {hasPassLegendContext && !isPassLegendDismissed && (
        <PassThreatLegend onClose={() => setIsPassLegendDismissed(true)} />
      )}
      <div className="board-stage">
      <div ref={boardViewportRef} className="board-viewport">
        <div
          className="board-zoom-surface"
          style={{ width: `${zoomSurfacePercent}%`, height: `${zoomSurfacePercent}%` }}
        >
          <svg
            ref={svgRef}
            className={`tactics-board tool-${tool}`}
            viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
            preserveAspectRatio="xMidYMid meet"
            style={{
              aspectRatio: `${view.width} / ${view.height}`,
              width: `${boardRenderPercent}%`,
              maxHeight: `${boardRenderPercent}%`,
            }}
            role="application"
            aria-label="战术编辑球场"
            onPointerDown={onBoardPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={onLostPointerCapture}
          >
        <defs>
          <linearGradient id="pitchGradient" x1="0" x2="1">
            <stop offset="0" stopColor="#4f9368" />
            <stop offset="0.5" stopColor="#63aa78" />
            <stop offset="1" stopColor="#4f9368" />
          </linearGradient>
          <marker id="arrow-move" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#f5d58b" />
          </marker>
          <marker id="arrow-q" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#7de2f2" />
          </marker>
          <marker id="arrow-pass" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#f7f4df" />
          </marker>
          <marker id="arrow-shoot" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#ffba4a" />
          </marker>
          <marker id="arrow-note" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#d6c9ff" />
          </marker>
          <marker id="arrow-basic-blue" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#69d8f0" />
          </marker>
          <marker id="arrow-basic-red" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#ff795f" />
          </marker>
          <clipPath id="pitchClip"><rect x="0" y="0" width={fieldWidth} height={fieldHeight} rx="15" /></clipPath>
        </defs>

        <rect className="pitch" x="0" y="0" width={fieldWidth} height={fieldHeight} rx="15" fill="url(#pitchGradient)" />
        <g clipPath="url(#pitchClip)">
          {Array.from({ length: Math.ceil(rules.field.width) }, (_, index) => (
            <rect key={`stripe-${index}`} x={index * SCALE} y="0" width={SCALE} height={fieldHeight} className={index % 2 ? 'pitch-stripe alt' : 'pitch-stripe'} />
          ))}
          {Array.from({ length: Math.floor(rules.field.width) + 1 }, (_, index) => <line key={`vx-${index}`} x1={index * SCALE} x2={index * SCALE} y1="0" y2={fieldHeight} className="grid-line" />)}
          {Array.from({ length: Math.floor(rules.field.height) + 1 }, (_, index) => <line key={`hy-${index}`} x1="0" x2={fieldWidth} y1={index * SCALE} y2={index * SCALE} className="grid-line" />)}
          <circle cx="0" cy={fieldCenterY} r={rules.field.largePenaltyRadius * SCALE} className="zone zone-outer blue-zone" />
          <circle cx="0" cy={fieldCenterY} r={rules.field.smallPenaltyRadius * SCALE} className="zone zone-inner blue-zone" />
          <circle cx={fieldWidth} cy={fieldCenterY} r={rules.field.largePenaltyRadius * SCALE} className="zone zone-outer red-zone" />
          <circle cx={fieldWidth} cy={fieldCenterY} r={rules.field.smallPenaltyRadius * SCALE} className="zone zone-inner red-zone" />
        </g>
        <rect x="0" y="0" width={fieldWidth} height={fieldHeight} rx="15" className="pitch-border" />
        <line x1={fieldCenterX} x2={fieldCenterX} y1="0" y2={fieldHeight} className="field-mark" />
        <circle cx={fieldCenterX} cy={fieldCenterY} r="65" className="field-mark fill-none" />
        <circle cx={fieldCenterX} cy={fieldCenterY} r="4" className="center-dot" />
        <path d={`M0 ${fieldCenterY - 45} H-24 V${fieldCenterY + 45} H0`} className="goal-frame goal-blue" />
        <path d={`M${fieldWidth} ${fieldCenterY - 45} H${fieldWidth + 24} V${fieldCenterY + 45} H${fieldWidth}`} className="goal-frame goal-red" />
        <text x="12" y="20" className="field-label">蓝方球门</text>
        <text x={fieldWidth - 12} y="20" textAnchor="end" className="field-label">红方球门</text>

        {(showsSimulationAnalysis || isRangeInspectionTool(tool)) && selectedPlayer && (
          <g className="analysis-ranges" pointerEvents="none">
            {(showsSimulationAnalysis || tool === 'attack') && <>
              <circle
                cx={toSvg(selectedPlayer.position).x}
                cy={toSvg(selectedPlayer.position).y}
                r={rules.roles[selectedPlayer.role].attackRadius * SCALE}
                className="range-circle attack-range"
              />
              {rules.roles[selectedPlayer.role].attackInnerRadius !== undefined && (
                <circle
                  cx={toSvg(selectedPlayer.position).x}
                  cy={toSvg(selectedPlayer.position).y}
                  r={(rules.roles[selectedPlayer.role].attackInnerRadius ?? 0) * SCALE}
                  className="range-circle attack-inner-range"
                />
              )}
            </>}
            {tool === 'strikeRange' && (
              <circle
                cx={toSvg(selectedPlayer.position).x}
                cy={toSvg(selectedPlayer.position).y}
                r={(rules.roles[selectedPlayer.role].q.maxDistance + rules.roles[selectedPlayer.role].attackRadius) * SCALE}
                className="range-circle strike-range"
              >
                <title>Q 技能 + 攻击最大打击范围：{(rules.roles[selectedPlayer.role].q.maxDistance + rules.roles[selectedPlayer.role].attackRadius).toFixed(1)} 格</title>
              </circle>
            )}
            {showsSimulationAnalysis && <>
              <circle
                cx={toSvg(selectedPlayer.position).x}
                cy={toSvg(selectedPlayer.position).y}
                r={rules.roles[selectedPlayer.role].q.maxDistance * SCALE}
                className="range-circle q-range"
              />
              {selectedPlayer.hasBall && <>
                <circle cx={toSvg(selectedPlayer.position).x} cy={toSvg(selectedPlayer.position).y} r={rules.passing.safeDistance * SCALE} className="range-circle pass-safe-range" />
                <circle cx={toSvg(selectedPlayer.position).x} cy={toSvg(selectedPlayer.position).y} r={rules.passing.maxDistance * SCALE} className="range-circle pass-max-range" />
              </>}
            </>}
          </g>
        )}

        {tool !== 'select' && toolActor && (
          <ToolPointerPreview
            tool={tool}
            actor={toolActor}
            document={document}
          />
        )}

        {boardMode === 'simulation' && <g
          className="actions-layer actions-layer-background"
          pointerEvents={tool === 'select' ? undefined : 'none'}
        >
          {document.actions.filter((action) => action.id !== selectedAction?.id).map((action) => renderAction(action, false))}
        </g>}

        {boardMode === 'basic' && <g className="static-arrows-layer static-arrows-background">
          {document.staticMoveArrows
            .filter((arrow) => arrow.id !== selectedStaticArrow?.id)
            .map((arrow) => renderStaticArrow(arrow, false))}
        </g>}

        <g className="entities-layer">
        {frame.players.map((player) => {
          const position = playerPosition(player.id, player.position)
          const svgPoint = toSvg(position)
          const roleRule = rules.roles[player.role]
          const renderedFacing = drag?.kind === 'facing' && drag.playerId === player.id ? drag.facing : player.facing
          const facing = angleToVector(renderedFacing)
          const selected = selection?.kind === 'player' && selection.id === player.id
          const actorCandidate = isRangeInspectionTool(tool)
            || (tool !== 'select'
              && (!toolActor || tool === 'qMove')
              && isToolActorEligible(tool, player, frame, rules))
          const targetCandidate = tool !== 'select' && !isRangeInspectionTool(tool) && tool !== 'qMove' && toolActor
            ? isToolTargetPlayerEligible(tool, toolActor, player)
            : false
          const workflowDimmed = tool !== 'select' && !isRangeInspectionTool(tool) && toolNeedsActor(tool) && !selected && !actorCandidate && !targetCandidate && (!toolActor || tool === 'pass' || tool === 'qMove')
          const statuses = boardMode === 'basic' ? [] : frame.statuses.filter((status) => status.playerId === player.id)
          const cooldown = boardMode === 'basic' ? undefined : frame.cooldowns[player.id]
          const shot = boardMode === 'basic' ? undefined : frame.shots.find((candidate) => {
            if (candidate.actorId !== player.id || candidate.completed) return false
            const action = document.actions.find((item) => item.id === candidate.actionId)
            return action && currentTime <= action.startTime + action.duration
          })
          return (
            <g
              key={player.id}
              className={`player-token team-${player.team} ${selected ? 'selected' : ''} ${actorCandidate ? 'tool-eligible' : ''} ${targetCandidate ? 'tool-target-eligible' : ''} ${workflowDimmed ? 'tool-ineligible' : ''}`}
              transform={`translate(${svgPoint.x} ${svgPoint.y})`}
              onPointerDown={(event) => beginEntityDrag(event, player.id, position)}
              tabIndex={0}
              role="button"
              aria-label={`${player.name}，${roleRule.label}${isRangeInspectionTool(tool) ? `，可查看${toolLabels[tool].label}` : actorCandidate ? '，可选施法者' : targetCandidate ? '，可选目标' : ''}`}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (isRangeInspectionTool(tool)) {
                  chooseActor(player.id)
                } else if (tool === 'shoot') {
                  chooseActor(player.id)
                } else if (tool === 'move') {
                  if (!toolActor || toolActor.id === player.id) chooseActor(player.id)
                  else createAction(actionActor?.id ?? null, position, player.id)
                } else if (tool === 'qMove') {
                  chooseActor(player.id)
                } else if (tool !== 'select' && toolNeedsActor(tool) && !toolActor) {
                  chooseActor(player.id)
                } else if (tool !== 'select') {
                  createAction(actionActor?.id ?? null, position, player.id)
                } else {
                  select({ kind: 'player', id: player.id })
                }
              }}
            >
              {statuses.map((status, index) => <circle key={status.id} r={27 + index * 5} className={`status-ring status-${status.kind}`} />)}
              <circle r="22" className="token-shadow" />
              <circle r="20" className="token-body" />
              {boardMode === 'simulation' && <>
                <path d={`M 0 0 L ${facing.x * 31} ${facing.y * 31}`} className="facing-line" />
                <path d={`M ${facing.x * 31} ${facing.y * 31} l ${-facing.x * 7 - facing.y * 5} ${-facing.y * 7 + facing.x * 5} l ${facing.y * 10} ${-facing.x * 10} Z`} className="facing-head" />
              </>}
              <text y="6" textAnchor="middle" className="role-glyph">{roleRule.shortLabel}</text>
              <text y="39" textAnchor="middle" className="player-name">{player.name}</text>
              {boardMode === 'simulation' && player.hasBall && <circle cx="16" cy="-16" r="6" className="possession-dot" />}
              {(cooldown?.q ?? 0) > 0.05 && <g transform="translate(-27 -27)">
                <title>Q 剩余冷却 {cooldown?.q.toFixed(1)} 秒</title>
                <rect x="-4" y="-8" width="31" height="15" rx="7" className="cd-badge" />
                <text x="11.5" y="3" textAnchor="middle" className="cd-text">q {cooldown?.q.toFixed(1)}</text>
              </g>}
              {shot && <circle r="27" className={`charge-ring ${shot.interrupted ? 'interrupted' : ''}`} pathLength="1" strokeDasharray={`${shot.progress} 1`} />}
              {touchOptimized && <circle r="38" className="svg-touch-hit-area entity-touch-hit" />}
            </g>
          )
        })}

        {boardMode === 'simulation' && tool === 'select' && selectedPlayer && (() => {
          const position = playerPosition(selectedPlayer.id, selectedPlayer.position)
          const renderedFacing = drag?.kind === 'facing' && drag.playerId === selectedPlayer.id
            ? drag.facing
            : selectedPlayer.facing
          const facing = angleToVector(renderedFacing)
          const handle = {
            x: position.x * SCALE + facing.x * 39,
            y: position.y * SCALE + facing.y * 39,
          }
          const roundedFacing = Math.round(normalizeAngle(renderedFacing)) % 360
          return <g
            className={`facing-handle ${drag?.kind === 'facing' ? 'dragging' : ''}`}
            transform={`translate(${handle.x} ${handle.y})`}
            role="slider"
            tabIndex={0}
            aria-label={`调整${selectedPlayer.name}面向`}
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={roundedFacing}
            aria-valuetext={`${roundedFacing} 度`}
            onPointerDown={(event) => beginFacingDrag(event, selectedPlayer, position)}
            onKeyDown={(event) => {
              let nextFacing: number | null = null
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextFacing = renderedFacing - 1
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextFacing = renderedFacing + 1
              if (event.key === 'Home') nextFacing = 0
              if (event.key === 'End') nextFacing = 359
              if (nextFacing === null) return
              event.preventDefault()
              event.stopPropagation()
              setPlayerFacing(selectedPlayer.id, normalizeAngle(nextFacing))
            }}
          >
            <circle r={touchOptimized ? 24 : 16} className="facing-handle-hit" />
            <circle r="9" className="facing-handle-ring" />
            <circle r="3" className="facing-handle-dot" />
          </g>
        })()}

        {boardMode === 'simulation' && <g
          className={`ball-token ${frame.ball.isFree ? 'free' : ''}`}
          transform={`translate(${ballPosition.x * SCALE} ${ballPosition.y * SCALE})`}
          onPointerDown={(event) => beginEntityDrag(event, 'ball', ballPosition)}
          tabIndex={0}
          role="button"
          aria-label="足球"
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (tool === 'select') {
              select({ kind: 'ball', id: 'ball' })
            } else if (tool === 'shoot') {
              setNotice('射门只需选择一名球员。')
            } else if (toolNeedsActor(tool) && !toolActor) {
              setNotice(actorPrompt(tool))
            } else {
              createAction(actionActor?.id ?? null, ballPosition)
            }
          }}
        >
          <circle r="11" className="ball-shadow" />
          <circle r="9" className="ball-body" />
          <path d="M0 -4 L4 -1 L3 4 L-3 4 L-4 -1 Z" className="ball-mark" />
          {touchOptimized && <circle r="26" className="svg-touch-hit-area entity-touch-hit" />}
        </g>}
        </g>

        {boardMode === 'simulation' && selectedAction && <g className="actions-layer selected-action-layer">
          {renderAction(selectedAction, true)}
        </g>}
        {boardMode === 'basic' && selectedStaticArrow && <g className="static-arrows-layer selected-static-arrow-layer">
          {renderStaticArrow(selectedStaticArrow, true)}
        </g>}
          </svg>
        </div>
      </div>
      <div className="board-zoom-controls" role="group" aria-label="球场缩放">
        <button
          type="button"
          onClick={() => changeBoardZoom(-1)}
          disabled={boardZoom <= BOARD_ZOOM_MIN}
          aria-label="缩小球场"
          title="缩小球场"
        >−</button>
        <button
          type="button"
          className="board-zoom-value"
          onClick={() => setBoardZoom(1)}
          disabled={boardZoom === 1}
          aria-label="重置球场缩放为 100%"
          title="重置为 100%"
        >{zoomPercent}%</button>
        <button
          type="button"
          onClick={() => changeBoardZoom(1)}
          disabled={boardZoom >= BOARD_ZOOM_MAX}
          aria-label="放大球场"
          title="放大球场"
        >＋</button>
      </div>
      {tool !== 'select' && <div className="board-workflow-guide" role="status">
        <span className="guide-step">{isRangeInspectionTool(tool) ? '范围查看' : tool === 'shoot' || tool === 'eZone' || tool === 'wait' ? '1 / 1' : toolActor || !toolNeedsActor(tool) ? '2 / 2' : '1 / 2'}</span>
        <span><strong>{boardMode === 'basic' ? basicToolName : toolLabels[tool].label}</strong>{boardMode === 'basic' ? basicToolPrompt : tool === 'shoot' || tool === 'eZone' || tool === 'wait' ? actorPrompt(tool) : isRangeInspectionTool(tool) ? (toolActor ? targetPrompt(tool) : actorPrompt(tool)) : toolActor || !toolNeedsActor(tool) ? targetPrompt(tool) : actorPrompt(tool)}</span>
        <span className="guide-actions">
          {boardMode === 'simulation' && toolActor && (tool === 'move' || tool === 'qMove') && <button
            type="button"
            className="guide-back-button"
            onClick={reselectToolActor}
            aria-label="返回第 1/2 步重新选择球员"
          >← 重选球员</button>}
          <kbd>Esc 取消</kbd>
        </span>
      </div>}
      {boardMode === 'basic' && selectedStaticArrow && <button className="static-arrow-delete" onClick={() => deleteStaticMoveArrow(selectedStaticArrow.id)}>删除所选箭头</button>}
      <div className="board-scale"><span />1 格 ≈ 基础移动 1 秒</div>
      <div className="board-hint">
        {boardMode === 'basic'
          ? tool === 'select'
            ? '拖动球员调整站位 · 选择球员后使用“移动箭头” · 点击箭头可编辑或删除'
            : basicToolPrompt
          : tool === 'select' ? '非播放状态只停在动作节点 · 拖动节点球员可联动前后路径' : tool === 'shoot' || tool === 'eZone' || tool === 'wait' ? actorPrompt(tool) : isRangeInspectionTool(tool) ? (toolActor ? targetPrompt(tool) : actorPrompt(tool)) : toolActor || !toolNeedsActor(tool) ? targetPrompt(tool) : actorPrompt(tool)}
      </div>
      </div>
    </div>
  )
}

function ShotPressureLabel({
  path,
  evaluation,
}: {
  path: Vec2[]
  evaluation: NonNullable<ReturnType<typeof evaluateShotActionPressure>>
}) {
  const anchor = pointAlongPath(path, 0.52)
  return <g className={`shot-pressure-label ${evaluation.isRisk ? 'risk' : 'safe'}`} pointerEvents="none">
    <rect x={anchor.x * SCALE - 91} y={anchor.y * SCALE - 30} width="182" height="17" rx="6" />
    <text x={anchor.x * SCALE} y={anchor.y * SCALE - 19} textAnchor="middle">{shotPressureSummary(evaluation)}</text>
  </g>
}

function ToolPointerPreview({
  tool,
  actor,
  document,
}: {
  tool: ToolId
  actor: PlayerState
  document: TacticDocumentV1
}) {
  const rules = document.rulesSnapshot
  const origin = actor.position

  if (tool === 'qMove') {
    return <g className="tool-preview-layer" pointerEvents="none">
      <circle cx={origin.x * SCALE} cy={origin.y * SCALE} r={rules.roles[actor.role].q.maxDistance * SCALE} className="tool-preview-range q-preview-range" />
    </g>
  }

  if (tool === 'pass') {
    return <g className="tool-preview-layer" pointerEvents="none">
      <circle cx={origin.x * SCALE} cy={origin.y * SCALE} r={rules.passing.safeDistance * SCALE} className="tool-preview-range pass-preview-safe" />
      <circle cx={origin.x * SCALE} cy={origin.y * SCALE} r={rules.passing.maxDistance * SCALE} className="tool-preview-range pass-preview-max" />
    </g>
  }

  return null
}

function PassThreatLines({
  path,
  passerId,
  frame,
  rules,
  markerEnd,
}: {
  path: Vec2[]
  passerId: string
  frame: ProjectedFrame
  rules: RuleSetV1
  markerEnd: string
}) {
  const passer = frame.players.find((player) => player.id === passerId)
  if (!passer) return null
  const segments = classifyPassThreat(path, passer.team, frame, rules)
  return <>{segments.map((segment, index) => (
    <polyline
      key={`${segment.startDistance}-${segment.endDistance}-${segment.level}`}
      points={pointsAttribute(segment.path)}
      className={`action-path action-pass pass-threat-segment threat-${segment.level}`}
      markerEnd={index === segments.length - 1 ? markerEnd : undefined}
      data-threat={segment.level}
    >
      <title>{PASS_THREAT_LABELS[segment.level]} · {segment.startDistance.toFixed(1)}–{segment.endDistance.toFixed(1)} 格</title>
    </polyline>
  ))}</>
}

function PassThreatLegend({ onClose }: { onClose: () => void }) {
  return <section className="pass-threat-legend" aria-label="传球威胁图例">
    <div className="pass-threat-legend-items">
      {PASS_THREAT_ORDER.map((level) => <span className="pass-threat-legend-item" key={level}><i className={`threat-${level}`} />{PASS_THREAT_LABELS[level]}</span>)}
    </div>
    <button type="button" onClick={onClose} aria-label="关闭传球威胁图例" title="关闭图例">×</button>
  </section>
}

function WaterBoostRoute({
  effect,
}: {
  effect: NonNullable<ReturnType<typeof waterQMoveBoost>>
}) {
  return <g className="water-boost-route" pointerEvents="none" data-source-action-id={effect.sourceActionId}>
    <polyline points={pointsAttribute(effect.path)} className="water-q-boost-segment">
      <title>水 Q 加速段，累计身位收益 {effect.separationGain.toFixed(2)} 格</title>
    </polyline>
  </g>
}

function ReceiveBoostRoute({
  effect,
}: {
  effect: NonNullable<ReturnType<typeof receiveMoveBoost>>
}) {
  return <g className="receive-boost-route" pointerEvents="none" data-source-action-id={effect.sourceActionId}>
    <polyline points={pointsAttribute(effect.path)} className="ice-receive-boost-segment">
      <title>冰接球加速段，累计身位收益 {effect.separationGain.toFixed(2)} 格</title>
    </polyline>
  </g>
}

function EZoneSlowRoute({
  segments,
}: {
  segments: ReturnType<typeof eZoneSlowSegmentsForMove>
}) {
  return <g className="e-zone-slow-route" pointerEvents="none">
    {segments.map((segment, index) => <polyline
      key={`${segment.startTime}-${segment.endTime}-${index}`}
      points={pointsAttribute(segment.path)}
      className="e-zone-slow-segment"
      data-slow-multiplier={segment.multiplier}
    >
      <title>敌方冰圈减速段 · 移速 {segment.multiplier.toFixed(2)}×</title>
    </polyline>)}
  </g>
}

function StatusSlowRoute({
  segments,
}: {
  segments: ReturnType<typeof statusSlowSegmentsForMove>
}) {
  return <g className="status-slow-route" pointerEvents="none">
    {segments.map((segment, index) => <polyline
      key={`${segment.startTime}-${segment.endTime}-${index}`}
      points={pointsAttribute(segment.path)}
      className="status-slow-segment"
    >
      <title>挂冰减速段 · 普通跑动按累计身位损失结算</title>
    </polyline>)}
  </g>
}

function PassAnalysis({ path, document }: { path: Vec2[]; document: TacticDocumentV1 }) {
  const fullLength = pathLength(path)
  if (fullLength <= document.rulesSnapshot.passing.safeDistance) return null
  const start = pointAlongPath(path, document.rulesSnapshot.passing.safeDistance / fullLength)
  const end = pointAlongPath(path, Math.min(1, document.rulesSnapshot.passing.maxDistance / fullLength))
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy) || 1
  const nx = -dy / length
  const ny = dx / length
  const startWidth = document.rulesSnapshot.passing.interceptStartWidth
  const endWidth = document.rulesSnapshot.passing.interceptEndWidth
  const polygon = [
    { x: start.x + nx * startWidth, y: start.y + ny * startWidth },
    { x: end.x + nx * endWidth, y: end.y + ny * endWidth },
    { x: end.x - nx * endWidth, y: end.y - ny * endWidth },
    { x: start.x - nx * startWidth, y: start.y - ny * startWidth },
  ]
  return <>
    <polygon points={pointsAttribute(polygon)} className="intercept-cone">
      <title>传球截断风险区 · 全长 {fullLength.toFixed(1)} 格</title>
    </polygon>
  </>
}

function QAnalysis({ action, document, scale }: { action: Extract<TacticAction, { type: 'qMove' }>; document: TacticDocumentV1; scale: number }) {
  const actor = document.initialScene.players.find((player) => player.id === action.actorId)
  const renderedPath = effectiveQPath(document, action)
  const end = renderedPath[renderedPath.length - 1]
  const beforeEnd = renderedPath[renderedPath.length - 2]
  if (!actor || !end || !beforeEnd) return null
  const rule = document.rulesSnapshot.roles[actor.role]
  // Water's gain is drawn on the real overlapping move route below, not as a
  // hypothetical straight extension from the Q endpoint.
  const gain = rule.receiveBoost?.netSeparationGain
  const freeze = rule.q.freezeDuration
  const hits = actor.role === 'ice' ? analyzeDocumentIceQHits(document, action) : []
  let extension: Vec2 | null = null
  if (gain) {
    const dx = end.x - beforeEnd.x
    const dy = end.y - beforeEnd.y
    const length = Math.hypot(dx, dy) || 1
    extension = { x: end.x + (dx / length) * gain, y: end.y + (dy / length) * gain }
  }
  return <>
    {extension && <line x1={end.x * scale} y1={end.y * scale} x2={extension.x * scale} y2={extension.y * scale} className="separation-extension">
      <title>{rule.afterQBoost ? 'Q 后加速' : '接球加速'} · 身位收益 {gain?.toFixed(1)} 格</title>
    </line>}
    {freeze && hits.map((hit) => <g key={hit.targetId} className="ice-q-hit" data-target-id={hit.targetId}>
      <circle cx={hit.closestPoint.x * scale} cy={hit.closestPoint.y * scale} r={rule.attackRadius * scale} className="ice-q-hit-radius">
        <title>命中 {hit.target.name} @{hit.hitTime.toFixed(2)} 秒 · 冻结 {freeze} 秒 · 后退 {rule.q.facingKnockback} 格</title>
      </circle>
    </g>)}
  </>
}
