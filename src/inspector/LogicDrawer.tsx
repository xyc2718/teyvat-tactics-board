import { useEffect, useMemo, useRef } from 'react'
import { buildTacticNarrative } from '../domain/narrative/buildTacticNarrative'
import { useTacticStore } from '../editor/useTacticStore'

export function LogicDrawer() {
  const open = useTacticStore((state) => state.showLogic)
  const close = useTacticStore((state) => state.setLogicOpen)
  const tacticDocument = useTacticStore((state) => state.document)
  const narrative = useMemo(() => buildTacticNarrative(tacticDocument), [tacticDocument])
  const drawerRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [close, open])

  if (!open) return null
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(false) }}>
    <aside ref={drawerRef} className="logic-drawer" role="dialog" aria-modal="true" aria-labelledby="logic-drawer-title">
      <div className="drawer-head">
        <div><span className="eyebrow">LIVE EXPLANATION</span><h2 id="logic-drawer-title">逻辑说明</h2><p>按当前动作、投影状态和规则即时生成，不会写入战术文件。</p></div>
        <button ref={closeButtonRef} className="drawer-close" onClick={() => close(false)} aria-label="关闭逻辑说明">×</button>
      </div>
      <div className="logic-drawer-body">
        <section aria-labelledby="logic-timeline-title">
          <h3 id="logic-timeline-title">时序讲解</h3>
          {narrative.entries.length === 0 ? <p className="logic-empty">添加动作后，这里会按时间说明战术逻辑。</p> : <ol className="logic-timeline">
            {narrative.entries.map((entry) => <li key={entry.id} className={`logic-entry kind-${entry.kind}`}>
              <time>{entry.time.toFixed(2)}s</time><div><strong>{entry.title}</strong><p>{entry.detail}</p></div>
            </li>)}
          </ol>}
        </section>
        <section className="logic-hard-warnings" aria-labelledby="logic-warning-title">
          <h3 id="logic-warning-title">硬性警告</h3>
          {narrative.hardWarnings.length === 0 ? <p className="logic-clear">当前没有硬性规则冲突。</p> : <ul>
            {narrative.hardWarnings.map((warning) => <li key={warning.id}><strong>{warning.title}</strong><p>{warning.detail}</p></li>)}
          </ul>}
        </section>
      </div>
    </aside>
  </div>
}
