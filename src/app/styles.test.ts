import { describe, expect, it } from 'vitest'
import styles from './styles.css?raw'

function customProperty(name: string) {
  return styles.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim()
}

describe('movement effect palette', () => {
  it('keeps hang ice visually distinct from the water Q boost', () => {
    expect(customProperty('hang-ice')).toBeTruthy()
    expect(customProperty('water-q-boost')).toBeTruthy()
    expect(customProperty('hang-ice')).not.toBe(customProperty('water-q-boost'))

    expect(styles).toMatch(/\.water-q-boost-segment\s*\{[^}]*stroke-linecap:round;[^}]*stroke-dasharray:13 7;/)
    expect(styles).toMatch(/\.status-slow-segment\s*\{[^}]*stroke-linecap:butt;[^}]*stroke-dasharray:2 4 12 4;/)
  })
})
