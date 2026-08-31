import { documentDuration } from '../domain/timeline/durations'
import { formatStepActionRange, getStepActionOwnership } from '../domain/timeline/stepActionOwnership'
import { useTacticStore } from '../editor/useTacticStore'
import { actionLabels } from '../ui/labels'

export function TimelinePanel() {
  const document = useTacticStore((state) => state.document)
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
  const updateActionTiming = useTacticStore((state) => state.updateActionTiming)
  const deleteAction = useTacticStore((state) => state.deleteAction)
  const duration = Math.max(documentDuration(document.actions, document.stepMarkers.map((step) => step.time)), 2)
  const activeStep = document.stepMarkers.find((step) => step.id === activeStepId)
  const activeOwnership = activeStep ? getStepActionOwnership(document, activeStep.id) : null

  function togglePlayback() {
    setPlaying(!isPlaying)
  }

  return (
    <section className={`timeline-panel ${showAdvanced ? 'expanded' : ''}`}>
      <div className="playback-row">
        <button className="play-button" onClick={togglePlayback} aria-label={isPlaying ? '暂停' : '播放'}>{isPlaying ? 'Ⅱ' : '▶'}</button>
        <button className="timeline-icon-button" onClick={() => setCurrentTime(0)} aria-label="回到开头">|◀</button>
        <span className="timeline-time current">{currentTime.toFixed(2)}</span>
        <div className="scrubber-wrap">
          <input aria-label="播放位置" type="range" min="0" max={duration} step="0.01" value={Math.min(currentTime, duration)} onChange={(event) => setCurrentTime(Number(event.target.value))} />
          <div className="step-ticks">{document.stepMarkers.map((step) => <button key={step.id} style={{ left: `${(step.time / duration) * 100}%` }} className={step.id === activeStepId ? 'active' : ''} onClick={() => selectStep(step.id)} aria-label={`跳到 ${step.name}`} />)}</div>
        </div>
        <span className="timeline-time">{duration.toFixed(2)}s</span>
        <select className="speed-select" value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value))} aria-label="播放速度">
          <option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option>
        </select>
        <button className={`quiet-button compact ${showAdvanced ? 'active' : ''}`} onClick={() => setAdvanced(!showAdvanced)}>高级时间</button>
      </div>

      <div className="steps-row">
        <div className="steps-label"><span className="eyebrow">讲解节点</span><strong>步骤</strong></div>
        <div className="step-cards">
          {[...document.stepMarkers].sort((a, b) => a.time - b.time).map((step, index) => (
            <button key={step.id} className={`step-card ${step.id === activeStepId ? 'active' : ''}`} onClick={() => selectStep(step.id)}>
              <span className="step-index">{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{step.name}</strong><small>{step.time.toFixed(2)}s</small></span>
            </button>
          ))}
          <button className="add-step-card" onClick={addStep} title="继承当前战术末尾状态并添加讲解节点">
            <span>＋</span><span><strong>添加下一步</strong><small>继承当前战术末尾状态</small></span>
          </button>
        </div>
      </div>

      {activeStep && <div className="step-editor">
        <label><span>步骤名称</span><input maxLength={100} value={activeStep.name} onChange={(event) => renameStep(activeStep.id, event.target.value)} /></label>
        <label className="note-field"><span>讲解备注</span><input maxLength={1000} value={activeStep.note} placeholder="可选：说明这一拍的意图" onChange={(event) => updateStepNote(activeStep.id, event.target.value)} /></label>
        {activeOwnership && <div className="clear-frame-control">
          <button
            className="clear-frame-button"
            disabled={activeOwnership.count === 0}
            onClick={() => clearStepActions(activeStep.id)}
            aria-label={`清空当前帧，共 ${activeOwnership.count} 个动作`}
          >清空当前帧（{activeOwnership.count}）</button>
          <small>{formatStepActionRange(activeOwnership)}；仅删除在此范围内开始的动作，步骤本身保留，可撤销。</small>
        </div>}
        <button
          className="text-danger"
          onClick={() => deleteStep(activeStep.id)}
          aria-label={document.stepMarkers.length === 1 ? '删除当前步骤并恢复初始站位' : '删除当前步骤'}
          title={document.stepMarkers.length === 1 ? '删除最后一个步骤后，将自动恢复一个 0 秒初始站位节点' : '仅删除讲解节点，连续时间轴上的动作会保留'}
        >{document.stepMarkers.length === 1 ? '删除并重置' : '删除步骤'}</button>
      </div>}

      {showAdvanced && <div className="advanced-tracks">
        <div className="track-head"><strong>语义动作轨道</strong><span>动作可错峰，也可跨越步骤节点</span></div>
        {document.actions.length === 0 ? <p className="empty-track">选择球员并在球场上添加动作后，这里会显示精确时序。</p> : (
          <div className="action-table">
            {[...document.actions].sort((a, b) => a.startTime - b.startTime).map((action) => (
              <div className="action-row" key={action.id}>
                <button className="action-name" onClick={() => select({ kind: 'action', id: action.id })}><span className={`action-dot type-${action.type}`} />{actionLabels[action.type]}</button>
                <label>开始 <input type="number" min="0" step="0.1" value={Number(action.startTime.toFixed(2))} onChange={(event) => updateActionTiming(action.id, 'startTime', Number(event.target.value))} /></label>
                <label>持续 <input type="number" min="0" step="0.1" value={Number(action.duration.toFixed(2))} onChange={(event) => updateActionTiming(action.id, 'duration', Number(event.target.value))} /></label>
                <div className="mini-track"><span style={{ left: `${(action.startTime / duration) * 100}%`, width: `${Math.max((action.duration / duration) * 100, 1.5)}%` }} /></div>
                <button className="remove-action" onClick={() => deleteAction(action.id)} aria-label={`删除${actionLabels[action.type]}`}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>}
    </section>
  )
}
