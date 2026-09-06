/** Matches the board's existing 90 px opening at 50 px per grid. */
export function goalOpening(height: number): { top: number; bottom: number } {
  const half = Math.min(0.9, height / 2)
  return { top: height / 2 - half, bottom: height / 2 + half }
}
