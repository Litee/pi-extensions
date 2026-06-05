/**
 * Pure row-builder + per-row renderer for {@link GlueWidget}.
 *
 * Split out of glue-widget.ts so the entry-building (dedup, workflow-node
 * expansion) and the state-style mapping are unit-testable without a live
 * pi-tui runtime. The widget shell stitches these together inside a
 * Container + DynamicBorder.
 */

import type { GlueWatch, JobBaseline, WatchMap, WorkflowBaseline } from "../types.js";
import { formatElapsed } from "./glue-widget.js";

// ---------------------------------------------------------------------------
// Column widths (characters, before ANSI codes)
// ---------------------------------------------------------------------------

export const COL_STATE = 12;
export const COL_STARTED = 7;
export const COL_WORKERS = 10;
export const COL_INTERVAL = 6;
/** 1 leading + 4 separators = 5 */
export const COL_FIXED_OVERHEAD = COL_STATE + COL_STARTED + COL_WORKERS + COL_INTERVAL + 5;
export const COL_NAME_MIN = 20;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface WidgetEntry {
	displayName: string;
	state: string;
	startedOn?: string;
	completedOn?: string;
	numberOfWorkers?: number;
	workerType?: string;
	/** Per-watch poll interval in ms. Undefined means default (120s). */
	pollIntervalMs?: number;
	/** True when this entry represents a watch (or node) that has reached a terminal state. */
	isTerminal: boolean;
}

export interface WidgetTheme {
	fg: (color: string, text: string) => string;
}

/** One-of-four colour class for a run state. `"none"` → no colour applied. */
export type StateStyle = "warning" | "success" | "error" | "none";

export function stateStyle(state: string): StateStyle {
	if (state === "RUNNING" || state === "STARTING") return "warning";
	if (state === "SUCCEEDED" || state === "COMPLETED") return "success";
	if (
		state === "FAILED" ||
		state === "ERROR" ||
		state === "TIMEOUT" ||
		state === "STOPPED"
	) {
		return "error";
	}
	return "none";
}

/**
 * Sort rank for a run state: lower = shown first.
 *
 * - 0  error    FAILED / ERROR / TIMEOUT / STOPPED — needs immediate attention
 * - 1  warning + none  RUNNING / STARTING / PENDING / unknown — active or queued
 * - 2  success  SUCCEEDED / COMPLETED — done successfully, lowest priority
 *
 * Within each rank, entries are further sorted by `startedOn` *descending*
 * (newest first); entries with no `startedOn` trail.
 */
export function entryPriority(state: string): number {
	const s = stateStyle(state);
	if (s === "error") return 0;
	if (s === "success") return 2;
	return 1; // warning (RUNNING/STARTING) and none (PENDING/unknown)
}

/**
 * Build the flat list of widget entries from the watch map. Only
 * non-terminal watches are shown; workflow watches expand into one entry
 * per JOB node (or a single fallback entry when the graph is empty).
 * The final pass deduplicates on `displayName`, then entries are sorted
 * so non-terminal states (RUNNING, STARTING) rise to the top.
 */
export function buildWidgetEntries(watchMap: WatchMap): WidgetEntry[] {
	const watches = Object.values(watchMap);
	const entries: WidgetEntry[] = [];

	function pollIntervalSpread(w: GlueWatch) {
		return w.pollIntervalMs !== undefined ? { pollIntervalMs: w.pollIntervalMs } : {};
	}

	for (const watch of watches) {
		if (watch.type === "job") {
			const b = watch.baseline as JobBaseline | undefined;
			entries.push({
				displayName: watch.runId ? `${watch.name} [${watch.runId.slice(-4)}]` : watch.name,
				state: b?.state ?? "",
				...(b?.startedOn !== undefined ? { startedOn: b.startedOn } : {}),
				...(b?.completedOn !== undefined ? { completedOn: b.completedOn } : {}),
				...(b?.numberOfWorkers !== undefined ? { numberOfWorkers: b.numberOfWorkers } : {}),
				...(b?.workerType !== undefined ? { workerType: b.workerType } : {}),
				...pollIntervalSpread(watch),
				isTerminal: watch.terminal,
			});
		} else {
			const b = watch.baseline as WorkflowBaseline | undefined;
			const nodes = b?.nodes;
			if (nodes && nodes.length > 0) {
				const uniqueNodes = Array.from(
					new Map(nodes.filter((n) => n.state !== "").map((n) => [n.name, n])).values(),
				);
				for (const node of uniqueNodes) {
					const nodeStyle = stateStyle(node.state);
					entries.push({
						displayName: `${watch.runId ? `${watch.name} [${watch.runId.slice(-4)}]` : watch.name}/${node.name}`,
						state: node.state,
						...(node.startedOn !== undefined ? { startedOn: node.startedOn } : {}),
						...(node.completedOn !== undefined ? { completedOn: node.completedOn } : {}),
						...(node.numberOfWorkers !== undefined ? { numberOfWorkers: node.numberOfWorkers } : {}),
						...(node.workerType !== undefined ? { workerType: node.workerType } : {}),
						...pollIntervalSpread(watch),
						isTerminal: nodeStyle === "success" || nodeStyle === "error",
					});
				}
			} else {
				entries.push({ displayName: watch.runId ? `${watch.name} [${watch.runId.slice(-4)}]` : watch.name, state: b?.state ?? "", ...pollIntervalSpread(watch), isTerminal: watch.terminal });
			}
		}
	}

	const seen = new Set<string>();
	const deduped = entries.filter((e) => {
		if (seen.has(e.displayName)) return false;
		seen.add(e.displayName);
		return true;
	});

	return deduped.sort((a, b) => {
		// Terminal entries always go after non-terminal ones.
		if (a.isTerminal !== b.isTerminal) return a.isTerminal ? 1 : -1;
		// Within non-terminal entries: sort by state priority.
		if (!a.isTerminal) {
			const pa = entryPriority(a.state);
			const pb = entryPriority(b.state);
			if (pa !== pb) return pa - pb;
		}
		// Same group (and same priority for non-terminal): newest startedOn first.
		// Entries without a start time trail within their rank.
		if (a.startedOn && b.startedOn) return a.startedOn > b.startedOn ? -1 : a.startedOn < b.startedOn ? 1 : 0;
		if (a.startedOn) return -1;
		if (b.startedOn) return 1;
		return 0;
	});
}

/**
 * Render one entry to a single line. The caller owns the column-name
 * budget (`colName`) because it depends on the current width.
 */
export function renderEntryLine(
	entry: WidgetEntry,
	colName: number,
	theme: WidgetTheme,
): string {
	const state = entry.state;

	const nameRaw =
		entry.displayName.length > colName
			? `${entry.displayName.substring(0, colName - 3)}...`
			: entry.displayName;
	const name = theme.fg("text", nameRaw.padEnd(colName));

	const stateRaw = (state || "?").padEnd(COL_STATE);
	const style = stateStyle(state);
	const stateStr = style === "none" ? stateRaw : theme.fg(style, stateRaw);

	// started column
	const started = formatElapsed(entry.startedOn, entry.completedOn).padEnd(COL_STARTED);

	let workersStr = "-";
	if (entry.numberOfWorkers != null) {
		workersStr = `${entry.numberOfWorkers}×${entry.workerType ?? "?"}`;
	}
	const workers = workersStr.padEnd(COL_WORKERS);

	const intervalSec = entry.pollIntervalMs !== undefined
		? Math.round(entry.pollIntervalMs / 1000)
		: undefined;
	const intervalStr = theme.fg("dim", (intervalSec !== undefined ? `${intervalSec}s` : "-").padEnd(COL_INTERVAL));

	const line = ` ${name} ${stateStr} ${started} ${workers} ${intervalStr}`;
	return entry.isTerminal ? theme.fg("dim", line) : line;
}
