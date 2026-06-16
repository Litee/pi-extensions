import { describe, expect, it } from 'vitest'
import { classifyAwsError, AUTH_ERROR_NAMES, THROTTLE_ERROR_NAMES } from '../../src/aws/classify-error.js'

function mkErr(name: string): Error {
  return Object.assign(new Error(`simulated ${name}`), { name })
}

describe('AUTH_ERROR_NAMES', () => {
  it('contains CredentialsProviderError', () => {
    expect(AUTH_ERROR_NAMES.has('CredentialsProviderError')).toBe(true)
  })
  it('contains TokenProviderError', () => {
    expect(AUTH_ERROR_NAMES.has('TokenProviderError')).toBe(true)
  })
  it('contains ProviderError', () => {
    expect(AUTH_ERROR_NAMES.has('ProviderError')).toBe(true)
  })
  it('contains ExpiredToken (was missing from Glue)', () => {
    expect(AUTH_ERROR_NAMES.has('ExpiredToken')).toBe(true)
  })
  it('contains ExpiredTokenException (was missing from Glue)', () => {
    expect(AUTH_ERROR_NAMES.has('ExpiredTokenException')).toBe(true)
  })
})

describe('THROTTLE_ERROR_NAMES', () => {
  it('contains ThrottlingException', () => {
    expect(THROTTLE_ERROR_NAMES.has('ThrottlingException')).toBe(true)
  })
  it('contains TooManyRequestsException', () => {
    expect(THROTTLE_ERROR_NAMES.has('TooManyRequestsException')).toBe(true)
  })
  it('contains SlowDown (was missing from Glue)', () => {
    expect(THROTTLE_ERROR_NAMES.has('SlowDown')).toBe(true)
  })
  it('contains RequestLimitExceeded (was missing from Glue)', () => {
    expect(THROTTLE_ERROR_NAMES.has('RequestLimitExceeded')).toBe(true)
  })
})

describe('classifyAwsError', () => {
  it.each([
    'CredentialsProviderError',
    'TokenProviderError',
    'ProviderError',
    'ExpiredToken',
    'ExpiredTokenException',
  ])('classifies %s as auth error', (name) => {
    const result = classifyAwsError(mkErr(name))
    expect(result.kind).toBe('auth')
    expect(result.statusModifier).toBe('auth-error')
    expect(result.shouldBackoff).toBe(false)
    expect(result.userMessage).toMatch(/authentication expired/)
  })

  it.each([
    'ThrottlingException',
    'TooManyRequestsException',
    'SlowDown',
    'RequestLimitExceeded',
  ])('classifies %s as throttle error with backoff', (name) => {
    const result = classifyAwsError(mkErr(name))
    expect(result.kind).toBe('throttle')
    expect(result.statusModifier).toBe('throttled')
    expect(result.shouldBackoff).toBe(true)
    expect(result.userMessage).toMatch(/throttled/)
  })

  it('classifies unknown error as generic', () => {
    const result = classifyAwsError(mkErr('SomeUnknownError'))
    expect(result.kind).toBe('generic')
    expect(result.statusModifier).toBe('none')
    expect(result.shouldBackoff).toBe(false)
    expect(result.userMessage).toMatch(/poll failed/)
  })

  it('classifies null as generic', () => {
    const result = classifyAwsError(null)
    expect(result.kind).toBe('generic')
  })

  it('uses custom authMessage when provided', () => {
    const result = classifyAwsError(mkErr('ExpiredToken'), 'run aws sso login')
    expect(result.userMessage).toBe('run aws sso login')
  })

  it('uses default authMessage when not provided', () => {
    const result = classifyAwsError(mkErr('ExpiredToken'))
    expect(result.userMessage).toBe('authentication expired — refresh AWS credentials')
  })
})
