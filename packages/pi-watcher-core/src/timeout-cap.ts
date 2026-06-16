/**
 * Cap a requested timeout duration and compute the absolute timeout timestamp.
 *
 * Shared by EC2 and S3 watchers (and any future watcher that accepts a
 * user-supplied `timeoutSeconds` parameter).
 */

export interface TimeoutCapResult {
  /** The effective timeout in seconds (never exceeds `maxSeconds`). */
  effectiveSeconds: number
  /** True when `requestedSeconds` was above `maxSeconds` and was silently capped. */
  capped: boolean
  /** Absolute timestamp (ms since epoch) at which the watch expires. */
  timeoutAt: number
}

/**
 * Cap `requestedSeconds` at `maxSeconds` and compute the absolute timeout.
 *
 * @param requestedSeconds  Caller-supplied timeout, or `undefined` to use the maximum.
 * @param maxSeconds        Hard ceiling (e.g. `MAX_TIMEOUT_SECONDS`).
 * @param now               Current timestamp in ms (injected for testability).
 */
export function capTimeoutSeconds(
  requestedSeconds: number | undefined,
  maxSeconds: number,
  now: number,
): TimeoutCapResult {
  const capped = requestedSeconds !== undefined && requestedSeconds > maxSeconds
  const effectiveSeconds =
    requestedSeconds !== undefined ? Math.min(requestedSeconds, maxSeconds) : maxSeconds
  return { effectiveSeconds, capped, timeoutAt: now + effectiveSeconds * 1000 }
}
