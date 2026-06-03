/**
 * Chat-message and status-line formatters for pi-git-watcher.
 *
 * Pure functions — no I/O, no timers, no runtime state.
 */

import { formatShortTime } from "pi-watcher-core/time";
import {
  type StatusLineColorAlias,
} from "pi-watcher-core/status-line";

import type { GitEvent, WatchMap } from "./types.js";

export type { StatusLineColorAlias } from "pi-watcher-core/status-line";

export interface StatusLineResult {
  text: string;
  colorAlias: StatusLineColorAlias;
}

/**
 * Build the chat-message content for a detected-change notification.
 *
 * Format:
 * ```
 * [10:30] 2 changes detected
 *
 * • my-repo [main]: new commit abc1234 — feat: add thing ✓
 * ```
 */
export function buildChangeChatMessage(events: GitEvent[], date: Date): string {
  const noun = events.length === 1 ? "change" : "changes";
  const header = `[${formatShortTime(date)}] ${events.length} ${noun} detected`;
  const bullets = events.map((e) => e.formatted).join("\n");
  return `${header}\n\n${bullets}`;
}

/**
 * Build the row shown in the pi status-line.
 *
 * | State            | Row                               | Alias    |
 * |------------------|-----------------------------------|----------|
 * | Idle             | `git: idle`                       | muted    |
 * | Active           | `git: 3`                          | accent   |
 * | Active + errors  | `git: 3 | ⚠ errors`               | warning  |
 * | Paused           | `git: 3 (paused)`                 | muted    |
 * | Paused + errors  | `git: 3 | ⚠ errors (paused)`      | warning  |
 */
export function buildStatusLine(
  watches: WatchMap,
  paused: boolean,
  hasErrors: boolean,
): StatusLineResult {
  const active = Object.values(watches).filter((w) => !w.terminal);
  if (active.length === 0) return { text: "git: idle", colorAlias: "muted" };

  const parts: string[] = [`${active.length}`];
  if (hasErrors) parts.push("⚠ errors");

  const body = parts.join(" | ");
  const text = paused ? `git: ${body} (paused)` : `git: ${body}`;
  const colorAlias: StatusLineColorAlias = hasErrors
    ? "warning"
    : paused ? "muted" : "accent";
  return { text, colorAlias };
}
