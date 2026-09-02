import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface ResetTacticDialogProps {
  stage: 1 | 2
  onCancel: () => void
  onContinue: () => void
  onBack: () => void
  onConfirm: () => void
}

export function ResetTacticDialog({ stage, onCancel, onContinue, onBack, onConfirm }: ResetTacticDialogProps) {
  const safeFocusRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    safeFocusRef.current?.focus()
  }, [stage])

  const titleId = `reset-tactic-title-${stage}`
  const descriptionId = `reset-tactic-description-${stage}`

  return createPortal(
    <div
      className="confirm-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <section
        className={`reset-dialog ${stage === 2 ? 'final-stage' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <span className="eyebrow">RESET TACTIC · {stage}/2</span>
        <h2 id={titleId}>{stage === 1 ? '重置当前战术？' : '最后确认'}</h2>
        <p id={descriptionId}>
          {stage === 1
            ? '将清除全部动作、步骤、站位调整、球权、规则修改和移动箭头，并恢复默认初始状态。'
            : '确认后会立即覆盖当前战术内容并清空撤销记录；“我的战术”中的已有历史版本不会被删除。'}
        </p>
        <div className="reset-dialog-actions">
          {stage === 1 ? <>
            <button className="quiet-button" onClick={onCancel}>取消</button>
            <button ref={safeFocusRef} className="accent-button" onClick={onContinue}>继续</button>
          </> : <>
            <button className="confirm-danger-button" onClick={onConfirm}>确认重置</button>
            <button ref={safeFocusRef} className="quiet-button" onClick={onBack}>返回上一步</button>
          </>}
        </div>
      </section>
    </div>,
    document.body,
  )
}
