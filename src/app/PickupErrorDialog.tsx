import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface PickupErrorDialogProps {
  message: string
  onDismiss: () => void
}

/** This portal never adds height to the pitch or changes its coordinate map. */
export function PickupErrorDialog({ message, onDismiss }: PickupErrorDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement
    closeRef.current?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement || previousFocus instanceof SVGElement) {
        if (previousFocus.isConnected) previousFocus.focus()
      }
    }
  }, [])

  return createPortal(
    <div
      className="confirm-backdrop pickup-error-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onDismiss()
        } else if (event.key === 'Tab') {
          event.preventDefault()
          closeRef.current?.focus()
        }
      }}
    >
      <section className="reset-dialog pickup-error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pickup-error-title" aria-describedby="pickup-error-description">
        <h2 id="pickup-error-title">无法完成捡球</h2>
        <p id="pickup-error-description">{message}</p>
        <p className="subtle">未提交此次修改。请调整动作或选择其他捡球方式。</p>
        <div className="reset-dialog-actions">
          <button ref={closeRef} type="button" className="accent-button" onClick={onDismiss}>知道了</button>
        </div>
      </section>
    </div>,
    document.body,
  )
}
