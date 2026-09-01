import type { TacticAction } from '../domain/model/types'
import { actionEndTime } from '../domain/timeline/durations'
import { timelineDuration, timelineJointTimes } from '../domain/timeline/keyframes'
import { formatStepActionRange, getStepActionOwnership, stepDuration } from '../domain/timeline/stepActionOwnership'
import { isOpeningStep, sortedStepMarkers } from '../domain/timeline/steps'
import { latestActorSequenceJoint } from '../editor/locomotionScheduling'
import { useTacticStore } from '../editor/useTacticStore'
import { actionLabels } from '../ui/labels'

const INSTANT_ACTION_EPSILON = 1e-6

function actionActorId(action: TacticAction | undefined): string | null {
  if (!action || !('actorId' in action)) return null
  return action.actorId ?? null
}

function timePercent(time: number, duration: number): number {
  if (duration <= 0) return 0
  return Math.min(100, Math.max(0, (time / duration) * 100))
}

export function TimelinePanel() {
  const document = useTacticStore((state) => state.document)
  const selection = useTacticStore((state) => state.selection)
  const tool = useTacticStore((state) => state.tool)
  const activeStepId = useTacticStore((state) => state.activeStepId)
  const currentTime = useTacticStore((state) => state.currentTime)
  const isPlaying = useTacticStore((state) => state.isPlaying)
  const playbackSpeed = useTacticStore((state) => state.playbackSpeed)
  const showAdvanced = useTacticStore((state) => state.showAdvancedTimeline)
  const setAdvanced = useTacticStore((state) => state.setAdvancedTimeline)
  const setCurrentTime = useTacticStore((state) => state.setCurrentTime)
  const setPlaying = useTacticStore((state) => state.setPlaying)
  const setPlaybackSpeed = useTacticStore((state) => state.setPlaybackSpeed)
  const addStep = useTacticStore((state) => state.addStep)
  const selectStep = useTacticStore((state) => state.selectStep)
  const renameStep = useTacticStore((state) => state.renameStep)
  const updateStepNote = useTacticStore((state) => state.updateStepNote)
  const deleteStep = useTacticStore((state) => state.deleteStep)
  const clearStepActions = useTacticStore((state) => state.clearStepActions)
  const select = useTacticStore((state) => state.select)
  const chooseActorForTool = useTacticStore((state) => state.chooseActorForTool)
  const reselectToolActor = useTacticStore((state) => state.reselectToolActor)
  const updateActionTiming = useTacticStore((state) => state.updateActionTiming)
  const deleteAction = useTacticStore((state) => state.deleteAction)
  const duration = timelineDuration(document)
  const sliderMax = Math.max(duration, 0.01)
  const joints = timelineJointTimes(document)
  const activeStep = document.stepMarkers.find((step) => step.id === activeStepId)
  const editableStep = activeStep && !isOpeningStep(document, activeStep.id) ? activeStep : null
  const activeOwnership = editableStep ? getStepActionOwnership(document, editableStep.id) : null
  const selectedAction = selection?.kind === 'action'
    ? document.actions.find((action) => action.id === selection.id)
    : undefined
  const trackPlayerId = selection?.kind === 'player'
    ? selection.id
    : actionActorId(selectedAction)
  const trackPlayer = document.initialScene.players.find((player) => player.id === trackPlayerId)
  const sortedActions = [...document.actions].sort((left, right) => (
    left.startTime - right.startTime || actionEndTime(left) - actionEndTime(right)
  ))
  const trackActions = trackPlayerId
    ? sortedActions.filter((action) => actionActorId(action) === trackPlayerId)
    : sortedActions
  const continuationTime = trackPlayerId
    ? latestActorSequenceJoint(document, trackPlayerId)
    : null
  const trackKeyframeTimes = Array.from(new Set([
    0,
    ...trackActions.flatMap((action) => action.duration <= INSTANT_ACTION_EPSILON
      ? [action.startTime]
      : [action.startTime, actionEndTime(action)]),
  ])).sort((left, right) => left - right)

  function togglePlayback() {
    setPlaying(!isPlaying)
  }

  function selectTrackPlayer(playerId: string | null) {
    if (tool === 'move' || tool === 'qMove') {
      if (playerId) chooseActorForTool(playerId)
      else reselectToolActor()
      return
    }
    select(playerId ? { kind: 'player', id: playerId } : null)
  }

  return (
    <section className={`timeline-panel ${showAdvanced ? 'expanded' : ''}`}>
      <div className="playback-row">
        <button className="play-button" onClick={togglePlayback} aria-label={isPlaying ? '暂停' : '播放'}>{isPlaying ? 'Ⅱ' : '▶'}</button>
        <button className="timeline-icon-button" onClick={() => setCurrentTime(0)} aria-label="回到开头">|◀</button>
        <span className="timeline-scope">总时间轴</span>
        <span className="timeline-time current">{currentTime.toFixed(2)}</span>
        <div className="scrubber-wrap" role="group" aria-label="总体时间轴">
          <input aria-label="播放位置" type="range" min="0" max={sliderMax} step="0.01" value={Math.min(currentTime, sliderMax)} disabled={duration <= 0} onChange={(event) => setCurrentTime(Number(event.target.value))} />
          <div className="joint-ticks" aria-hidden="true">{duration > 0 && joints.map((time) => <i key={time} style={{ left: `${timePercent(time, duration)}%` }} />)}</div>
          <div className="global-player-ticks" aria-hidden="true">
            {duration > 0 && sortedActions.flatMap((action) => {
              const actorId = actionActorId(action)
              const player = document.initialScene.players.find((candidate) => candidate.id === actorId)
              if (!player) return []
              const times = action.duration <= INSTANT_ACTION_EPSILON
                ? [{ edge: 'instant', time: action.startTime }]
                : [{ edge: 'start', time: action.startTime }, { edge: 'end', time: actionEndTime(action) }]
              return times.map(({ edge, time }) => (
                <i
                  key={`${action.id}-${edge}`}
                  className={`team-${player.team}`}
                  data-timeline-action-id={action.id}
                  data-player-id={player.id}
                  style={{ left: `${timePercent(time, duration)}%` }}
                />
              ))
            })}
          </div>
          <div className="step-ticks">{duration > 0 && document.stepMarkers.map((step) => <button key={step.id} style={{ left: `${timePercent(step.time, duration)}%` }} className={step.id === activeStepId ? 'active' : ''} onClick={() => selectStep(step.id)} aria-label={`跳到 ${step.name}`} />)}</div>
        </div>
        <span className="timeline-time">{duration.toFixed(2)}s</span>
        <select className="speed-select" value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value))} aria-label="播放速度">
          <option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option>
        </select>
        <button className={`quiet-button compact ${showAdvanced ? 'active' : ''}`} onClick={() => setAdvanced(!showAdvanced)}>高级时间</button>
      </div>

      <div className="player-track-row">
        <div className="player-track-heading">
          <span className="eyebrow">个人轨道</span>
          <strong>{trackPlayer ? trackPlayer.name : '动作总览'}</strong>
        </div>
        <div className="player-track-content">
          <div
            className={`player-track-lane ${trackPlayer ? `team-${trackPlayer.team}` : 'overview'}`}
            aria-label={trackPlayer ? `${trackPlayer.name}动作轨道` : '全部动作轨道总览'}
          >
            <i className="player-track-playhead" style={{ left: `${timePercent(currentTime, sliderMax)}%` }} aria-hidden="true" />
            {trackActions.map((action) => {
              const instant = action.duration <= INSTANT_ACTION_EPSILON
              const width = instant ? 1.2 : Math.max(1.2, timePercent(action.duration, sliderMax))
              const actionSelected = selection?.kind === 'action' && selection.id === action.id
              return (
                <button
                  key={action.id}
                  className={`player-track-action type-${action.type} ${instant ? 'instant' : ''} ${actionSelected ? 'selected' : ''}`}
                  style={{ left: `${timePercent(action.startTime, sliderMax)}%`, width: `${width}%` }}
                  onClick={() => select({ kind: 'action', id: action.id })}
                  aria-label={`选择${actionLabels[action.type]}动作，不移动播放头`}
                  title={`${actionLabels[action.type]} ${action.startTime.toFixed(2)}–${actionEndTime(action).toFixed(2)}s；点击只选择动作，不跳转时间`}
                ><span>{actionLabels[action.type]}</span></button>
              )
            })}
            {trackKeyframeTimes.map((time) => {
              const percent = timePercent(time, sliderMax)
              const isContinuation = continuationTime !== null && Math.abs(time - continuationTime) <= INSTANT_ACTION_EPSILON
              return <span
                key={`track-keyframe-${time}`}
                className={`player-track-keyframe-marker ${percent <= 3 ? 'near-start' : ''} ${percent >= 97 ? 'near-end' : ''} ${isContinuation ? 'continuation' : ''}`}
                style={{ left: `${percent}%` }}
                title={isContinuation ? `下一段跑动或 Q 从 ${time.toFixed(2)}s 继续` : `关键帧 ${time.toFixed(2)}s`}
              >
                <i aria-hidden="true" />
                {trackPlayer && <b>{time.toFixed(2)}s{isContinuation ? ' · 续接' : ''}</b>}
              </span>
            })}
            {trackActions.length === 0 && <span className="player-track-empty">{trackPlayer ? '该球员还没有动作' : '尚未添加动作'}</span>}
          </div>
          <small>{trackPlayer && continuationTime !== null
            ? `续编点 ${continuationTime.toFixed(2)}s · 跑动从此续接；Q 会先跳到不早于此处的最早可用起点`
            : '总览汇集所有球员关键帧；选择球员可切换个人轨道，不会移动播放头'}</small>
        </div>
        <div className="player-track-tabs" role="tablist" aria-label="切换球员动作轨道">
          <button
            role="tab"
            aria-selected={!trackPlayerId}
            className={!trackPlayerId ? 'active' : ''}
            onClick={() => selectTrackPlayer(null)}
          >总览</button>
          {document.initialScene.players.map((player) => (
            <button
              key={player.id}
              role="tab"
              aria-selected={trackPlayerId === player.id}
              aria-label={`查看${player.name}个人轨道`}
              className={`${trackPlayerId === player.id ? 'active' : ''} team-${player.team}`}
              onClick={() => selectTrackPlayer(player.id)}
            >{player.name.replace('方 ', '')}</button>
          ))}
        </div>
      </div>

      <div className="steps-row">
        <div className="steps-label"><span className="eyebrow">讲解节点</span><strong>步骤</strong></div>
        <div className="step-cards">
          {sortedStepMarkers(document).map((step, index, steps) => {
            const opening = isOpeningStep(document, step.id)
            const stepNumber = steps.slice(0, index + 1).filter((candidate) => !isOpeningStep(document, candidate.id)).length
            return (
              <button key={step.id} className={`step-card ${step.id === activeStepId ? 'active' : ''}`} onClick={() => selectStep(step.id)}>
                <span className="step-index">{opening ? '起' : String(stepNumber).padStart(2, '0')}</span>
                <span><strong>{step.name}</strong>{!opening && <small>{(stepDuration(document, step.id) ?? 0).toFixed(2)}s</small>}</span>
              </button>
            )
          })}
          <button className="add-step-card" onClick={addStep} title="继承当前战术末尾状态并添加讲解节点">
            <span>＋</span><span><strong>添加下一步</strong><small>继承当前战术末尾状态</small></span>
          </button>
        </div>
      </div>

      <div className="step-editor" data-placeholder={!editableStep} aria-hidden={!editableStep}>
        {editableStep && <>
          <label><span>步骤名称</span><input maxLength={100} value={editableStep.name} onChange={(event) => renameStep(editableStep.id, event.target.value)} /></label>
          <label className="note-field"><span>讲解备注</span><input maxLength={1000} value={editableStep.note} placeholder="可选：说明这一拍的意图" onChange={(event) => updateStepNote(editableStep.id, event.target.value)} /></label>
          {activeOwnership && <div className="clear-frame-control">
            <button
              className="clear-frame-button"
              disabled={activeOwnership.count === 0}
              onClick={() => clearStepActions(editableStep.id)}
              aria-label={`清空当前帧，共 ${activeOwnership.count} 个动作`}
            >清空当前帧（{activeOwnership.count}）</button>
            <small>{formatStepActionRange(activeOwnership)}；仅删除在此范围内开始的动作，步骤本身保留，可撤销。</small>
          </div>}
          <button
            className="text-danger"
            onClick={() => deleteStep(editableStep.id)}
            aria-label={document.stepMarkers.length === 1 ? '删除当前步骤并恢复初始站位' : '删除当前步骤'}
            title={document.stepMarkers.length === 1 ? '删除最后一个步骤后，将自动恢复一个 0 秒初始站位节点' : '仅删除讲解节点，连续时间轴上的动作会保留'}
          >{document.stepMarkers.length === 1 ? '删除并重置' : '删除步骤'}</button>
        </>}
      </div>

      {showAdvanced && <div className="advanced-tracks">
        <div className="track-head">
          <strong>{trackPlayer ? `${trackPlayer.name} · 精确时序` : '全部动作 · 精确时序'}</strong>
          <span>数值可手动错峰；选择动作不会改变总时间播放头</span>
        </div>
        {trackActions.length === 0 ? <p className="empty-track">{trackPlayer ? '该球员还没有动作；点击跑动或 Q 技能即可从续编点添加。' : '选择球员并在球场上添加动作后，这里会显示精确时序。'}</p> : (
          <div className="action-table">
            {trackActions.map((action) => (
              <div className={`action-row ${selection?.kind === 'action' && selection.id === action.id ? 'selected' : ''}`} key={action.id} data-timeline-action-id={action.id}>
                <button className="action-name" onClick={() => select({ kind: 'action', id: action.id })}><span className={`action-dot type-${action.type}`} />{actionLabels[action.type]}</button>
                <label>开始 <input type="number" min="0" step="0.1" value={Number(action.startTime.toFixed(2))} onChange={(event) => updateActionTiming(action.id, 'startTime', Number(event.target.value))} /></label>
                <label>持续 <input type="number" min="0" step="0.1" value={Number(action.duration.toFixed(2))} onChange={(event) => updateActionTiming(action.id, 'duration', Number(event.target.value))} /></label>
                <div className="mini-track"><span style={{ left: `${timePercent(action.startTime, sliderMax)}%`, width: `${Math.max(timePercent(action.duration, sliderMax), 1.5)}%` }} /></div>
                <button className="remove-action" onClick={() => deleteAction(action.id)} aria-label={`删除${actionLabels[action.type]}`}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>}
    </section>
  )
}
