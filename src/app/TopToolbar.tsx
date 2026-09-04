import { useRef, useState } from 'react'
import type { TacticDocumentV1, ToolId } from '../domain/model/types'
import { useTacticStore } from '../editor/useTacticStore'
import { downloadTactic, parseTactic } from '../persistence/tacticFile'
import { toolLabels } from '../ui/labels'
import { ResetTacticDialog } from './ResetTacticDialog'

const simulationTools: ToolId[] = ['select', 'move', 'wait', 'qMove', 'pass', 'shoot', 'annotation', 'attack', 'strikeRange', 'slow', 'eZone']
const basicTools: ToolId[] = ['select', 'move', 'attack', 'strikeRange']

interface TopToolbarProps {
  libraryReady: boolean
  libraryBusy: boolean
  onOpenLibrary: () => void
  onCreateDocument: () => Promise<void>
  onImportDocument: (document: TacticDocumentV1) => Promise<void>
  mobile?: boolean
  mobileActionsOpen?: boolean
  onMobileActionsOpenChange?: (open: boolean) => void
}

export function TopToolbar({
  libraryReady,
  libraryBusy,
  onOpenLibrary,
  onCreateDocument,
  onImportDocument,
  mobile = false,
  mobileActionsOpen = false,
  onMobileActionsOpenChange,
}: TopToolbarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const resetButtonRef = useRef<HTMLButtonElement>(null)
  const mobileActionsButtonRef = useRef<HTMLButtonElement>(null)
  const [resetStage, setResetStage] = useState<0 | 1 | 2>(0)
  const document = useTacticStore((state) => state.document)
  const boardMode = useTacticStore((state) => state.boardMode)
  const setBoardMode = useTacticStore((state) => state.setBoardMode)
  const tool = useTacticStore((state) => state.tool)
  const setTool = useTacticStore((state) => state.setTool)
  const analysis = document.view.analysis
  const setAnalysis = useTacticStore((state) => state.setAnalysis)
  const setRulesOpen = useTacticStore((state) => state.setRulesOpen)
  const setLogicOpen = useTacticStore((state) => state.setLogicOpen)
  const showRules = useTacticStore((state) => state.showRules)
  const showLogic = useTacticStore((state) => state.showLogic)
  const setNotice = useTacticStore((state) => state.setNotice)
  const resetTactic = useTacticStore((state) => state.resetTactic)
  const undo = useTacticStore((state) => state.undo)
  const redo = useTacticStore((state) => state.redo)
  const canUndo = useTacticStore((state) => state.past.length > 0)
  const canRedo = useTacticStore((state) => state.future.length > 0)
  const displayedTools = boardMode === 'basic' ? basicTools : simulationTools
  const activeResetStage = resetStage === 0 ? null : resetStage

  async function importFile(file: File | undefined) {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setNotice('导入失败：文件超过 2 MB。')
      return
    }
    const result = parseTactic(await file.text())
    if (result.ok) await onImportDocument(result.document)
    else setNotice(`导入失败：${result.error}`)
  }

  function closeResetDialog() {
    setResetStage(0)
    window.setTimeout(() => (mobile ? mobileActionsButtonRef.current : resetButtonRef.current)?.focus(), 0)
  }

  function confirmReset() {
    resetTactic()
    closeResetDialog()
  }

  function closeMobileActions(restoreFocus = false) {
    onMobileActionsOpenChange?.(false)
    if (restoreFocus) window.setTimeout(() => mobileActionsButtonRef.current?.focus(), 0)
  }

  return (
    <header className="topbar">
      <div className="brand-block">
        <div className="brand-mark">T</div>
        <div>
          <h1>提瓦特世界杯</h1>
          <p>{boardMode === 'basic' ? '3v3 基础战术板' : '3v3 战术推演板'}</p>
        </div>
      </div>

      <div className="mode-switch" role="group" aria-label="战术板模式">
        <button className={boardMode === 'simulation' ? 'active' : ''} aria-pressed={boardMode === 'simulation'} onClick={() => setBoardMode('simulation')}>推演模式</button>
        <button className={boardMode === 'basic' ? 'active' : ''} aria-pressed={boardMode === 'basic'} onClick={() => setBoardMode('basic')}>基础模式</button>
      </div>

      <nav className="tool-strip" aria-label="绘制工具">
        {displayedTools.map((item) => (
          <button
            key={item}
            className={`tool-button ${tool === item ? 'active' : ''}`}
            onClick={() => setTool(tool === item ? 'select' : item)}
            aria-pressed={tool === item}
            title={`${boardMode === 'basic' && item === 'move' ? '移动箭头' : toolLabels[item].label} (${toolLabels[item].shortcut})`}
          >
            <ToolIcon tool={item} />
            <span>{boardMode === 'basic' && item === 'move' ? '移动箭头' : toolLabels[item].label}</span>
          </button>
        ))}
      </nav>

      {mobile && <button
        ref={mobileActionsButtonRef}
        type="button"
        className="mobile-actions-trigger"
        aria-haspopup="dialog"
        aria-expanded={mobileActionsOpen}
        aria-controls="mobile-workspace-actions"
        onClick={() => onMobileActionsOpenChange?.(!mobileActionsOpen)}
      ><span aria-hidden="true">⋯</span><small>功能</small></button>}

      {mobile && mobileActionsOpen && <button type="button" className="mobile-actions-backdrop" aria-label="关闭功能面板" onClick={() => closeMobileActions(true)} />}
      <div
        id={mobile ? 'mobile-workspace-actions' : undefined}
        className={`top-actions ${mobileActionsOpen ? 'mobile-open' : ''}`}
        hidden={mobile && !mobileActionsOpen}
        role={mobile ? 'dialog' : undefined}
        aria-modal={mobile ? true : undefined}
        aria-labelledby={mobile ? 'mobile-workspace-actions-title' : undefined}
      >
        {mobile && <div className="mobile-actions-header">
          <strong id="mobile-workspace-actions-title">战术功能</strong>
          <button type="button" onClick={() => closeMobileActions(true)} aria-label="关闭战术功能">×</button>
        </div>}
        <div className="undo-group">
          <button className="icon-button" onClick={undo} disabled={!canUndo} aria-label="撤销" title="撤销 (Ctrl+Z)">↶</button>
          <button className="icon-button" onClick={redo} disabled={!canRedo} aria-label="重做" title="重做 (Ctrl+Y)">↷</button>
        </div>
        {boardMode === 'simulation' && <>
          <button className={`quiet-button ${analysis ? 'active' : ''}`} onClick={() => { setAnalysis(!analysis); closeMobileActions() }} aria-pressed={analysis}>分析层</button>
          <button className="quiet-button" onClick={() => { setLogicOpen(true); closeMobileActions() }} aria-haspopup="dialog" aria-expanded={showLogic}>逻辑说明</button>
          <button className="quiet-button" onClick={() => { setRulesOpen(true); closeMobileActions() }} aria-haspopup="dialog" aria-expanded={showRules}>规则设置</button>
        </>}
        <div className="file-menu">
          <button className="quiet-button" onClick={() => { onOpenLibrary(); closeMobileActions() }} aria-haspopup="dialog">我的战术</button>
          <button className="quiet-button" disabled={!libraryReady || libraryBusy} onClick={() => { inputRef.current?.click(); closeMobileActions() }}>导入</button>
          <input ref={inputRef} type="file" accept=".json,.teyvat-tactic.json,application/json" hidden onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = '' }} />
          <button className="accent-button" onClick={() => { downloadTactic(document); closeMobileActions() }}>导出战术</button>
          <button ref={resetButtonRef} className="quiet-button reset-trigger" onClick={() => { setResetStage(1); closeMobileActions() }} aria-haspopup="dialog">重置</button>
          <button className="icon-button" disabled={!libraryReady || libraryBusy} onClick={() => { void onCreateDocument(); closeMobileActions() }} aria-label="新建战术" title="新建战术">＋</button>
        </div>
      </div>
      {activeResetStage !== null && (
        <ResetTacticDialog
          stage={activeResetStage}
          onCancel={closeResetDialog}
          onContinue={() => setResetStage(2)}
          onBack={() => setResetStage(1)}
          onConfirm={confirmReset}
        />
      )}
    </header>
  )
}

function ToolIcon({ tool }: { tool: ToolId }) {
  const symbols: Record<ToolId, string> = {
    select: '⌖',
    move: '↝',
    wait: 'Ⅱ',
    qMove: 'ϟ',
    pass: '⇢',
    shoot: '◉',
    annotation: '✎',
    attack: '✦',
    strikeRange: '◌',
    slow: '❅',
    eZone: '❄',
  }
  return <span className="tool-symbol" aria-hidden="true">{symbols[tool]}</span>
}
