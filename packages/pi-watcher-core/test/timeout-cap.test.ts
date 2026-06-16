import { describe, expect, it } from 'vitest'
import { capTimeoutSeconds } from '../src/timeout-cap.js'

describe('capTimeoutSeconds', () => {
  const MAX = 1000
  const NOW = 100_000

  it('uses maxSeconds when requestedSeconds is undefined', () => {
    const result = capTimeoutSeconds(undefined, MAX, NOW)
    expect(result.effectiveSeconds).toBe(MAX)
    expect(result.capped).toBe(false)
    expect(result.timeoutAt).toBe(NOW + MAX * 1000)
  })

  it('uses requestedSeconds when below maximum', () => {
    const result = capTimeoutSeconds(300, MAX, NOW)
    expect(result.effectiveSeconds).toBe(300)
    expect(result.capped).toBe(false)
    expect(result.timeoutAt).toBe(NOW + 300 * 1000)
  })

  it('caps to maxSeconds and sets capped=true when requestedSeconds exceeds max', () => {
    const result = capTimeoutSeconds(2000, MAX, NOW)
    expect(result.effectiveSeconds).toBe(MAX)
    expect(result.capped).toBe(true)
    expect(result.timeoutAt).toBe(NOW + MAX * 1000)
  })

  it('does not cap when requestedSeconds exactly equals maxSeconds', () => {
    const result = capTimeoutSeconds(MAX, MAX, NOW)
    expect(result.effectiveSeconds).toBe(MAX)
    expect(result.capped).toBe(false)
  })

  it('computes timeoutAt as now + effectiveSeconds * 1000', () => {
    const { timeoutAt, effectiveSeconds } = capTimeoutSeconds(500, MAX, NOW)
    expect(timeoutAt).toBe(NOW + effectiveSeconds * 1000)
  })
})
