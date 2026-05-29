import { describe, expect, it, vi, afterEach } from 'vitest'

// Mock node:child_process before importing the module under test.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'node:child_process'
import { validateAwsProfile } from '../src/validate-aws-profile.js'

const mockExecSync = execSync as ReturnType<typeof vi.fn>

afterEach(() => {
  vi.resetAllMocks()
})

describe('validateAwsProfile', () => {
  it('returns null for a known profile', () => {
    mockExecSync.mockReturnValue('default\nprod\ndev\n')
    expect(validateAwsProfile('prod')).toBeNull()
  })

  it('returns an error string for an unknown profile that includes the profile name and known profiles', () => {
    mockExecSync.mockReturnValue('default\nprod\ndev\n')
    const result = validateAwsProfile('nonexistent')
    expect(result).not.toBeNull()
    expect(result).toContain("'nonexistent'")
    expect(result).toContain('default')
    expect(result).toContain('prod')
    expect(result).toContain('dev')
  })

  it('returns null when aws CLI is unavailable (execSync throws) — fail open', () => {
    mockExecSync.mockImplementation(() => { throw new Error('aws: command not found') })
    expect(validateAwsProfile('anyprofile')).toBeNull()
  })

  it('returns null when aws CLI produces empty output — fail open', () => {
    mockExecSync.mockReturnValue('\n\n   \n')
    expect(validateAwsProfile('anyprofile')).toBeNull()
  })
})
