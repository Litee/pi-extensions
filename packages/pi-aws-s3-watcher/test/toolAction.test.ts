/**
 * Tests for the S3WatcherParams TypeBox schema and related constants.
 * Handler logic has moved to S3Watcher — see test/watcher.test.ts.
 */

import { describe, expect, it } from 'vitest'

import { MAX_TIMEOUT_SECONDS, S3WatcherParams, TARGETS } from '../src/toolAction.js'

describe('MAX_TIMEOUT_SECONDS', () => {
  it('equals 72 hours in seconds', () => {
    expect(MAX_TIMEOUT_SECONDS).toBe(72 * 60 * 60)
  })
})

describe('TARGETS', () => {
  it('contains the three valid conditions', () => {
    expect(TARGETS.has('exists')).toBe(true)
    expect(TARGETS.has('updated')).toBe(true)
    expect(TARGETS.has('removed')).toBe(true)
  })

  it('does not contain invalid conditions', () => {
    expect((TARGETS as ReadonlySet<string>).has('deleted')).toBe(false)
    expect((TARGETS as ReadonlySet<string>).has('')).toBe(false)
  })
})

describe('S3WatcherParams schema', () => {
  it('is an object schema with expected property names', () => {
    const schema = S3WatcherParams as {
      type: string
      properties: Record<string, unknown>
    }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['action', 'uri', 'target', 'profile', 'region', 'timeoutSeconds', 'watchId']),
    )
  })

  it('action property has union of all six actions', () => {
    const schema = S3WatcherParams as {
      properties: {
        action: { anyOf: Array<{ const: string }> }
      }
    }
    const literals = schema.properties.action.anyOf.map((l) => l.const)
    expect(literals).toEqual(
      expect.arrayContaining(['add', 'remove', 'list', 'pause', 'resume', 'status']),
    )
  })
})
