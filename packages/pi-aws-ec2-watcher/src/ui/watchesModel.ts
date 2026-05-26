/**
 * Pure display-row model for the EC2 WatchesView overlay.
 */

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";
import type { Ec2Watch, WatchMap } from "../types.js";

// ---------------------------------------------------------------------------
// Column widths (visible chars, before ANSI codes)
// ---------------------------------------------------------------------------

export const COL_NAME_MIN = 22;
export const COL_STATE = 13;
export const COL_TIME = 10;
/** fixed chars per row: lead(1) + sel(1) + spaces(3) + COL_STATE + COL_TIME */
export const COL_FIXED_OVERHEAD = 5 + COL_STATE + COL_TIME;

// ---------------------------------------------------------------------------
// Display row
// ---------------------------------------------------------------------------

export interface DisplayRow {
	/** Instance id (possibly with name-tag suffix). */
	displayName: string;
	instanceId: string;
	state: string;
	timeoutAt: number | undefined;
	addedAt: number;
	lastPolledAt: number | undefined;
	profile: string;
	region: string | undefined;
	hasErrors: boolean;
	isTerminal: boolean;
	watchId: string;
	stopOnStopped: boolean;
	nameTag: string | undefined;
	instanceType: string | undefined;
}

export interface RowTheme {
	fg: (color: string, text: string) => string;
}

export type RowStyle = "warning" | "success" | "error";

export function rowStyle(row: Pick<DisplayRow, "isTerminal" | "hasErrors">): RowStyle {
	if (row.isTerminal) return "success";
	if (row.hasErrors) return "error";
	return "warning";
}

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

function watchToRow(watch: Ec2Watch): DisplayRow {
	const state = watch.baseline?.state ?? "?";
	const nameTag = watch.baseline?.nameTag;
	const displayName = nameTag ? `${watch.instanceId} (${nameTag})` : watch.instanceId;
	return {
		displayName,
		instanceId: watch.instanceId,
		state,
		timeoutAt: watch.timeoutAt,
		addedAt: watch.addedAt,
		lastPolledAt: watch.lastPolledAt,
		profile: watch.profile,
		region: watch.region,
		hasErrors: watch.consecutiveErrors >= DEFAULT_POLL_ERROR_THRESHOLD,
		isTerminal: watch.terminal,
		watchId: watch.watchId,
		stopOnStopped: watch.stopOnStopped,
		nameTag,
		instanceType: watch.baseline?.instanceType,
	};
}

export function buildRows(watchMap: WatchMap): DisplayRow[] {
	const watches = Object.values(watchMap).sort((a, b) => {
		if (a.terminal !== b.terminal) return a.terminal ? 1 : -1;
		return b.addedAt - a.addedAt;
	});

	const rows = watches.map(watchToRow);

	// Disambiguate duplicate displayNames
	const counts = new Map<string, number>();
	for (const r of rows) counts.set(r.displayName, (counts.get(r.displayName) ?? 0) + 1);
	for (const r of rows) {
		if ((counts.get(r.displayName) ?? 0) > 1) {
			r.displayName = `${r.displayName} [${r.watchId.slice(-4)}]`;
		}
	}
	return rows;
}

export function formatDetailIdentityLine(
	row: Pick<DisplayRow, "profile" | "region" | "instanceType">,
): string {
	const region = row.region ?? "default";
	const parts = [`Profile: ${row.profile}`, `Region: ${region}`];
	const instanceType = row.instanceType;
	if (typeof instanceType === "string") parts.push(`Type: ${instanceType}`);
	return parts.join(" | ");
}

export function formatRowLine(
	row: DisplayRow,
	isSelected: boolean,
	colName: number,
	theme: RowTheme,
	now: number = Date.now(),
): string {
	const sel = isSelected ? theme.fg("accent", "▶") : " ";

	const nameRaw =
		row.displayName.length > colName
			? row.displayName.slice(0, colName - 3) + "..."
			: row.displayName;
	const namePadded = nameRaw.padEnd(colName);
	const name = isSelected
		? theme.fg("accent", namePadded)
		: theme.fg("text", namePadded);

	const stateRaw = row.state.padEnd(COL_STATE);
	const stateStr = theme.fg(rowStyle(row), stateRaw);

	const timeStr = formatTimeLeft(row.timeoutAt, now).padEnd(COL_TIME);

	const line = ` ${sel} ${name} ${stateStr} ${timeStr}`;
	return row.isTerminal ? theme.fg("dim", line) : line;
}
