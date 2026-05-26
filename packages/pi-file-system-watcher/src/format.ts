/**
 * Chat-message and status-line formatters for pi-file-system-watcher.
 *
 * Pure functions — no I/O, no timers, no runtime state.
 */

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";
import { statusLineColorAlias, type StatusLineColorAlias } from "pi-watcher-core/status-line";
import { formatShortTime } from "pi-watcher-core/time";

export type { StatusLineColorAlias } from "pi-watcher-core/status-line";

import type { FsEvent, WatchMap } from "./types.js";

// ---------------------------------------------------------------------------
// buildStatusLine
// ---------------------------------------------------------------------------

export interface StatusLineResult {
	text: string;
	colorAlias: StatusLineColorAlias;
}

export interface StatusLineInput {
	watches: WatchMap;
	paused: boolean;
	hasErrors?: boolean;
}

/**
 * Build the row shown in the pi status-line.
 *
 * | State            | Row                              | Alias    |
 * |------------------|----------------------------------|----------|
 * | Idle             | `fs: idle`                       | muted    |
 * | Active           | `fs: 3`                          | accent   |
 * | Active + errors  | `fs: 3 | ⚠ errors`               | warning  |
 * | Paused           | `fs: 3 (paused)`                 | muted    |
 * | Paused + errors  | `fs: 3 | ⚠ errors (paused)`      | warning  |
 *
 * Terminal watches are excluded from the count.
 */
export function buildStatusLine(input: StatusLineInput): StatusLineResult {
	const { watches, paused, hasErrors } = input;
	const active = Object.values(watches).filter((w) => !w.terminal);
	if (active.length === 0) return { text: "fs: idle", colorAlias: "muted" };

	const parts: string[] = [`${active.length}`];
	if (hasErrors) parts.push("⚠ errors");

	const body = parts.join(" | ");
	const text = paused ? `fs: ${body} (paused)` : `fs: ${body}`;
	const colorAlias: StatusLineColorAlias =
		hasErrors ? "warning" : statusLineColorAlias(paused ? "paused" : "active");
	return { text, colorAlias };
}

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

// ---------------------------------------------------------------------------
// buildWatchSummaryHeader
// ---------------------------------------------------------------------------

/**
 * Build the header phrase summarising a watch list, honouring terminal state.
 *
 * - all active   → `active — watching N paths`
 * - mixed        → `watching N paths · K active, M done`
 * - all terminal → `watching N paths (N done)`
 *
 * Returns `undefined` when there are no watches.
 */
export function buildWatchSummaryHeader(watches: WatchMap): string | undefined {
	const all = Object.values(watches);
	if (all.length === 0) return undefined;
	const total = all.length;
	const done = all.filter((w) => w.terminal).length;
	const active = total - done;
	const noun = total === 1 ? "path" : "paths";
	if (done === 0) return `active — watching ${total} ${noun}`;
	if (active === 0) return `watching ${total} ${noun} (${done} done)`;
	return `watching ${total} ${noun} · ${active} active, ${done} done`;
}

// ---------------------------------------------------------------------------
// buildStartupChatMessage
// ---------------------------------------------------------------------------

/**
 * Build the chat-message content for the startup summary emitted when the
 * session resumes with an existing watch list.
 */
export function buildStartupChatMessage(watches: WatchMap, date: Date): string {
	const all = Object.values(watches);
	if (all.length === 0) {
		return "active — no watches configured. Use the file_system_watcher tool to add a watch.";
	}
	const lines = all.map((w) => {
		const hasErrors = w.consecutiveErrors >= DEFAULT_POLL_ERROR_THRESHOLD;
		const isWaiting = !w.terminal && !hasErrors;
		const tag = w.terminal ? " [terminal]" : "";
		if (isWaiting) {
			return `• ${w.path} (target: ${w.target}) — WAITING${tag}`;
		}
		const state = w.baseline === undefined
			? "?"
			: w.baseline.exists
				? "present"
				: "absent";
		return `• ${w.path} (target: ${w.target}) — state=${state}${tag}`;
	});
	const header = buildWatchSummaryHeader(watches) ?? "";
	return `[${formatShortTime(date)}] ${header}:\n\n${lines.join("\n")}`;
}
