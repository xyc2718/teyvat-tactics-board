import { useEffect, useState } from 'react'

export const PHONE_LIKE_MEDIA_QUERY = '(hover: none) and (pointer: coarse) and (max-width: 1180px)'
export const PORTRAIT_MEDIA_QUERY = '(orientation: portrait)'

export type DeviceLayout = 'desktop' | 'phone-portrait' | 'phone-landscape'

function mediaMatches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query))

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update)
      return () => media.removeEventListener('change', update)
    }
    media.addListener?.(update)
    return () => media.removeListener?.(update)
  }, [query])

  return matches
}

export function useDeviceLayout(): DeviceLayout {
  const isPhoneLike = useMediaQuery(PHONE_LIKE_MEDIA_QUERY)
  const isPortrait = useMediaQuery(PORTRAIT_MEDIA_QUERY)

  if (!isPhoneLike) return 'desktop'
  return isPortrait ? 'phone-portrait' : 'phone-landscape'
}
