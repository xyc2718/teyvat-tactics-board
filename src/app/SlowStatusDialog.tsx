import { useEffect, useMemo, useState } from 'react'
import { timelineDuration } from '../domain/timeline/keyframes'
import { playerActionKeyframes } from '../domain/timeline/playerKeyframes'
import { useTacticStore } from '../editor/useTacticStore'

const TIME_EPSILON = 1e-6

export function SlowStatusDialog() {
  const document = useTacticStore((state) => state.document)
  const selection = useTacticStore((state) => state.selection)
  const currentTime = useTacticStore((state) => state.currentTime)
  const cancelTool = useTacticStore((state) => state.cancelTool)
  const createSlowStatus = useTacticStore((state) => state.createSlowStatus)
  const initialPlayerId = selection?.kind === 'player'
    ? selection.id
    : document.initialScene.players[0]?.id ?? ''
  const [playerId, setPlayerId] = useState(initialPlayerId)
  const [startTime, setStartTime] = useState(Math.max(0, currentTime))
  const duration = timelineDuration(document)
  const axisDuration = Math.max(duration, 1)
  const slowDuration = document.rulesSnapshot.roles.ice.slow?.duration ?? 0
  const player = document.initialScene.players.find((candidate) => candidate.id === playerId)
  const keyframes = useMemo(() => {
    const actionKeyframes = playerActionKeyframes(document, playerId)
    return [
      { id: `${playerId}-initial`, time: 0, label: '初始位置' },
      ...actionKeyframes.map((keyframe) => ({
        id: keyframe.id,
        time: keyframe.time,
        label: keyframe.label,
      })),
    ].filter((keyframe, index, all) => all.findIndex((candidate) => (
      candidate.label === keyframe.label && Math.abs(candidate.time - keyframe.time) <= TIME_EPSILON
    )) === index)
  }, [document, playerId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelTool()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancelTool])

  function chooseLaneTime(event: React.PointerEvent<HTMLDivElement>) {
    if (duration <= 0) {
      setStartTime(0)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1)))
    setStartTime(ratio * duration)
  }

  return <div className="timing-dialog-backdrop slow-status-dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) cancelTool()
  }}>
    <section className="timing-dialog slow-status-dialog" role="dialog" aria-modal="true" aria-labelledby="slow-status-dialog-title">
      <div className="timing-dialog-heading">
        <div><span className="eyebrow">球员状态</span><h3 id="slow-status-dialog-title">添加挂冰起始时间</h3></div>
        <button type="button" className="icon-button" aria-label="关闭挂冰设置" onClick={cancelTool}>×</button>
      </div>
      <p className="subtle">选择受影响球员，再点击其时间轴上的任意时刻或关键帧。挂冰只记录目标与时间，不记录来源。</p>
      <div className="timing-player-tabs slow-status-player-tabs" role="tablist" aria-label="选择挂冰球员">
        {document.initialScene.players.map((candidate) => <button
          type="button"
          role="tab"
          aria-selected={candidate.id === playerId}
          className={candidate.id === playerId ? `active team-${candidate.team}` : `team-${candidate.team}`}
          key={candidate.id}
          onClick={() => setPlayerId(candidate.id)}
        >{candidate.name}</button>)}
      </div>
      <div
        className={`timing-lane slow-status-lane ${duration <= 0 ? 'disabled' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label={`${player?.name ?? '球员'}挂冰起始时间`}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={startTime}
        onPointerDown={chooseLaneTime}
      >
        <span className="timing-lane-start">0s</span>
        <span className="timing-lane-end">{duration.toFixed(2)}s</span>
        <div className="timing-lane-line" />
        <i className="slow-status-time-cursor" style={{ left: `${(startTime / axisDuration) * 100}%` }} aria-hidden="true" />
        {keyframes.map((keyframe) => <button
          type="button"
          key={keyframe.id}
          className={`timing-lane-keyframe ${Math.abs(keyframe.time - startTime) <= TIME_EPSILON ? 'selected' : ''}`}
          style={{ left: `${Math.min(100, Math.max(0, (keyframe.time / axisDuration) * 100))}%` }}
          title={`${keyframe.label} ${keyframe.time.toFixed(2)}s`}
          aria-label={`${keyframe.label} ${keyframe.time.toFixed(2)}秒`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setStartTime(keyframe.time)}
        />)}
      </div>
      <div className="slow-status-time-row">
        <label>起始时间 <span className="number-wrap"><input
          type="number"
          min="0"
          max={duration}
          step="0.01"
          value={Number(startTime.toFixed(2))}
          onChange={(event) => setStartTime(Math.min(duration, Math.max(0, Number(event.target.value) || 0)))}
        /><em>s</em></span></label>
        <span>持续 {slowDuration.toFixed(1)}s · 预计于 {(startTime + slowDuration).toFixed(2)}s 结束</span>
      </div>
      <div className="timing-keyframe-list slow-status-keyframe-list">
        {keyframes.map((keyframe) => <button type="button" key={keyframe.id} onClick={() => setStartTime(keyframe.time)}>
          <span>{keyframe.label}</span><strong>{keyframe.time.toFixed(2)}s</strong>
        </button>)}
      </div>
      <div className="slow-status-dialog-actions">
        <button type="button" className="quiet-button" onClick={cancelTool}>取消</button>
        <button
          type="button"
          className="accent-button"
          disabled={!player || slowDuration <= 0}
          onClick={() => player && createSlowStatus(player.id, startTime)}
        >为{player?.name ?? '球员'}添加挂冰</button>
      </div>
    </section>
  </div>
}
