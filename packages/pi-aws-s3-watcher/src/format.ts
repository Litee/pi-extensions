/**
 * Chat-message and status-line formatters for pi-aws-s3-watcher.
 *
 * Pure functions — no I/O, no timers, no runtime state.
 */

import type { S3Event, WatchMap } from "./types.js";
import { statusLineColorAlias, type StatusLineColorAlias } from "pi-watcher-core/status-line";
export type { StatusLineColorAlias } from "pi-watcher-core/status-line";

export interface StatusLineResult {
	text: string;
	colorAlias: StatusLineColorAlias;
}

export interface StatusLineInput {
	watches: WatchMap;
	paused: boolean;
	/** Kept for back-compat; no longer rendered. */
	pollIntervalMs: number;
	hasErrors?: boolean;
}

/**
 * Build the row shown in the pi status-line.
 *
 * | State            | Row                               | Alias    |
 * |------------------|-----------------------------------|----------|
 * | Idle             | `aws-s3: idle`                    | muted    |
 * | Active           | `aws-s3: 3`                       | accent   |
 * | Active + errors  | `aws-s3: 3 | ⚠ errors`            | warning  |
 * | Paused           | `aws-s3: 3 (paused)`              | muted    |
 * | Paused + errors  | `aws-s3: 3 | ⚠ errors (paused)`   | warning  |
 *
 * Errors take priority over paused for colour. Terminal watches are excluded
 * from the count. `pollIntervalMs` is accepted for back-compat but no longer
 * rendered.
 */
export function buildStatusLine(input: StatusLineInput): StatusLineResult {
	const { watches, paused, hasErrors } = input;
	const active = Object.values(watches).filter((w) => !w.terminal);
	if (active.length === 0) return { text: "aws-s3: idle", colorAlias: "muted" };

	const parts: string[] = [`${active.length}`];
	if (hasErrors) parts.push("⚠ errors");

	const body = parts.join(" | ");
	const text = paused ? `aws-s3: ${body} (paused)` : `aws-s3: ${body}`;
	const colorAlias: StatusLineColorAlias =
		hasErrors ? "warning" : statusLineColorAlias(paused ? "paused" : "active");
	return { text, colorAlias };
}

function formatHm(date: Date): string {
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return `[${pad(date.getHours())}:${pad(date.getMinutes())}]`;
}

/**
 * Build the chat-message content for a detected-change notification.
 *
 * Format:
 * ```
 * [10:30] 2 events detected
 *
 * • s3://bucket/key updated (etag a → b) ✓
 * • s3://bucket/other timed out waiting for 'removed' ✗
 * ```
 */
export function buildChangeChatMessage(events: S3Event[], date: Date): string {
	const noun = events.length === 1 ? "event" : "events";
	const header = `${formatHm(date)} ${events.length} ${noun} detected`;
	const bullets = events.map((e) => e.formatted).join("\n");
	return `${header}\n\n${bullets}`;
}

/**
 * Build the chat-message content for the startup summary emitted when the
 * session resumes with an existing watch list.
 */
export function buildStartupChatMessage(watches: WatchMap, date: Date): string {
	const all = Object.values(watches);
	if (all.length === 0) {
		return "active — no watches configured. Use the s3_watcher tool to add a watch.";
	}
	const noun = all.length === 1 ? "object" : "objects";
	const lines = all.map((w) => {
		const state = w.baseline === undefined
			? "?"
			: w.baseline.exists
				? "present"
				: "absent";
		const tag = w.terminal ? " [terminal]" : "";
		return `• s3://${w.bucket}/${w.key} (target: ${w.target}) — state=${state}${tag}`;
	});
	return `${formatHm(date)} active — watching ${all.length} ${noun}:\n\n${lines.join("\n")}`;
}
