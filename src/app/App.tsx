import { useEffect, useMemo, useState } from 'react'
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
import { TacticLibraryDrawer } from './TacticLibraryDrawer'
import { MobileOrientationGate } from './MobileOrientationGate'
import { MobilePanelDock, type MobilePanel } from './MobilePanelDock'
import { useDeviceLayout } from './useDeviceLayout'
import { useTacticLibraryController } from './useTacticLibraryController'
import { SlowStatusDialog } from './SlowStatusDialog'

export function App() {
  const deviceLayout = useDeviceLayout()
  const isMobileLandscape = deviceLayout === 'phone-landscape'
  const library = useTacticLibraryController()
  const document = useTacticStore((state) => state.document)
  const boardMode = useTacticStore((state) => state.boardMode)
  const isPlaying = useTacticStore((state) => state.isPlaying)
  const notice = useTacticStore((state) => state.notice)
  const tool = useTacticStore((state) => state.tool)
  const updateMeta = useTacticStore((state) => state.updateMeta)
  const setNotice = useTacticStore((state) => state.setNotice)
  const duration = useMemo(
    () => timelineDuration(document),
    [document],
  )
  const mobileContext = `${deviceLayout}:${boardMode}`
  const [mobileUi, setMobileUi] = useState<{ context: string; panel: MobilePanel | null; actionsOpen: boolean }>(() => ({
    context: mobileContext,
    panel: null,
    actionsOpen: false,
  }))
  const mobilePanel = mobileUi.context === mobileContext ? mobileUi.panel : null
  const mobileActionsOpen = mobileUi.context === mobileContext && mobileUi.actionsOpen

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
        ? { v: 'select', m: 'move', k: 'attack', r: 'strikeRange' } as const
        : { v: 'select', m: 'move', w: 'wait', q: 'qMove', p: 'pass', s: 'shoot', a: 'annotation', k: 'attack', r: 'strikeRange', g: 'slow', e: 'eZone' } as const
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

  if (deviceLayout === 'phone-portrait') return <MobileOrientationGate />

  const activeMobilePanel = boardMode === 'simulation' && isMobileLandscape ? mobilePanel : null
  const shellClasses = [
    'app-shell',
    boardMode === 'basic' ? 'basic-mode' : '',
    isMobileLandscape ? 'mobile-landscape' : '',
    activeMobilePanel ? `mobile-panel-${activeMobilePanel}` : '',
  ].filter(Boolean).join(' ')

  function toggleMobilePanel(panel: MobilePanel) {
    setMobileUi((current) => {
      const activePanel = current.context === mobileContext ? current.panel : null
      return { context: mobileContext, panel: activePanel === panel ? null : panel, actionsOpen: false }
    })
  }

  function setMobileActions(open: boolean) {
    setMobileUi((current) => ({
      context: mobileContext,
      panel: open ? null : current.context === mobileContext ? current.panel : null,
      actionsOpen: open,
    }))
  }

  function closeMobilePanel() {
    setMobileUi({ context: mobileContext, panel: null, actionsOpen: false })
  }

  return (
    <div className={shellClasses}>
      <TopToolbar
        libraryReady={library.ready}
        libraryBusy={library.busy}
        onOpenLibrary={() => library.setOpen(true)}
        onCreateDocument={library.createNew}
        onImportDocument={library.importDocument}
        mobile={isMobileLandscape}
        mobileActionsOpen={mobileActionsOpen}
        onMobileActionsOpenChange={setMobileActions}
      />
      <div className="document-bar">
        <label><span className="status-dot" />本地草稿已自动保存</label>
        <input className="tactic-title-input" maxLength={120} value={document.meta.title} onChange={(event) => updateMeta('title', event.target.value)} aria-label="战术名称" />
        <div className="document-meta">{boardMode === 'basic'
          ? <><span>基础模式</span><span>{document.staticMoveArrows.length} 个移动箭头</span></>
          : <><span>规则 {document.rulesSnapshot.version}</span><span>{document.actions.length} 个动作</span><span>{document.stepMarkers.length} 个步骤</span></>}
        </div>
      </div>
      <main className={`workspace-grid ${boardMode === 'basic' ? 'basic-workspace' : ''}`}>
        {boardMode === 'simulation' && <RosterPanel onPlayerChosen={isMobileLandscape ? closeMobilePanel : undefined} />}
        <section className="board-column">
          <TacticsBoard key={deviceLayout} initialZoom={isMobileLandscape ? 1.75 : 1} touchOptimized={isMobileLandscape} />
        </section>
        {boardMode === 'simulation' && <InspectorPanel />}
      </main>
      {boardMode === 'simulation' && <TimelinePanel />}
      {isMobileLandscape && boardMode === 'simulation' && <>
        {activeMobilePanel && <button type="button" className="mobile-panel-backdrop" onClick={closeMobilePanel} aria-label="关闭手机面板" />}
        <MobilePanelDock activePanel={activeMobilePanel} onToggle={toggleMobilePanel} />
      </>}
      <RulesDrawer />
      <LogicDrawer />
      <TacticLibraryDrawer controller={library} />
      {boardMode === 'simulation' && tool === 'slow' && <SlowStatusDialog />}
      <div className="version-badge" aria-label={`Version ${packageJson.version}, Developer ${packageJson.author}`}>
        v{packageJson.version} · Developer: {packageJson.author}
      </div>
      {notice && <div className="toast" role="status"><span aria-hidden="true">i</span>{notice}</div>}
    </div>
  )
}
