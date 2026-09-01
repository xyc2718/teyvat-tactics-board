import { useMemo } from 'react'
import { normalizeAngle, pathLength, resolvedMovePath } from '../domain/geometry/geometry'
import type { MoveAction } from '../domain/model/types'
import { evaluateWarnings } from '../domain/rules/evaluateRules'
import { evaluatePlayerSituation, type BallArrival } from '../domain/rules/playerSituation'
import {
  evaluateShotActionPressure,
  shotPressureComparison,
  shotPressureModeLabel,
  shotPressureSummary,
} from '../domain/rules/shotPressure'
import { projectFrame } from '../domain/timeline/projectFrame'
import { useTacticStore } from '../editor/useTacticStore'
import { actionLabels, matchupLabel } from '../ui/labels'

export function InspectorPanel() {
  const document = useTacticStore((state) => state.document)
  const currentTime = useTacticStore((state) => state.currentTime)
  const selection = useTacticStore((state) => state.selection)
  const showAdvancedTimeline = useTacticStore((state) => state.showAdvancedTimeline)
  const frame = useMemo(() => projectFrame(document, currentTime), [document, currentTime])
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
    <aside className="inspector-panel panel-surface">
      <div className="panel-heading inspector-heading">
        <div><span className="eyebrow">检查器</span><h2>{selectedPlayer ? selectedPlayer.name : selectedAction ? actionLabels[selectedAction.type] : '战术提示'}</h2></div>
        <span className="time-chip">{currentTime.toFixed(2)}s</span>
      </div>

      {selectedPlayer && (
        <div className="inspector-content">
          <section className="inspector-section">
            <h3>角色状态</h3>
            <label className="field-row"><span>职业</span>
              <select value={selectedPlayer.role} onChange={(event) => setRole(selectedPlayer.id, event.target.value as 'water' | 'fire' | 'ice')}>
                <option value="water">水灵</option><option value="fire">蛮牛</option><option value="ice">霜役</option>
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
              <Metric label="坐标" value={`${selectedPlayer.position.x.toFixed(1)}, ${selectedPlayer.position.y.toFixed(1)}`} />
            </div>
          </section>
          {latestPlayerMove && <section className="inspector-section latest-move-editor">
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
            <div className="action-kind"><span className={`action-dot type-${selectedAction.type}`} />{actionLabels[selectedAction.type]}</div>
            {showAdvancedTimeline
              ? <>
                  <label className="field-row"><span>开始时间</span><NumberInput value={selectedAction.startTime} step={0.1} onChange={(value) => updateTiming(selectedAction.id, 'startTime', value)} suffix="s" /></label>
                  <label className="field-row"><span>持续时间</span><NumberInput value={selectedAction.duration} step={0.1} onChange={(value) => updateTiming(selectedAction.id, 'duration', value)} suffix="s" /></label>
                </>
              : <>
                  <div className="inline-info"><span>开始节点</span><strong>{selectedAction.startTime.toFixed(2)}s</strong></div>
                  {selectedAction.type === 'wait'
                    ? <label className="field-row"><span>等待时长</span><NumberInput value={selectedAction.duration} step={0.1} onChange={(value) => updateTiming(selectedAction.id, 'duration', value)} suffix="s" /></label>
                    : <div className="inline-info"><span>动作时长</span><strong>{selectedAction.duration.toFixed(2)}s</strong></div>}
                </>}
            {'path' in selectedAction && <div className="inline-info"><span>路径长度</span><strong>{pathLength(selectedAction.type === 'move' ? resolvedMovePath(selectedAction) : selectedAction.path).toFixed(2)} 格</strong></div>}
            {selectedAction.type === 'move' && <MovePathModeButtons
              curved={Boolean(selectedAction.curveControl)}
              onChange={(mode) => setMovePathMode(selectedAction.id, mode)}
            />}
            {selectedAction.type === 'move' && selectedAction.curveControl && <p className="callout">拖动球场上的青色曲线控制点调整弧度；动作时长会随曲线长度自动更新。</p>}
            {selectedAction.type === 'qMove' && <p className="callout">拖动球场上的白色控制点，可缩短或弯曲路径；路径会自动限制在职业 Q 最大距离内。</p>}
            {selectedAction.type === 'shoot' && <label className="field-row"><span>蓄力等级</span>
              <select value={selectedAction.charge} onChange={(event) => setShotCharge(selectedAction.id, event.target.value as 'yellow' | 'red')}><option value="yellow">黄色蓄力</option><option value="red">红色满蓄</option></select>
            </label>}
            {selectedAction.type === 'shoot' && selectedShotPressure && <ShotPressureCard evaluation={selectedShotPressure} />}
            {selectedAction.type === 'pass' && <p className="callout">≤ {document.rulesSnapshot.passing.safeDistance} 格为安全传球；超过 {document.rulesSnapshot.passing.maxDistance} 格会落为自由球。</p>}
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

function NumberInput({ value, onChange, step, suffix }: { value: number; onChange: (value: number) => void; step: number; suffix?: string }) {
  return <span className="number-wrap"><input type="number" min="0" step={step} value={Number(value.toFixed(3))} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <em>{suffix}</em>}</span>
}
