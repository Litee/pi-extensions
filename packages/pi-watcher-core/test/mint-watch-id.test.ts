import { describe, expect, it } from 'vitest'
import { mintWatchId } from '../src/mint-watch-id.js'

describe('mintWatchId', () => {
  it('returns an 8-character hexadecimal string', () => {
    const id = mintWatchId()
    expect(id).toHaveLength(8)
    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })

  it('returns a different value on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintWatchId()))
    // With 100 random 4-byte values the probability of any collision is
    // astronomically small (Birthday problem: ~1.2e-6). Just verify we
    // get many distinct values as a basic uniqueness smoke-test.
    expect(ids.size).toBeGreaterThan(90)
  })
})
