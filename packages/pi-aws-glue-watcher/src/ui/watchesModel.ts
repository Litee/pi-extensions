/**
 * Pure display-row model for the WatchesView overlay.
 *
 * Split out of watches-view.ts so the sort/expand/dedup logic, the column
 * widths, the state-colour mapping, and per-row formatting are all
 * unit-testable without a live pi-tui runtime.
 */

import type { JobBaseline, WatchMap, WorkflowBaseline } from "../types.js";
import { formatElapsed } from "./glue-widget.js";

// ---------------------------------------------------------------------------
// Column widths (visible chars, before ANSI codes)
// ---------------------------------------------------------------------------

export const COL_NAME_MIN = 20;
export const COL_STATE = 12;
export const COL_AGE = 7;
export const COL_WORKERS = 10;
/** fixed chars per row: lead(1) + sel(1) + spaces(4) + COL_STATE + COL_AGE + COL_WORKERS */
export const COL_FIXED_OVERHEAD = 6 + COL_STATE + COL_AGE + COL_WORKERS;

// ---------------------------------------------------------------------------
// Display row
// ---------------------------------------------------------------------------

export interface DisplayRow {
	/** "job-name" for direct job watches; "workflow/node-name" for workflow nodes. */
	displayName: string;
	state: string;
	startedOn?: string;
	completedOn?: string;
	numberOfWorkers?: number;
	workerType?: string;
	timeoutMinutes?: number;
	runId: string;
	profile: string;
	region?: string;
	errorMessage?: string;
	isTerminal: boolean;
	watchId: string;
	/** Per-watch poll interval in ms. Undefined means default (120s). */
	pollIntervalMs?: number;
}

export interface RowTheme {
	fg: (color: string, text: string) => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function truncate(s: string, n: number): string {
	return s.length > n ? `${s.substring(0, n - 3)}...` : s;
}

export function stateColor(t: RowTheme, state: string, text: string): string {
	if (state === "RUNNING" || state === "STARTING") return t.fg("warning", text);
	if (state === "SUCCEEDED" || state === "COMPLETED") return t.fg("success", text);
	if (
		state === "FAILED" ||
		state === "ERROR" ||
		state === "TIMEOUT" ||
		state === "STOPPED"
	) {
		return t.fg("error", text);
	}
	return t.fg("dim", text);
}

/**
 * Build the flat list of display rows. Watches are sorted: non-terminal
 * first (newest `addedAt` first), then terminal. Workflow watches expand
 * into one row per JOB node; a single fallback row is emitted when no
 * nodes exist. Final pass deduplicates on `displayName`.
 */
export function buildRows(watchMap: WatchMap): DisplayRow[] {
	const watches = Object.values(watchMap).sort((a, b) => {
		if (a.terminal !== b.terminal) return a.terminal ? 1 : -1;
		return b.addedAt - a.addedAt;
	});

	const rows: DisplayRow[] = [];

	for (const watch of watches) {
		if (watch.type === "job") {
			const b = watch.baseline as JobBaseline | undefined;
			rows.push({
				displayName: watch.name,
				state: b?.state ?? "",
				...(b?.startedOn !== undefined ? { startedOn: b.startedOn } : {}),
				...(b?.completedOn !== undefined ? { completedOn: b.completedOn } : {}),
				...(b?.numberOfWorkers !== undefined ? { numberOfWorkers: b.numberOfWorkers } : {}),
				...(b?.workerType !== undefined ? { workerType: b.workerType } : {}),
				...(b?.timeoutMinutes !== undefined ? { timeoutMinutes: b.timeoutMinutes } : {}),
				runId: watch.runId,
				profile: watch.profile,
				...(watch.region !== undefined ? { region: watch.region } : {}),
				...(b?.errorMessage !== undefined ? { errorMessage: b.errorMessage } : {}),
				...(watch.pollIntervalMs !== undefined ? { pollIntervalMs: watch.pollIntervalMs } : {}),
				isTerminal: watch.terminal,
				watchId: watch.watchId,
			});
		} else {
			const b = watch.baseline as WorkflowBaseline | undefined;
			const nodes = b?.nodes;
			if (nodes && nodes.length > 0) {
				const uniqueNodes = Array.from(
					new Map(nodes.filter((n) => n.state !== "").map((n) => [n.name, n])).values(),
				);
				for (const node of uniqueNodes) {
					rows.push({
						displayName: `${watch.name}/${node.name}`,
						state: node.state,
						...(node.startedOn !== undefined ? { startedOn: node.startedOn } : {}),
						...(node.completedOn !== undefined ? { completedOn: node.completedOn } : {}),
						...(node.numberOfWorkers !== undefined ? { numberOfWorkers: node.numberOfWorkers } : {}),
						...(node.workerType !== undefined ? { workerType: node.workerType } : {}),
						...(node.timeoutMinutes !== undefined ? { timeoutMinutes: node.timeoutMinutes } : {}),
						runId: watch.runId,
						profile: watch.profile,
						...(watch.region !== undefined ? { region: watch.region } : {}),
						...(watch.pollIntervalMs !== undefined ? { pollIntervalMs: watch.pollIntervalMs } : {}),
						isTerminal: watch.terminal,
						watchId: watch.watchId,
					});
				}
			} else {
				rows.push({
					displayName: watch.name,
					state: b?.state ?? "",
					runId: watch.runId,
					profile: watch.profile,
					...(watch.region !== undefined ? { region: watch.region } : {}),
					...(watch.pollIntervalMs !== undefined ? { pollIntervalMs: watch.pollIntervalMs } : {}),
					isTerminal: watch.terminal,
					watchId: watch.watchId,
				});
			}
		}
	}

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
): string {
	const sel = isSelected ? theme.fg("accent", "▶") : " ";
	const nameRaw = truncate(row.displayName, colName).padEnd(colName);
	const name = isSelected ? theme.fg("accent", nameRaw) : theme.fg("text", nameRaw);
	const stateRaw = (row.state || "?").padEnd(COL_STATE);
	const stateText = stateColor(theme, row.state, stateRaw);

	const ageStr = formatElapsed(row.startedOn, row.completedOn);
	const age = theme.fg("dim", ageStr.padEnd(COL_AGE));

	let workersStr = "-";
	if (row.numberOfWorkers != null) {
		workersStr = `${row.numberOfWorkers}×${row.workerType ?? "?"}`;
	}
	const workers = theme.fg("dim", workersStr.padEnd(COL_WORKERS));

	const rowStr = ` ${sel} ${name} ${stateText} ${age} ${workers}`;
	return row.isTerminal ? theme.fg("dim", rowStr) : rowStr;
}
