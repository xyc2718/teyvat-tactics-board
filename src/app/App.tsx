import { useEffect, useMemo } from 'react'
import packageJson from '../../package.json'
import { TacticsBoard } from '../board/TacticsBoard'
import { timelineDuration } from '../domain/timeline/keyframes'
import { useTacticStore } from '../editor/useTacticStore'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { RulesDrawer } from '../inspector/RulesDrawer'
import { LogicDrawer } from '../inspector/LogicDrawer'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { RosterPanel } from './RosterPanel'
import { TopToolbar } from './TopToolbar'

export function App() {
  const document = useTacticStore((state) => state.document)
  const boardMode = useTacticStore((state) => state.boardMode)
  const isPlaying = useTacticStore((state) => state.isPlaying)
  const notice = useTacticStore((state) => state.notice)
  const updateMeta = useTacticStore((state) => state.updateMeta)
  const setNotice = useTacticStore((state) => state.setNotice)
  const duration = useMemo(
    () => timelineDuration(document),
    [document],
  )

  useEffect(() => {
    if (!isPlaying) return
    let frameId = 0
    let previous = performance.now()
    const tick = (now: number) => {
      const state = useTacticStore.getState()
      if (!state.isPlaying) return
      const elapsed = ((now - previous) / 1000) * state.playbackSpeed
      previous = now
      const next = state.currentTime + elapsed
      if (duration <= 0 || next >= duration) {
        useTacticStore.setState({ currentTime: duration, isPlaying: false })
        return
      }
      useTacticStore.setState({ currentTime: next })
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [duration, isPlaying])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useTacticStore.getState()
      if (state.showLogic || state.showRules) return
      if (event.key === 'Escape') {
        state.cancelTool()
        return
      }
      const target = event.target
      if (target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) state.redo()
        else state.undo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault(); state.redo(); return
      }
      if (event.code === 'Space' && state.boardMode === 'simulation') {
        event.preventDefault(); state.setPlaying(!state.isPlaying); return
      }
      const keyTools = state.boardMode === 'basic'
        ? { v: 'select', m: 'move' } as const
        : { v: 'select', m: 'move', w: 'wait', q: 'qMove', p: 'pass', s: 'shoot', a: 'annotation', k: 'attack', e: 'eZone' } as const
      const tool = keyTools[event.key.toLowerCase() as keyof typeof keyTools]
      if (tool && !event.repeat) {
        event.preventDefault()
        state.setTool(tool)
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection?.kind === 'action') state.deleteAction(state.selection.id)
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection?.kind === 'staticArrow') state.deleteStaticMoveArrow(state.selection.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3600)
    return () => window.clearTimeout(timer)
  }, [notice, setNotice])

  return (
    <div className={`app-shell ${boardMode === 'basic' ? 'basic-mode' : ''}`}>
      <TopToolbar />
      <div className="document-bar">
        <label><span className="status-dot" />本地草稿已自动保存</label>
        <input className="tactic-title-input" maxLength={120} value={document.meta.title} onChange={(event) => updateMeta('title', event.target.value)} aria-label="战术名称" />
        <div className="document-meta">{boardMode === 'basic'
          ? <><span>基础模式</span><span>{document.staticMoveArrows.length} 个移动箭头</span></>
          : <><span>规则 {document.rulesSnapshot.version}</span><span>{document.actions.length} 个动作</span><span>{document.stepMarkers.length} 个步骤</span></>}
        </div>
      </div>
      <main className={`workspace-grid ${boardMode === 'basic' ? 'basic-workspace' : ''}`}>
        {boardMode === 'simulation' && <RosterPanel />}
        <section className="board-column">
          <TacticsBoard />
        </section>
        {boardMode === 'simulation' && <InspectorPanel />}
      </main>
      {boardMode === 'simulation' && <TimelinePanel />}
      <RulesDrawer />
      <LogicDrawer />
      <div className="version-badge" aria-label={`Version ${packageJson.version}, Developer ${packageJson.author}`}>
        v{packageJson.version} · Developer: {packageJson.author}
      </div>
      {notice && <div className="toast" role="status"><span aria-hidden="true">i</span>{notice}</div>}
      <div className="small-screen-message">第一版专为电脑端设计，请使用更宽的浏览器窗口。</div>
    </div>
  )
}
