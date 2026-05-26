/**
 * Pure row-builder + per-row renderer for {@link Ec2Widget}.
 */

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";
import type { WatchMap } from "../types.js";

// ---------------------------------------------------------------------------
// Column widths (characters, before ANSI codes)
// ---------------------------------------------------------------------------

export const COL_STATE = 13;
export const COL_TIME = 10;
/** 1 leading space + 2 column separators = 3 */
export const COL_FIXED_OVERHEAD = COL_STATE + COL_TIME + 3;
export const COL_NAME_MIN = 20;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface WidgetEntry {
	instanceId: string;
	/** Display label (instance id + optional name tag). */
	displayName: string;
	state: string;
	timeoutAt: number | undefined;
	addedAt: number;
	hasErrors: boolean;
	terminal: boolean;
}

export interface WidgetTheme {
	fg: (color: string, text: string) => string;
}

export type WatchStyle = "warning" | "success" | "error" | "none";

export function watchStyle(entry: Pick<WidgetEntry, "terminal" | "hasErrors">): WatchStyle {
	if (entry.terminal) return "success";
	if (entry.hasErrors) return "error";
	return "warning";
}

export function buildWidgetEntries(watchMap: WatchMap): WidgetEntry[] {
	return Object.values(watchMap)
		.map((w) => {
			const state = w.baseline?.state ?? "?";
			const displayName = w.baseline?.nameTag
				? `${w.instanceId} (${w.baseline.nameTag})`
				: w.instanceId;
			return {
				instanceId: w.instanceId,
				displayName,
				state,
				timeoutAt: w.timeoutAt,
				addedAt: w.addedAt,
				hasErrors: w.consecutiveErrors >= DEFAULT_POLL_ERROR_THRESHOLD,
				terminal: w.terminal,
			};
		})
		.sort((a, b) => {
			if (a.terminal !== b.terminal) return a.terminal ? 1 : -1;
			return b.addedAt - a.addedAt;
		});
}

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

export function renderEntryLine(
	entry: WidgetEntry,
	nameColWidth: number,
	theme: WidgetTheme,
	now: number = Date.now(),
): string {
	const nameRaw =
		entry.displayName.length > nameColWidth
			? entry.displayName.slice(0, nameColWidth - 3) + "..."
			: entry.displayName;
	const name = theme.fg("text", nameRaw.padEnd(nameColWidth));

	const stateRaw = entry.state.padEnd(COL_STATE);
	const style = watchStyle(entry);
	const stateStr = style === "none" ? stateRaw : theme.fg(style, stateRaw);

	const timeLeftRaw = formatTimeLeft(entry.timeoutAt, now).padEnd(COL_TIME);

	const line = ` ${name} ${stateStr} ${timeLeftRaw}`;
	return entry.terminal ? theme.fg("dim", line) : line;
}
