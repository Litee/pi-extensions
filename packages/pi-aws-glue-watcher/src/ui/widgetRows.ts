/**
 * Pure row-builder + per-row renderer for {@link GlueWidget}.
 *
 * Split out of glue-widget.ts so the entry-building (dedup, workflow-node
 * expansion) and the state-style mapping are unit-testable without a live
 * pi-tui runtime. The widget shell stitches these together inside a
 * Container + DynamicBorder.
 */

import type { JobBaseline, WatchMap, WorkflowBaseline } from "../types.js";
import { formatElapsed } from "./glue-widget.js";

// ---------------------------------------------------------------------------
// Column widths (characters, before ANSI codes)
// ---------------------------------------------------------------------------

export const COL_STATE = 12;
export const COL_STARTED = 7;
export const COL_WORKERS = 10;
/** 1 leading + 3 separators = 4 */
export const COL_FIXED_OVERHEAD = COL_STATE + COL_STARTED + COL_WORKERS + 4;
export const COL_NAME_MIN = 20;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface WidgetEntry {
	displayName: string;
	state: string;
	startedOn?: string;
	numberOfWorkers?: number;
	workerType?: string;
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
 * Build the flat list of widget entries from the watch map. Only
 * non-terminal watches are shown; workflow watches expand into one entry
 * per JOB node (or a single fallback entry when the graph is empty).
 * The final pass deduplicates on `displayName`.
 */
export function buildWidgetEntries(watchMap: WatchMap): WidgetEntry[] {
	const watches = Object.values(watchMap).filter((w) => !w.terminal);
	const entries: WidgetEntry[] = [];

	for (const watch of watches) {
		if (watch.type === "job") {
			const b = watch.baseline as JobBaseline | undefined;
			entries.push({
				displayName: watch.name,
				state: b?.state ?? "",
				...(b?.startedOn !== undefined ? { startedOn: b.startedOn } : {}),
				...(b?.numberOfWorkers !== undefined ? { numberOfWorkers: b.numberOfWorkers } : {}),
				...(b?.workerType !== undefined ? { workerType: b.workerType } : {}),
			});
		} else {
			const b = watch.baseline as WorkflowBaseline | undefined;
			const nodes = b?.nodes;
			if (nodes && nodes.length > 0) {
				const uniqueNodes = Array.from(
					new Map(nodes.filter((n) => n.state !== "").map((n) => [n.name, n])).values(),
				);
				for (const node of uniqueNodes) {
					entries.push({
						displayName: `${watch.name}/${node.name}`,
						state: node.state,
						...(node.startedOn !== undefined ? { startedOn: node.startedOn } : {}),
						...(node.numberOfWorkers !== undefined ? { numberOfWorkers: node.numberOfWorkers } : {}),
						...(node.workerType !== undefined ? { workerType: node.workerType } : {}),
					});
				}
			} else {
				entries.push({ displayName: watch.name, state: b?.state ?? "" });
			}
		}
	}

	const seen = new Set<string>();
	return entries.filter((e) => {
		if (seen.has(e.displayName)) return false;
		seen.add(e.displayName);
		return true;
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

	const started = formatElapsed(entry.startedOn).padEnd(COL_STARTED);

	let workersStr = "-";
	if (entry.numberOfWorkers != null) {
		workersStr = `${entry.numberOfWorkers}×${entry.workerType ?? "?"}`;
	}
	const workers = workersStr.padEnd(COL_WORKERS);

	return ` ${name} ${stateStr} ${started} ${workers}`;
}
