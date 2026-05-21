/**
 * Pure display-row model for the S3 WatchesView overlay.
 *
 * Split out of watches-view.ts so the sort, colour routing, and per-row
 * formatting are unit-testable without a live pi-tui runtime.
 *
 * Mirrors `pi-aws-glue-watcher/src/ui/watchesModel.ts` but with S3-shaped
 * columns (target, present/absent state, time-left).
 */

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";

import type { S3Watch, TargetCondition, WatchMap } from "../types.js";
import { compressS3Uri } from "../uri.js";

// ---------------------------------------------------------------------------
// Column widths (visible chars, before ANSI codes)
// ---------------------------------------------------------------------------

export const COL_NAME_MIN = 24;
export const COL_TARGET = 9;
export const COL_STATE = 9;
export const COL_TIME = 10;
/** fixed chars per row: lead(1) + sel(1) + spaces(4) + COL_TARGET + COL_STATE + COL_TIME */
export const COL_FIXED_OVERHEAD = 6 + COL_TARGET + COL_STATE + COL_TIME;

// ---------------------------------------------------------------------------
// Display row
// ---------------------------------------------------------------------------

export type RowState = "present" | "absent" | "?";

export interface DisplayRow {
	/** `s3://bucket/key` for display + uniqueness. */
	displayName: string;
	bucket: string;
	key: string;
	target: TargetCondition;
	state: RowState;
	timeoutAt: number | undefined;
	addedAt: number;
	lastPolledAt: number | undefined;
	profile: string;
	region: string | undefined;
	hasErrors: boolean;
	isTerminal: boolean;
	watchId: string;
}

export interface RowTheme {
	fg: (color: string, text: string) => string;
}

/** Colour class for a row (drives both name highlight and state colouring). */
export type RowStyle = "warning" | "success" | "error";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function rowStyle(row: Pick<DisplayRow, "isTerminal" | "hasErrors">): RowStyle {
	if (row.isTerminal) return "success";
	if (row.hasErrors) return "error";
	return "warning";
}

/**
 * Format time remaining until `timeoutAt`. Mirrors the s3-widget helper.
 *
 * - undefined → "-"
 * - past      → "expired"
 * - future    → "30s left", "5m left", "1h left"
 */
export function formatTimeLeft(timeoutAt: number | undefined, now: number): string {
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

function watchToRow(watch: S3Watch): DisplayRow {
	const state: RowState =
		watch.baseline === undefined ? "?" : watch.baseline.exists ? "present" : "absent";
	return {
		displayName: `s3://${watch.bucket}/${watch.key}`,
		bucket: watch.bucket,
		key: watch.key,
		target: watch.target,
		state,
		timeoutAt: watch.timeoutAt,
		addedAt: watch.addedAt,
		lastPolledAt: watch.lastPolledAt,
		profile: watch.profile,
		region: watch.region,
		hasErrors: watch.consecutiveErrors >= DEFAULT_POLL_ERROR_THRESHOLD,
		isTerminal: watch.terminal,
		watchId: watch.watchId,
	};
}

/**
 * Build the flat list of display rows. Watches are sorted: non-terminal
 * first (newest `addedAt` first), then terminal. Final pass deduplicates
 * on `displayName` so two watches against the same URI never produce
 * duplicate rows.
 */
export function buildRows(watchMap: WatchMap): DisplayRow[] {
	const watches = Object.values(watchMap).sort((a, b) => {
		if (a.terminal !== b.terminal) return a.terminal ? 1 : -1;
		return b.addedAt - a.addedAt;
	});

	const rows = watches.map(watchToRow);

	const seen = new Set<string>();
	return rows.filter((r) => {
		if (seen.has(r.displayName)) return false;
		seen.add(r.displayName);
		return true;
	});
}

/**
 * Render a single list row to a string. `isSelected` highlights the row
 * with the `accent` colour; terminal rows are faded to `dim`. The output
 * includes the leading space + selection arrow columns so the caller can
 * just push the returned line directly.
 */
export function formatRowLine(
	row: DisplayRow,
	isSelected: boolean,
	colName: number,
	theme: RowTheme,
	now: number = Date.now(),
): string {
	const sel = isSelected ? theme.fg("accent", "▶") : " ";

	// Name column — smart-compress S3 URI when too long.
	const nameRaw =
		row.displayName.length > colName
			? compressS3Uri(row.displayName, colName)
			: row.displayName;
	const namePadded = nameRaw.padEnd(colName);
	const name = isSelected ? theme.fg("accent", namePadded) : theme.fg("text", namePadded);

	// Target column (uncoloured).
	const targetStr = row.target.padEnd(COL_TARGET);

	// State column (coloured by row style).
	const stateRaw = row.state.padEnd(COL_STATE);
	const stateStr = theme.fg(rowStyle(row), stateRaw);

	// Time-left column.
	const timeStr = formatTimeLeft(row.timeoutAt, now).padEnd(COL_TIME);

	const line = ` ${sel} ${name} ${targetStr} ${stateStr} ${timeStr}`;
	return row.isTerminal ? theme.fg("dim", line) : line;
}
