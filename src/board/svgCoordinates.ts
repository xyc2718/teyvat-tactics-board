import type { Vec2 } from '../domain/model/types'

export interface SvgViewportRect {
  left: number
  top: number
  width: number
  height: number
}

export interface SvgViewBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Converts a browser client point into an SVG viewBox point for the board's
 * explicit `xMidYMid meet` rendering mode. The SVG element itself can be much
 * wider or taller than the rendered viewBox, leaving centered letterboxing
 * that must not participate in the coordinate scale.
 */
export function clientPointToSvgViewBox(
  clientPoint: Vec2,
  viewport: SvgViewportRect,
  viewBox: SvgViewBox,
): Vec2 {
  if (viewport.width <= 0 || viewport.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) {
    return { x: viewBox.x, y: viewBox.y }
  }

  const scale = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height)
  const renderedWidth = viewBox.width * scale
  const renderedHeight = viewBox.height * scale
  const renderedLeft = viewport.left + (viewport.width - renderedWidth) / 2
  const renderedTop = viewport.top + (viewport.height - renderedHeight) / 2

  return {
    x: viewBox.x + (clientPoint.x - renderedLeft) / scale,
    y: viewBox.y + (clientPoint.y - renderedTop) / scale,
  }
}
