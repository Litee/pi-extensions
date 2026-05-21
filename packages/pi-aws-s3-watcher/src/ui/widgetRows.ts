/**
 * Pure row-builder + per-row renderer for {@link S3Widget}.
 *
 * Split out of s3-widget.ts so the entry-building and the state-style mapping
 * are unit-testable without a live pi-tui runtime.
 */

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";
import type { WatchMap } from "../types.js";
import { compressS3Uri } from "../uri.js";

// ---------------------------------------------------------------------------
// Column widths (characters, before ANSI codes)
// ---------------------------------------------------------------------------

export const COL_TARGET = 9;
export const COL_STATE = 9;
export const COL_TIME = 10;
/** 1 leading space + 3 column separators = 4 */
export const COL_FIXED_OVERHEAD = COL_TARGET + COL_STATE + COL_TIME + 4;
export const COL_NAME_MIN = 20;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface WidgetEntry {
	displayName: string;
	target: "exists" | "updated" | "removed";
	state: "present" | "absent" | "?";
	timeoutAt: number | undefined;
	addedAt: number;
	hasErrors: boolean;
	terminal: boolean;
}

export interface WidgetTheme {
	fg: (color: string, text: string) => string;
}

/** Colour class for a watch entry. */
export type WatchStyle = "warning" | "success" | "error" | "none";

/**
 * Determine the colour style for a watch entry:
 * - terminal          → "success"
 * - non-terminal + hasErrors → "error"
 * - non-terminal     → "warning"
 */
export function watchStyle(entry: WidgetEntry): WatchStyle {
	if (entry.terminal) return "success";
	if (entry.hasErrors) return "error";
	return "warning";
}

/**
 * Build the flat list of widget entries from the watch map.
 * Only non-terminal watches are included.
 */
export function buildWidgetEntries(watchMap: WatchMap): WidgetEntry[] {
	return Object.values(watchMap)
		.filter((w) => !w.terminal)
		.map((w) => {
			const state: "present" | "absent" | "?" =
				w.baseline === undefined ? "?" : w.baseline.exists ? "present" : "absent";
			return {
				displayName: `s3://${w.bucket}/${w.key}`,
				target: w.target,
				state,
				timeoutAt: w.timeoutAt,
				addedAt: w.addedAt,
				hasErrors: w.consecutiveErrors >= DEFAULT_POLL_ERROR_THRESHOLD,
				terminal: w.terminal,
			};
		});
}

/**
 * Format time remaining until `timeoutAt`.
 *
 * - undefined → "-"
 * - past      → "expired"
 * - future    → "30s left", "5m left", "1h left"
 */
function formatTimeLeft(timeoutAt: number | undefined, now: number): string {
	if (timeoutAt === undefined) return "-";
	const remainingMs = timeoutAt - now;
	if (remainingMs <= 0) return "expired";
	const s = Math.ceil(remainingMs / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rem = s % 60;
	if (h >= 1) return `${h}h left`;
	if (m >= 1) return `${m}m left`;
	return `${rem}s left`;
}

/**
 * Render one entry to a single line.
 *
 * Format: ` <name:nameColWidth> <target:COL_TARGET> <state:COL_STATE> <timeLeft:COL_TIME>`
 */
export function renderEntryLine(
	entry: WidgetEntry,
	nameColWidth: number,
	theme: WidgetTheme,
	now: number = Date.now(),
): string {
	// Name column – use smart mid-segment compression for S3 URIs
	const nameRaw =
		entry.displayName.length > nameColWidth
			? compressS3Uri(entry.displayName, nameColWidth)
			: entry.displayName;
	const name = theme.fg("text", nameRaw.padEnd(nameColWidth));

	// Target column (always uncoloured)
	const targetStr = entry.target.padEnd(COL_TARGET);

	// State column (coloured by watchStyle)
	const stateRaw = entry.state.padEnd(COL_STATE);
	const style = watchStyle(entry);
	const stateStr = style === "none" ? stateRaw : theme.fg(style, stateRaw);

	// Time-left column
	const timeLeftRaw = formatTimeLeft(entry.timeoutAt, now).padEnd(COL_TIME);
	const timeStr = timeLeftRaw;

	return ` ${name} ${targetStr} ${stateStr} ${timeStr}`;
}
