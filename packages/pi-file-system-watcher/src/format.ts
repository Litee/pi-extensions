/**
 * Chat-message formatters for pi-file-system-watcher.
 *
 * Pure functions — no I/O, no timers, no runtime state.
 */

import { formatShortTime } from "pi-watcher-core/time";

import type { FsEvent } from "./types.js";

// ---------------------------------------------------------------------------
// buildChangeChatMessage
// ---------------------------------------------------------------------------

/**
 * Build the chat-message content for a detected-change notification.
 *
 * Format:
 * ```
 * [10:30] 2 events detected
 *
 * • /tmp/file.txt now exists (42 bytes) ✓
 * • /tmp/other.txt timed out waiting for 'removed' ✗
 * ```
 */
export function buildChangeChatMessage(events: FsEvent[], date: Date): string {
  const noun = events.length === 1 ? "event" : "events";
  const header = `[${formatShortTime(date)}] ${events.length} ${noun} detected`;
  const bullets = events.map((e) => e.formatted).join("\n");
  return `${header}\n\n${bullets}`;
}
