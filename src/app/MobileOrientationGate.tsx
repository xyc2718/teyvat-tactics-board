import { useState } from 'react'

type OrientationRequestState = 'idle' | 'requesting' | 'requested' | 'manual'

export function MobileOrientationGate() {
  const [requestState, setRequestState] = useState<OrientationRequestState>('idle')

  async function requestLandscape() {
    setRequestState('requesting')
    let locked = false

    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen()
      }
    } catch {
      // Some browsers reject fullscreen but still allow a subsequent orientation request.
    }

    const orientation = window.screen.orientation as ScreenOrientation | undefined
    if (typeof orientation?.lock === 'function') {
      try {
        await orientation.lock('landscape')
        locked = true
      } catch {
        locked = false
      }
    }

    setRequestState(locked ? 'requested' : 'manual')
  }

  return (
    <main className="mobile-orientation-gate">
      <section className="orientation-card" aria-labelledby="orientation-title">
        <div className="orientation-phone" aria-hidden="true"><span>↻</span></div>
        <span className="eyebrow">手机横屏模式</span>
        <h1 id="orientation-title">请将手机旋转为横屏</h1>
        <p>横屏会保留完整球场和触控工具；竖屏下不压缩战术编辑区域。</p>
        <button
          type="button"
          className="orientation-action"
          disabled={requestState === 'requesting'}
          onClick={() => void requestLandscape()}
        >{requestState === 'requesting' ? '正在请求…' : '尝试切换横屏'}</button>
        <p className="orientation-status" aria-live="polite">
          {requestState === 'requested' && '已请求横屏；如果画面没有旋转，请关闭系统方向锁后手动旋转。'}
          {requestState === 'manual' && '此浏览器无法自动旋转。请关闭系统方向锁，再将手机横放。'}
          {requestState === 'idle' && '部分浏览器会先进入全屏；这是方向锁 API 的系统要求。'}
        </p>
      </section>
    </main>
  )
}
