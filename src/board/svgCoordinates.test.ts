import { describe, expect, it } from 'vitest'
import { clientPointToSvgViewBox } from './svgCoordinates'

const viewBox = { x: -36, y: -22, width: 1072, height: 744 }

describe('clientPointToSvgViewBox', () => {
  it('maps a point when the SVG element matches the viewBox aspect ratio', () => {
    expect(clientPointToSvgViewBox(
      { x: 436, y: 372 },
      { left: 0, top: 0, width: 1072, height: 744 },
      viewBox,
    )).toEqual({ x: 400, y: 350 })
  })

  it('ignores horizontal letterboxing in a wide SVG element', () => {
    expect(clientPointToSvgViewBox(
      { x: 700, y: 372 },
      { left: 0, top: 0, width: 1600, height: 744 },
      viewBox,
    )).toEqual({ x: 400, y: 350 })
  })

  it('ignores vertical letterboxing in a tall SVG element', () => {
    expect(clientPointToSvgViewBox(
      { x: 436, y: 350 },
      { left: 0, top: 0, width: 1072, height: 1000 },
      viewBox,
    )).toEqual({ x: 400, y: 200 })
  })
})
