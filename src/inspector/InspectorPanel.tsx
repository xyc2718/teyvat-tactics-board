import { useCallback, useMemo, useState } from 'react'
import { normalizeAngle, pathLength } from '../domain/geometry/geometry'
import type { MoveAction, RoleId, TacticDocumentV1, TimingTargetReference, WaitAction } from '../domain/model/types'
import { passIsDropped, passIsReceived } from '../domain/model/passFlight'
import { evaluateWarnings } from '../domain/rules/evaluateRules'
import { ROLE_IDS } from '../domain/rules/defaultRules'
import { analyzeActionGeoShield, geoShieldPassSummary, geoShieldShotSummary } from '../domain/rules/geoShield'
import { evaluatePlayerSituation, type BallArrival } from '../domain/rules/playerSituation'
import {
  evaluateShotActionPressure,
  shotPressureComparison,
  shotPressureModeLabel,
  shotPressureSummary,
} from '../domain/rules/shotPressure'
import { projectedMovePath, projectFrameAtKeyframe } from '../domain/timeline/projectFrame'
import { resolveTimingKeyframe } from '../domain/timeline/timingKeyframes'
import { findMoveQCooldownTarget, resolveMoveQCooldownTarget } from '../domain/timeline/moveTiming'
import { useTacticStore } from '../editor/useTacticStore'
import { actionLabel, matchupLabel, playerRoleLabel } from '../ui/labels'
import { TimingKeyframeDialog } from './TimingKeyframeDialog'

export function InspectorPanel() {
  const document = useTacticStore((state) => state.document)
  const currentTime = useTacticStore((state) => state.currentTime)
  const currentKeyframe = useTacticStore((state) => state.currentKeyframe)
  const selection = useTacticStore((state) => state.selection)
  const showAdvancedTimeline = useTacticStore((state) => state.showAdvancedTimeline)
  const frame = useMemo(
    () => projectFrameAtKeyframe(document, currentTime, currentKeyframe),
    [currentKeyframe, currentTime, document],
  )
  const selectedPlayer = selection?.kind === 'player'
    ? frame.players.find((player) => player.id === selection.id)
    : undefined
  const selectedAction = selection?.kind === 'action'
    ? document.actions.find((action) => action.id === selection.id)
    : undefined
  const latestPlayerMove = selectedPlayer
    ? document.actions
        .filter((action): action is MoveAction => action.type === 'move' && action.actorId === selectedPlayer.id)
        .sort((left, right) => (
          left.startTime + left.duration - (right.startTime + right.duration)
          || left.startTime - right.startTime
        ))
        .at(-1)
    : undefined
  const selectedShotPressure = useMemo(
    () => selectedAction?.type === 'shoot' ? evaluateShotActionPressure(document, selectedAction) : null,
    [document, selectedAction],
  )
  const selectedGeoShield = useMemo(() => selectedAction && (selectedAction.type === 'pass' || selectedAction.type === 'loosePass' || selectedAction.type === 'shoot')
    ? analyzeActionGeoShield(document, selectedAction)
    : null, [document, selectedAction])
  const selectedQActor = selectedAction?.type === 'qMove'
    ? document.initialScene.players.find((player) => player.id === selectedAction.actorId)
    : undefined
  const selectedQRule = selectedQActor ? document.rulesSnapshot.roles[selectedQActor.role].q : undefined
  const selectedPathLength = useMemo(() => selectedAction && 'path' in selectedAction
    ? pathLength(selectedAction.type === 'move' ? projectedMovePath(document, selectedAction) : selectedAction.path)
    : null, [document, selectedAction])
  const selectedPickup = selectedAction && (selectedAction.type === 'move' || selectedAction.type === 'qMove') && selectedAction.ballTarget
    ? document.actions.find((action) => action.type === 'receive' && action.pickupActionId === selectedAction.id)
    : undefined
  const warnings = useMemo(() => evaluateWarnings(document), [document])
  const setRole = useTacticStore((state) => state.setPlayerRole)
  const setTeam = useTacticStore((state) => state.setPlayerTeam)
  const setFacing = useTacticStore((state) => state.setPlayerFacing)
  const givePossession = useTacticStore((state) => state.givePossession)
  const updateTiming = useTacticStore((state) => state.updateActionTiming)
  const setMovePathMode = useTacticStore((state) => state.setMovePathMode)
  const setShotCharge = useTacticStore((state) => state.setShotCharge)
  const deleteAction = useTacticStore((state) => state.deleteAction)
  const select = useTacticStore((state) => state.select)

  const playerSituation = useMemo(
    () => selectedPlayer ? evaluatePlayerSituation(document, currentTime, selectedPlayer.id) : null,
    [currentTime, document, selectedPlayer],
  )
  const contextualWarnings = warnings.filter((warning) => {
    if (selection?.kind === 'action') return warning.actionId === selection.id
    if (selection?.kind === 'player') return warning.playerIds?.includes(selection.id)
    return true
  })
  const selectedPlayerIsCarrier = selectedPlayer?.id === frame.ball.carrierId

  return (
    <aside id="inspector-panel" className="inspector-panel panel-surface">
      <div className="panel-heading inspector-heading">
        <div><span className="eyebrow">检查器</span><h2>{selectedPlayer ? selectedPlayer.name : selectedAction ? actionLabel(selectedAction) : '战术提示'}</h2></div>
        <span className="time-chip">{currentTime.toFixed(2)}s</span>
      </div>

      {selectedPlayer && (
        <div className="inspector-content">
          <section className="inspector-section">
            <h3>角色状态</h3>
            <label className="field-row"><span>职业</span>
              <select value={selectedPlayer.role} onChange={(event) => setRole(selectedPlayer.id, event.target.value as RoleId)}>
                {ROLE_IDS.map((role) => <option key={role} value={role}>{document.rulesSnapshot.roles[role].label}</option>)}
              </select>
            </label>
            <label className="field-row"><span>队伍</span>
              <select value={selectedPlayer.team} onChange={(event) => setTeam(selectedPlayer.id, event.target.value as 'blue' | 'red')}>
                <option value="blue">蓝方 · 向右进攻</option><option value="red">红方 · 向左进攻</option>
              </select>
            </label>
            <FacingEditor
              playerName={selectedPlayer.name}
              facing={selectedPlayer.facing}
              onChange={(facing) => setFacing(selectedPlayer.id, facing)}
            />
            <button className={`possession-button ${selectedPlayerIsCarrier ? 'active' : ''}`} onClick={() => givePossession(selectedPlayerIsCarrier ? null : selectedPlayer.id)}>
              <span className="mini-ball" />{selectedPlayerIsCarrier ? '放下球权' : '设为持球者'}
            </button>
            <div className="metric-grid">
              <Metric label="Q 剩余" value={`${(frame.cooldowns[selectedPlayer.id]?.q ?? 0).toFixed(1)}s`} />
              {document.rulesSnapshot.roles[selectedPlayer.role].e && <Metric label="E 剩余" value={`${(frame.cooldowns[selectedPlayer.id]?.e ?? 0).toFixed(1)}s`} />}
              <Metric label="攻击半径" value={`${document.rulesSnapshot.roles[selectedPlayer.role].attackRadius} 格`} />
              <Metric label="Q 距离" value={`${document.rulesSnapshot.roles[selectedPlayer.role].q.maxDistance} 格`} />
              {selectedPlayer.role === 'geo' && document.rulesSnapshot.roles.geo.shield && <Metric label="护罩半径" value={`${document.rulesSnapshot.roles.geo.shield.radius} 格`} />}
              <Metric label="坐标" value={`${selectedPlayer.position.x.toFixed(1)}, ${selectedPlayer.position.y.toFixed(1)}`} />
            </div>
          </section>
          {latestPlayerMove && !latestPlayerMove.targetPlayerId && !latestPlayerMove.ballTarget && <section className="inspector-section latest-move-editor">
            <div className="section-title-row">
              <h3>最后一段跑动</h3>
              <span>{latestPlayerMove.startTime.toFixed(2)}–{(latestPlayerMove.startTime + latestPlayerMove.duration).toFixed(2)}s</span>
            </div>
            <MovePathModeButtons
              curved={Boolean(latestPlayerMove.curveControl)}
              onChange={(mode) => {
                setMovePathMode(latestPlayerMove.id, mode)
                select({ kind: 'action', id: latestPlayerMove.id })
              }}
            />
            <p className="callout">选择曲线后会选中这段跑动；拖动球场上的青色控制点即可调整弧度。</p>
          </section>}
          {playerSituation?.kind === 'matchup' && <section className="inspector-section matchup-card">
            <div className="section-title-row"><h3>最近对位</h3><span className={`rating rating-${playerSituation.evaluation.final ?? 'none'}`}>{matchupLabel(playerSituation.evaluation.final)}</span></div>
            <p className="matchup-route">{document.rulesSnapshot.roles[playerSituation.attacker.role].shortLabel} 进攻 → {document.rulesSnapshot.roles[playerSituation.defender.role].shortLabel} 防守</p>
            <p className="subtle">{teamLabel(playerSituation.offenseTeam)}{playerSituation.possessionSource === 'carrier' ? '持球' : '传球中'} · {selectedPlayer.name}处于{playerSituation.selectedPerspective === 'attacking' ? '进攻方' : '防守方'}</p>
            <p className="subtle">进攻方视角基础：{matchupLabel(playerSituation.evaluation.base)} · 对手 {playerSituation.opponent.name}</p>
            {playerSituation.evaluation.appliedModifiers.length > 0 && <div className="modifier-list">{playerSituation.evaluation.appliedModifiers.map((modifier) => <span key={modifier.id}>{modifier.delta > 0 ? '+' : ''}{modifier.delta} {modifier.label}</span>)}</div>}
            <details><summary>客观依据</summary><ul>{playerSituation.evaluation.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></details>
          </section>}
          {playerSituation?.kind === 'looseBall' && <section className="inspector-section matchup-card loose-ball-card">
            <div className="section-title-row"><h3>地面自由球争抢</h3><span className={`rating contest-${playerSituation.outcome}`}>{contestOutcomeLabel(playerSituation.outcome, playerSituation.margin)}</span></div>
            <p className="matchup-route">{playerSituation.selectedArrival.player.name} ↔ {playerSituation.opponentArrival.player.name}</p>
            <p className="subtle">{arrivalSummary(playerSituation.selectedArrival)} · {arrivalSummary(playerSituation.opponentArrival)}</p>
            <details><summary>客观依据</summary><ul>
              <li>{playerSituation.selectedArrival.player.name}距球 {playerSituation.selectedArrival.ballDistance.toFixed(2)} 格，Q 剩余 {playerSituation.selectedArrival.qCooldownAtStart.toFixed(2)}s</li>
              <li>{playerSituation.opponentArrival.player.name}距球 {playerSituation.opponentArrival.ballDistance.toFixed(2)} 格，Q 剩余 {playerSituation.opponentArrival.qCooldownAtStart.toFixed(2)}s</li>
              <li>按当前站位、冻结、基础移速及 Q 距离/用时/CD 估算，不含反应时间</li>
            </ul></details>
          </section>}
        </div>
      )}

      {selectedAction && (
        <div className="inspector-content">
          <section className="inspector-section">
            <div className="action-kind"><span className={`action-dot type-${selectedAction.type}`} />{actionLabel(selectedAction)}</div>
            {showAdvancedTimeline
              ? <>
                  <label className="field-row"><span>开始时间</span><NumberInput value={selectedAction.startTime} step={0.1} disabled={selectedAction.type === 'receive' && Boolean(selectedAction.sourceActionId || selectedAction.pickupActionId)} onChange={(value) => updateTiming(selectedAction.id, 'startTime', value)} suffix="s" /></label>
                  <label className="field-row"><span>持续时间</span><NumberInput value={selectedAction.duration} step={0.1} disabled={(selectedAction.type === 'receive' && Boolean(selectedAction.sourceActionId || selectedAction.pickupActionId)) || selectedAction.type === 'loosePass' || (selectedAction.type === 'pass' && Boolean(selectedAction.targetPlayerId)) || (selectedAction.type === 'wait' && Boolean(selectedAction.timingConstraint)) || (selectedAction.type === 'move' && (Boolean(selectedAction.targetPlayerId || selectedAction.ballTarget) || selectedAction.timingConstraint?.kind === 'keyframe' || selectedAction.timingConstraint?.kind === 'qCooldown'))} onChange={(value) => updateTiming(selectedAction.id, 'duration', value)} suffix="s" /></label>
                </>
              : <>
                  <div className="inline-info"><span>开始节点</span><strong>{selectedAction.startTime.toFixed(2)}s</strong></div>
                  {selectedAction.type === 'wait'
                    ? <label className="field-row"><span>等待时长</span><NumberInput value={selectedAction.duration} step={0.1} disabled={Boolean(selectedAction.timingConstraint)} onChange={(value) => updateTiming(selectedAction.id, 'duration', value)} suffix="s" /></label>
                    : <div className="inline-info"><span>动作时长</span><strong>{selectedAction.duration.toFixed(2)}s</strong></div>}
                </>}
            {selectedPathLength !== null && <div className="inline-info"><span>路径长度</span><strong>{selectedPathLength.toFixed(2)} 格</strong></div>}
            {selectedAction.type === 'move' && !selectedAction.targetPlayerId && !selectedAction.ballTarget && <MovePathModeButtons
              curved={Boolean(selectedAction.curveControl)}
              onChange={(mode) => setMovePathMode(selectedAction.id, mode)}
            />}
            {selectedAction.type === 'move' && !selectedAction.targetPlayerId && !selectedAction.ballTarget && <MoveTimingEditor
              key={selectedAction.id}
              action={selectedAction}
              document={document}
            />}
            {selectedAction.type === 'wait' && selectedAction.actorId && <WaitTimingEditor key={selectedAction.id} action={selectedAction} document={document} />}
            {selectedAction.type === 'move' && !selectedAction.targetPlayerId && !selectedAction.ballTarget && selectedAction.curveControl && <p className="callout">拖动球场上的青色曲线控制点调整弧度；{selectedAction.timingConstraint ? '结束时间不变，距离按沿途实际速度更新。' : '动作时长会随曲线长度自动更新。'}</p>}
            {selectedAction.type === 'move' && selectedAction.targetPlayerId && <p className="callout">贴身跟随 {document.initialScene.players.find((player) => player.id === selectedAction.targetPlayerId)?.name ?? selectedAction.targetPlayerId}；结束时间同步目标动作，追上后保持约 {selectedAction.followGap?.toFixed(2)} 格攻击间距。</p>}
            {selectedAction.type === 'qMove' && <p className="callout">{selectedQRule?.fixedDistance
              ? `拖动白色控制点调整方向；Q 固定 ${selectedQRule.maxDistance} 格，仅在球场边界截短。`
              : '拖动球场上的白色控制点，可缩短或弯曲路径；路径会自动限制在职业 Q 最大距离内。'}</p>}
            {(selectedAction.type === 'move' || selectedAction.type === 'qMove') && selectedAction.ballTarget && <div className="pickup-constraint-card">
              <strong>{selectedAction.type === 'qMove' ? 'Q 穿球约束' : '追踪自由球'}</strong>
              <p>{selectedPickup
                ? `捡球时刻 ${selectedPickup.startTime.toFixed(3)}s，球从接触时开始跟随。`
                : '当前动作未能捡到目标球，请调整动作或上游球路。'}</p>
              <p>{selectedAction.type === 'qMove'
                ? 'Q 捡球后继续完成位移。调整冰 Q 长度仍须途中接到球，不满足时保留上一次有效路径。'
                : '路径与时长由球的飞行轨迹和角色实际移速解算；不能同时设置固定时长或贴身跟随。'}</p>
            </div>}
            {selectedAction.type === 'shoot' && <label className="field-row"><span>蓄力等级</span>
              <select value={selectedAction.charge} onChange={(event) => setShotCharge(selectedAction.id, event.target.value as 'yellow' | 'red')}><option value="yellow">黄色蓄力</option><option value="red">红色满蓄</option></select>
            </label>}
            {selectedAction.type === 'shoot' && selectedShotPressure && <ShotPressureCard evaluation={selectedShotPressure} />}
            {selectedGeoShield?.shot && <div className="geo-shield-card" aria-label="岩护罩射门提示">
              <strong>{geoShieldShotSummary(selectedGeoShield.shot)}</strong>
              <small>从射门开始时刻估算；独立于最早受击窗口，不自动判定挡球。</small>
            </div>}
            {selectedAction.type === 'pass' && <p className="callout">
              {selectedAction.targetPlayerId ? '球持续朝接球者当前位置转向；' : ''}
              {passIsDropped(selectedAction, document.rulesSnapshot)
                ? '未接到：已耗尽飞行距离，球在达到距离上限的位置落地，不产生接球或接球加速。'
                : passIsReceived(selectedAction, document.rulesSnapshot)
                  ? `接球时刻 ${(selectedAction.startTime + selectedAction.duration).toFixed(2)}s。`
                  : '到达指定落点后成为自由球。'}
              {' '}按实际路线累计距离计算，≤ {document.rulesSnapshot.passing.safeDistance} 格免疫普通截球，但仍可能被岩护罩阻挡；最多飞行 {document.rulesSnapshot.passing.maxDistance} 格。
            </p>}
            {selectedAction.type === 'receive' && selectedAction.sourceActionId && <p className="callout">此接球节点由对应传球自动生成，时间随传球起点和接球队员轨迹更新。</p>}
            {selectedAction.type === 'receive' && selectedAction.pickupActionId && <p className="callout">此捡球节点由跑动或 Q 与球的实际接触自动生成，时间不可直接修改。跳到该节点后可立即传球。</p>}
            {selectedAction.type === 'loosePass' && <p className="callout">按指定方向飞行，撞墙反弹不重置速度或剩余路程。{selectedAction.flightOutcome === 'pickedUp' ? '球已在途中被捡起，飞行在接触时刻结束；之后随持球者移动。' : selectedAction.flightOutcome === 'goal' ? '球进入球门后停止。' : '飞行结束后停在终点，等待跑动或 Q 捡球。'}空传不使用普通传球的安全区判定。</p>}
            {selectedGeoShield && selectedGeoShield.passSegments.length > 0 && <div className="geo-shield-card" aria-label="岩护罩传球提示">
              <strong>{geoShieldPassSummary(selectedGeoShield.passSegments, document.initialScene.players)}</strong>
              <small>蓝色实线：原地护罩；蓝紫虚线：跑动 / Q 可达护罩。冻结时仍可原地挡球；提示不会自动改变球权。</small>
            </div>}
            <button className="danger-button" onClick={() => { deleteAction(selectedAction.id); select(null) }}>删除动作</button>
          </section>
        </div>
      )}

      {!selectedPlayer && !selectedAction && <div className="empty-inspector">
        <div className="empty-graphic"><span>↝</span><span>⇢</span><span>◉</span></div>
        <h3>从站位开始</h3>
        <p>拖动球员调整站位，或选中球员后使用顶部工具绘制动作。</p>
        <ol><li>选择球员</li><li>选择跑动、Q、传球或射门</li><li>点击球场目标点</li></ol>
      </div>}

      <section className="warnings-section">
        <div className="section-title-row"><h3>规则提示</h3><span className="warning-count">{warnings.length}</span></div>
        {contextualWarnings.length === 0 ? <div className="all-clear"><span>✓</span>当前选择没有规则冲突</div> : (
          <div className="warning-list">
            {contextualWarnings.slice(0, 5).map((warning) => (
              <button key={warning.id} className={`warning-item severity-${warning.severity}`} onClick={() => warning.actionId && select({ kind: 'action', id: warning.actionId })}>
                <span className="warning-icon">{warning.severity === 'hard' ? '!' : warning.severity === 'warning' ? '△' : 'i'}</span>
                <span><strong>{warning.title}</strong><small>{warning.detail}</small></span>
              </button>
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><small>{label}</small><strong>{value}</strong></div>
}

function MovePathModeButtons({
  curved,
  onChange,
}: {
  curved: boolean
  onChange: (mode: 'straight' | 'curve') => void
}) {
  return <div className="move-path-mode" role="group" aria-label="跑动路径类型">
    <button className={!curved ? 'active' : ''} aria-pressed={!curved} onClick={() => onChange('straight')}>直线</button>
    <button className={curved ? 'active' : ''} aria-pressed={curved} onClick={() => onChange('curve')}>可调曲线</button>
  </div>
}

function MoveTimingEditor({
  action,
  document,
}: {
  action: MoveAction
  document: TacticDocumentV1
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const closeDialog = useCallback(() => setDialogOpen(false), [])
  const setMoveTimingFixed = useTacticStore((state) => state.setMoveTimingFixed)
  const setMoveTimingKeyframe = useTacticStore((state) => state.setMoveTimingKeyframe)
  const setMoveTimingQCooldown = useTacticStore((state) => state.setMoveTimingQCooldown)
  const updateTiming = useTacticStore((state) => state.updateActionTiming)
  const timingFixed = Boolean(action.timingConstraint)
  const keyframe = action.timingConstraint?.kind === 'keyframe'
    ? action.timingConstraint.reference
    : null
  const qBound = action.timingConstraint?.kind === 'qCooldown'
  const qTarget = useMemo(() => findMoveQCooldownTarget(document, action), [document, action])
  const boundQTarget = useMemo(() => resolveMoveQCooldownTarget(document, action), [document, action])
  const sourceQ = useMemo(() => boundQTarget
    ? document.actions.find((candidate) => candidate.id === boundQTarget.sourceActionId)
    : undefined, [boundQTarget, document])
  const unavailableReason = '这段跑动开始时没有尚未结束的 Q 冷却。'

  return <div className="move-timing-editor">
    <label className="move-timing-toggle">
      <input
        type="checkbox"
        checked={timingFixed}
        onChange={(event) => setMoveTimingFixed(action.id, event.target.checked)}
      />
      <span><strong>固定跑动时间</strong><small>按时长、关键帧或 Q 冷却确定结束时刻</small></span>
    </label>
    {timingFixed && <div className="move-timing-controls">
      <label className="field-row">
        <span>持续时间</span>
        <NumberInput
          value={action.duration}
          step={0.1}
          disabled={Boolean(keyframe) || qBound}
          onChange={(value) => updateTiming(action.id, 'duration', value)}
          suffix="s"
        />
      </label>
      {keyframe && <TimingReferenceSummary reference={keyframe} document={document} />}
      {qBound && boundQTarget && <div className="timing-reference-summary">
        <span>对齐自身 Q 冷却结束</span>
        {sourceQ && <span>Q 释放 · {sourceQ.startTime.toFixed(2)}s</span>}
        <strong>Q 冷却结束 · {boundQTarget.readyTime.toFixed(2)}s</strong>
      </div>}
      <div className="move-timing-actions">
        <button
          type="button"
          className="quiet-button"
          aria-pressed={qBound}
          disabled={!qTarget && !qBound}
          title={!qTarget && !qBound ? unavailableReason : undefined}
          onClick={() => setMoveTimingQCooldown(action.id)}
        >跑到 Q 冷却结束</button>
        <button type="button" className="quiet-button" onClick={() => setDialogOpen(true)}>
          {keyframe ? '更换关键帧' : '选择关键帧'}
        </button>
        {(keyframe || qBound) && <button type="button" className="quiet-button" onClick={() => setMoveTimingFixed(action.id, true)}>改为手动时间</button>}
      </div>
      {!qTarget && !qBound && <p className="subtle">{unavailableReason}</p>}
      <p className="callout">结束时间固定，跑动距离按实际加速、减速计算；调整方向或曲线后会重新计算可达位置。</p>
    </div>}
    {dialogOpen && <TimingKeyframeDialog
      action={action}
      document={document}
      onClose={closeDialog}
      onSelect={(reference) => {
        setMoveTimingKeyframe(action.id, reference)
        setDialogOpen(false)
      }}
    />}
  </div>
}

function WaitTimingEditor({ action, document }: { action: WaitAction; document: TacticDocumentV1 }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const closeDialog = useCallback(() => setDialogOpen(false), [])
  const setWaitTimingKeyframe = useTacticStore((state) => state.setWaitTimingKeyframe)
  const setWaitTimingManual = useTacticStore((state) => state.setWaitTimingManual)
  const reference = action.timingConstraint?.reference
  return <div className="move-timing-editor">
    {reference && <TimingReferenceSummary reference={reference} document={document} />}
    <div className="move-timing-actions">
      <button type="button" className="quiet-button" onClick={() => setDialogOpen(true)}>{reference ? '更换关键帧' : '等待到关键帧'}</button>
      {reference && <button type="button" className="quiet-button" onClick={() => setWaitTimingManual(action.id)}>改为手动时间</button>}
    </div>
    {dialogOpen && <TimingKeyframeDialog action={action} document={document} onClose={closeDialog} onSelect={(target) => {
      setWaitTimingKeyframe(action.id, target)
      closeDialog()
    }} />}
  </div>
}

function TimingReferenceSummary({ reference, document }: { reference: TimingTargetReference; document: TacticDocumentV1 }) {
  const keyframe = useMemo(() => resolveTimingKeyframe(document, reference), [document, reference])
  const player = document.initialScene.players.find((candidate) => candidate.id === reference.playerId)
  return <div className="timing-reference-summary">
    <span>对齐关键帧</span>
    <strong>{player ? playerRoleLabel(player, document.rulesSnapshot) : reference.playerId} · {keyframe?.label ?? '关键帧'} · {keyframe?.time.toFixed(2) ?? '?'}s</strong>
  </div>
}

function compactSeconds(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function teamLabel(team: 'blue' | 'red'): string {
  return team === 'blue' ? '蓝方' : '红方'
}

function contestOutcomeLabel(outcome: 'ahead' | 'level' | 'behind', margin: number): string {
  if (outcome === 'level') return '几乎同时'
  return `${outcome === 'ahead' ? '领先' : '落后'} ${compactSeconds(margin)}s`
}

function arrivalSummary(arrival: BallArrival): string {
  return `${arrival.player.name} ${compactSeconds(arrival.earliestTime)}s（${arrival.mode === 'q' ? 'Q 抢球' : '直跑抢球'}）`
}

function ShotPressureCard({
  evaluation,
}: {
  evaluation: NonNullable<ReturnType<typeof evaluateShotActionPressure>>
}) {
  const earliest = evaluation.earliest
  return <div className={`shot-pressure-card ${evaluation.isRisk ? 'risk' : 'safe'}`} aria-label="射门受压分析">
    <strong>{shotPressureSummary(evaluation)}</strong>
    <span>{shotPressureComparison(evaluation)}</span>
    {earliest && <small>
      距离 {earliest.gap.toFixed(2)} 格 · 攻击环 {earliest.attackInnerRadius.toFixed(2)}–{earliest.attackOuterRadius.toFixed(2)} 格 ·
      需逼近 {earliest.radialEntryDistance.toFixed(2)} 格 · {shotPressureModeLabel(earliest.mode)}
      {earliest.frozenDelay > 0 ? ` · 冻结等待 ${earliest.frozenDelay.toFixed(2)}s` : ''}
      {earliest.mode === 'q' ? ` · Q CD ${earliest.qCooldownAtStart.toFixed(2)}s / Q 动作 ${earliest.qDuration.toFixed(2)}s` : ''}
    </small>}
  </div>
}

const cardinalFacings = [
  { label: '右', accessibleLabel: '向右 0°', value: 0 },
  { label: '下', accessibleLabel: '向下 90°', value: 90 },
  { label: '左', accessibleLabel: '向左 180°', value: 180 },
  { label: '上', accessibleLabel: '向上 270°', value: 270 },
] as const

function FacingEditor({
  playerName,
  facing,
  onChange,
}: {
  playerName: string
  facing: number
  onChange: (facing: number) => void
}) {
  const normalizedFacing = normalizeAngle(facing)
  const displayFacing = Number(normalizedFacing.toFixed(2))
  const commitFacing = (value: number) => {
    if (Number.isFinite(value)) onChange(normalizeAngle(value))
  }

  return <div className="facing-editor">
    <label className="field-row facing-number-row">
      <span>面向角度</span>
      <span className="number-wrap">
        <input
          type="number"
          min="0"
          max="359"
          step="1"
          value={displayFacing}
          aria-label={`${playerName}面向角度`}
          onChange={(event) => commitFacing(Number(event.target.value))}
        />
        <em>°</em>
      </span>
    </label>
    <div className="cardinal-facing-buttons" role="group" aria-label={`${playerName}常用面向`}>
      {cardinalFacings.map((cardinal) => <button
        key={cardinal.value}
        type="button"
        className={Math.abs(normalizedFacing - cardinal.value) < 0.001 ? 'active' : ''}
        aria-label={cardinal.accessibleLabel}
        aria-pressed={Math.abs(normalizedFacing - cardinal.value) < 0.001}
        onClick={() => commitFacing(cardinal.value)}
      >
        <span aria-hidden="true">{cardinal.label}</span>
        <small>{cardinal.value}°</small>
      </button>)}
    </div>
    <label className="field-row field-range facing-range">
      <span>拖动微调 <b>{displayFacing}°</b></span>
      <input
        type="range"
        min="0"
        max="359"
        step="1"
        value={normalizedFacing}
        aria-label={`${playerName}面向角度滑块`}
        onChange={(event) => commitFacing(Number(event.target.value))}
      />
    </label>
    <p className="facing-help">球场坐标：右 0°、下 90°、左 180°、上 270°</p>
  </div>
}

function NumberInput({ value, onChange, step, suffix, disabled = false }: { value: number; onChange: (value: number) => void; step: number; suffix?: string; disabled?: boolean }) {
  return <span className="number-wrap"><input type="number" min="0" step={step} value={Number(value.toFixed(3))} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <em>{suffix}</em>}</span>
}
