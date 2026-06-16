/**
 * Format time remaining until a timeout expiry.
 *
 * Shared across all watcher extensions that display a countdown.
 */

/**
 * Format the time remaining until a timeout, or special labels for
 * undefined / expired timeouts.
 *
 * @param timeoutAt  Absolute timestamp (ms since epoch) of the timeout, or
 *                   `undefined` for "no timeout".
 * @param now        Current timestamp (ms since epoch).
 */
export function formatTimeLeft(timeoutAt: number | undefined, now: number): string {
  if (timeoutAt === undefined) return '-'
  const remainingMs = timeoutAt - now
  if (remainingMs <= 0) return 'expired'
  const s = Math.ceil(remainingMs / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rem = s % 60
  if (h >= 1) return `${h}h left`
  if (m >= 1) return `${m}m left`
  return `${rem}s left`
}
