/**
 * AWS-specific error classification for watcher extensions.
 *
 * Centralises the `AUTH_ERROR_NAMES` and `THROTTLE_ERROR_NAMES` sets that
 * were copy-pasted (with a latent omission in the Glue watcher) across
 * pi-aws-ec2-watcher, pi-aws-s3-watcher, and pi-aws-glue-watcher.
 *
 * Using this module fixes the Glue latent bug: `ExpiredToken`,
 * `ExpiredTokenException`, `SlowDown`, and `RequestLimitExceeded` were
 * absent from its error sets and would have been mis-classified as generic
 * errors.
 */

import type { ClassifiedWatcherError } from '../classify-error.js'

// ---------------------------------------------------------------------------
// Error-name sets
// ---------------------------------------------------------------------------

/** AWS SDK v3 error names that indicate expired or missing credentials. */
export const AUTH_ERROR_NAMES: ReadonlySet<string> = new Set([
  'CredentialsProviderError',
  'TokenProviderError',
  'ProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
])

/** AWS SDK v3 error names that indicate request throttling. */
export const THROTTLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'SlowDown',
  'RequestLimitExceeded',
])

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a caught AWS SDK error into a `ClassifiedWatcherError`.
 *
 * @param err          The caught value (usually an AWS SDK error).
 * @param authMessage  Override the default auth user-message.
 */
export function classifyAwsError(
  err: unknown,
  authMessage?: string,
): ClassifiedWatcherError {
  const name = (err as Error)?.name ?? ''
  if (AUTH_ERROR_NAMES.has(name)) {
    return {
      userMessage: authMessage ?? 'authentication expired — refresh AWS credentials',
      kind: 'auth',
      shouldBackoff: false,
      statusModifier: 'auth-error',
    }
  }
  if (THROTTLE_ERROR_NAMES.has(name)) {
    return {
      userMessage: 'request throttled by AWS',
      kind: 'throttle',
      shouldBackoff: true,
      statusModifier: 'throttled',
    }
  }
  return {
    userMessage: 'poll failed — check AWS connectivity',
    kind: 'generic',
    shouldBackoff: false,
    statusModifier: 'none',
  }
}
