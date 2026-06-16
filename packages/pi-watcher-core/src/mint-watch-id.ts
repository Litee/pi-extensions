/**
 * Generate a random watch identifier.
 *
 * Produces a 4-byte hex string (8 hex characters), e.g. `"a1b2c3d4"`.
 * Shared across all watcher extensions that need stable watch IDs.
 */

import { randomBytes } from 'node:crypto'

/**
 * Generate a random 4-byte hex string suitable for use as a watch ID.
 */
export function mintWatchId(): string {
  return randomBytes(4).toString('hex')
}
