import { describe, expect, it } from 'vitest'
import { formatTimeLeft } from '../src/time-left.js'

describe('formatTimeLeft', () => {
  it('returns "-" when timeoutAt is undefined', () => {
    expect(formatTimeLeft(undefined, 1_000)).toBe('-')
  })

  it('returns "expired" when timeout has already passed', () => {
    expect(formatTimeLeft(1000, 2000)).toBe('expired')
  })

  it('returns "expired" when timeout equals now', () => {
    expect(formatTimeLeft(5000, 5000)).toBe('expired')
  })

  it('returns Xs left for sub-minute remainder', () => {
    expect(formatTimeLeft(31_000, 1_000)).toBe('30s left')
  })

  it('returns Xm left for remainder < 1 h', () => {
    expect(formatTimeLeft(121_000, 1_000)).toBe('2m left')
  })

  it('returns Xh left for remainder >= 1 h', () => {
    expect(formatTimeLeft(3_601_000, 1_000)).toBe('1h left')
  })

  it('rounds up partial seconds', () => {
    // 30.5 s remaining → ceil → 31 s
    expect(formatTimeLeft(31_500, 1_000)).toBe('31s left')
  })

  it('returns Xh left for multi-hour remainder', () => {
    expect(formatTimeLeft(3 * 3600_000 + 1_000, 0)).toBe('3h left')
  })
})
