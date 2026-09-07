import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MoveAction, TacticDocumentV1, TimingTargetReference, WaitAction } from '../domain/model/types'
import { timelineDuration } from '../domain/timeline/keyframes'
import { createTimingTargetValidator, playerTimingKeyframes } from '../domain/timeline/timingKeyframes'
import { playerRoleLabel } from '../ui/labels'

export function TimingKeyframeDialog({
  action, document, onClose, onSelect,
}: {
  action: MoveAction | WaitAction
  document: TacticDocumentV1
  onClose: () => void
  onSelect: (reference: TimingTargetReference) => void
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const players = document.initialScene.players
  const initialPlayerId = action.timingConstraint?.kind === 'keyframe'
    ? action.timingConstraint.reference.playerId
    : action.actorId ?? players[0]?.id ?? ''
  const [playerId, setPlayerId] = useState(initialPlayerId)
  const player = players.find((candidate) => candidate.id === playerId)
  const playerLabel = player ? playerRoleLabel(player, document.rulesSnapshot) : '球员'
  const validateTarget = useMemo(() => createTimingTargetValidator(document, action), [document, action])
  const keyframes = useMemo(() => {
    const events = playerTimingKeyframes(document, playerId)
    const counts = new Map<number, number>()
    const ranks = new Map<number, number>()
    for (const event of events) counts.set(event.time, (counts.get(event.time) ?? 0) + 1)
    return events.map((keyframe) => {
      const rank = ranks.get(keyframe.time) ?? 0
      ranks.set(keyframe.time, rank + 1)
      return {
        ...keyframe,
        offset: (rank - ((counts.get(keyframe.time) ?? 1) - 1) / 2) * 12,
        unavailableReason: validateTarget(keyframe.reference),
      }
    })
  }, [document, playerId, validateTarget])
  const duration = useMemo(() => Math.max(timelineDuration(document), action.startTime + action.duration, 0.01), [document, action])

  useEffect(() => {
    const previousFocus = window.document.activeElement
    const panel = panelRef.current
    panel?.querySelector<HTMLButtonElement>('button')?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')]
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [onClose])

  return createPortal(<div className="timing-dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose()
  }}>
    <section ref={panelRef} className="timing-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="timing-dialog-heading">
        <div><span className="eyebrow">{action.type === 'wait' ? '等待时间' : '跑动时间'}</span><h3 id={titleId}>{action.type === 'wait' ? '选择等待结束关键帧' : '选择到达关键帧'}</h3></div>
        <button type="button" className="icon-button" aria-label="关闭关键帧选择" onClick={onClose}>×</button>
      </div>
      <p className="subtle">选择自己或其他球员的关键帧，{action.type === 'wait' ? '等待' : '跑动'}在该时刻结束。灰色节点不可选，原因显示在下方。</p>
      <div className="timing-player-tabs timing-target-player-tabs" role="tablist" aria-label="选择球员时间轴">
        {players.map((candidate) => <button
          type="button"
          role="tab"
          aria-selected={candidate.id === playerId}
          className={`${candidate.id === playerId ? 'active ' : ''}team-${candidate.team}`}
          key={candidate.id}
          onClick={() => setPlayerId(candidate.id)}
        >{playerRoleLabel(candidate, document.rulesSnapshot)}{candidate.id === action.actorId && '（自己）'}</button>)}
      </div>
      <p className="timing-lane-heading">{playerLabel}{playerId === action.actorId && '（自己）'}</p>
      <div className="timing-lane" aria-label={`${playerLabel}时间轴`}>
        <span className="timing-lane-start">0s</span>
        <span className="timing-lane-end">{duration.toFixed(2)}s</span>
        <div className="timing-lane-line" />
        {keyframes.map((keyframe) => <button
            type="button"
            key={keyframe.id}
            className="timing-lane-keyframe"
            style={{ left: `${Math.min(100, Math.max(0, (keyframe.time / duration) * 100))}%`, transform: `translateX(${keyframe.offset}px)` }}
            disabled={Boolean(keyframe.unavailableReason)}
            title={`${keyframe.label} ${keyframe.time.toFixed(2)}s${keyframe.unavailableReason ? `：${keyframe.unavailableReason}` : ''}`}
            aria-label={`${keyframe.label} ${keyframe.time.toFixed(2)}秒`}
            onClick={() => onSelect(keyframe.reference)}
          />)}
      </div>
      <div className="timing-keyframe-list">
        {keyframes.length > 0 ? keyframes.map((keyframe) => <button
          type="button"
          key={keyframe.id}
          disabled={Boolean(keyframe.unavailableReason)}
          title={keyframe.unavailableReason ?? undefined}
          onClick={() => onSelect(keyframe.reference)}
        ><span>{keyframe.label}{keyframe.unavailableReason && <small>{keyframe.unavailableReason}</small>}</span><strong>{keyframe.time.toFixed(2)}s</strong></button>) : <p>这名球员还没有关键帧。</p>}
      </div>
    </section>
  </div>, window.document.body)
}
