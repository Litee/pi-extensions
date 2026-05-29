import { execSync } from 'node:child_process'

/**
 * Returns a list of known AWS profile names by shelling out to
 * `aws configure list-profiles`. Returns an empty array if the
 * aws CLI is unavailable or the command fails.
 */
function listAwsProfiles(): string[] {
  try {
    return execSync('aws configure list-profiles', { encoding: 'utf8', timeout: 3000 })
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Validates that `profile` exists in the user's AWS config.
 * Returns null if valid (or if the aws CLI is unavailable — fail open).
 * Returns an error message string if the profile is not found.
 */
export function validateAwsProfile(profile: string): string | null {
  const known = listAwsProfiles()
  if (known.length === 0) return null // aws CLI not available — fail open
  if (known.includes(profile)) return null
  return `profile '${profile}' not found — known profiles: ${known.join(', ')}`
}
