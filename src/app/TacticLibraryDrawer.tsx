import { useEffect, useRef, useState } from 'react'
import { MAX_TACTIC_SNAPSHOTS, type TacticSnapshotSummary } from '../persistence/tacticLibrary'
import type { TacticLibraryController } from './useTacticLibraryController'

function formatSavedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export function TacticLibraryDrawer({ controller }: { controller: TacticLibraryController }) {
  const {
    isOpen,
    setOpen,
    ready,
    busy,
    activeId,
    entries,
    createNew,
    openTactic,
    duplicateTactic,
    deleteTactic,
    loadSnapshots,
    restoreSnapshot,
    backupAll,
    restoreBackup,
  } = controller
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [snapshotState, setSnapshotState] = useState<{ tacticId: string | null; items: TacticSnapshotSummary[] }>({ tacticId: null, items: [] })
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeId, isOpen, setOpen])

  useEffect(() => {
    let cancelled = false
    if (!isOpen || !historyId) return
    void loadSnapshots(historyId).then((next) => {
      if (!cancelled) setSnapshotState({ tacticId: historyId, items: next })
    })
    return () => { cancelled = true }
  }, [entries, historyId, isOpen, loadSnapshots])

  if (!isOpen) return null

  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
    <aside className="library-drawer" role="dialog" aria-modal="true" aria-labelledby="library-drawer-title">
      <div className="drawer-head library-head">
        <div>
          <span className="eyebrow">LOCAL TACTIC LIBRARY</span>
          <h2 id="library-drawer-title">我的战术</h2>
          <p>仅保存在当前浏览器中；每个战术自动保留最近 {MAX_TACTIC_SNAPSHOTS} 个版本。</p>
        </div>
        <button ref={closeButtonRef} className="drawer-close" onClick={() => setOpen(false)} aria-label="关闭我的战术">×</button>
      </div>

      <div className="library-actions">
        <button className="accent-button" disabled={!ready || busy} onClick={() => void createNew()}>＋ 新建战术</button>
        <button className="quiet-button" disabled={!ready || busy} onClick={() => void backupAll()}>备份全部</button>
        <button className="quiet-button" disabled={!ready || busy} onClick={() => backupInputRef.current?.click()}>恢复备份</button>
        <input
          ref={backupInputRef}
          hidden
          type="file"
          accept=".json,.teyvat-library.json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.currentTarget.value = ''
            if (file && window.confirm('恢复备份将替换当前浏览器中的全部战术，是否继续？')) void restoreBackup(file)
          }}
        />
      </div>

      <div className="library-body">
        {!ready && <div className="library-empty">正在准备本地战术库……</div>}
        {ready && entries.length === 0 && <div className="library-empty">还没有保存的战术。</div>}
        <div className="library-list">
          {entries.map((entry) => {
            const active = entry.id === activeId
            const expanded = entry.id === historyId
            const snapshots = snapshotState.tacticId === entry.id ? snapshotState.items : []
            return <article key={entry.id} className={`library-card ${active ? 'active' : ''}`}>
              <button className="library-card-main" onClick={() => setHistoryId(expanded ? null : entry.id)} aria-expanded={expanded}>
                <span className="library-title-row"><strong>{entry.title || '未命名战术'}</strong>{active && <em>正在编辑</em>}</span>
                <span>{formatSavedAt(entry.updatedAt)} · {entry.actionCount} 个动作 · {entry.snapshotCount} 个版本</span>
              </button>
              <div className="library-card-actions">
                <button disabled={active || busy} onClick={() => void openTactic(entry.id)}>打开</button>
                <button disabled={busy} onClick={() => void duplicateTactic(entry.id)}>复制</button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`确定删除“${entry.title || '未命名战术'}”吗？`)) void deleteTactic(entry.id)
                  }}
                >删除</button>
              </div>
              {expanded && <div className="snapshot-list" aria-label={`${entry.title || '未命名战术'}的历史版本`}>
                <h3>历史版本</h3>
                {snapshots.length === 0
                  ? <p>暂无历史版本。</p>
                  : snapshots.map((snapshot, index) => <div className="snapshot-row" key={snapshot.id}>
                    <span><strong>{index === 0 ? '最新' : formatSavedAt(snapshot.savedAt)}</strong><small>{snapshot.actionCount} 个动作</small></span>
                    <button disabled={busy} onClick={() => void restoreSnapshot(entry.id, snapshot.id)}>恢复</button>
                  </div>)}
              </div>}
            </article>
          })}
        </div>
      </div>
      <footer className="library-footer">清除浏览器网站数据会删除这些记录，请定期使用“备份全部”。</footer>
    </aside>
  </div>
}
