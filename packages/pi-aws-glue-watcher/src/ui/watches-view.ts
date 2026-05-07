/**
 * WatchesView — read-only TUI overlay showing all Glue watches.
 *
 * Opened by the `/glue-watcher` command (no subcommand or `jobs`).
 * Navigation: ↑↓ to select, r to refresh from in-memory cache, q/Escape to close.
 *
 * Workflow watches are expanded into one row per JOB node, displayed as
 * "workflowName/nodeName". When a workflow has no graph nodes yet, a single
 * fallback row shows the workflow-level state.
 */

import type { Component } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import type { JobBaseline, WatchMap, WorkflowBaseline } from "../types.js";
import { formatElapsed } from "./glue-widget.js";

// ---------------------------------------------------------------------------
// Column widths (visible chars, before ANSI codes)
// ---------------------------------------------------------------------------

const COL_NAME = 30;
const COL_STATE = 12;
const COL_AGE = 7;
const COL_WORKERS = 10;

// ---------------------------------------------------------------------------
// Display row
// ---------------------------------------------------------------------------

interface DisplayRow {
	/** "job-name" for direct job watches; "workflow/node-name" for workflow nodes. */
	displayName: string;
	state: string;
	startedOn?: string;
	numberOfWorkers?: number;
	workerType?: string;
	/** run ID of the parent watch (workflow run ID or job run ID). */
	runId: string;
	profile: string;
	region?: string;
	/** Only populated for direct job watches. */
	errorMessage?: string;
	isTerminal: boolean;
	watchId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.substring(0, n - 3)}...` : s;
}

type Theme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

function stateColor(t: Theme, state: string, text: string): string {
	if (state === "RUNNING" || state === "STARTING") return t.fg("warning", text);
	if (state === "SUCCEEDED" || state === "COMPLETED") return t.fg("success", text);
	if (
		state === "FAILED" ||
		state === "ERROR" ||
		state === "TIMEOUT" ||
		state === "STOPPED"
	)
		return t.fg("error", text);
	return t.fg("dim", text);
}

// ---------------------------------------------------------------------------
// WatchesView
// ---------------------------------------------------------------------------

export class WatchesView implements Component {
	private selectedIndex = 0;

	constructor(
		private readonly getWatches: () => WatchMap,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: () => void,
	) {}

	invalidate(): void {
		// no cached render output
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, "escape")) {
			this.done();
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) this.selectedIndex--;
			return;
		}
		if (matchesKey(data, "down")) {
			const rows = this.buildRows();
			if (this.selectedIndex < rows.length - 1) this.selectedIndex++;
			return;
		}
		if (matchesKey(data, "r")) {
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = this.buildRows();
		const rule = t.fg("dim", "─".repeat(Math.max(1, width)));
		const lines: string[] = [];

		// clamp selection
		if (rows.length > 0 && this.selectedIndex >= rows.length) {
			this.selectedIndex = rows.length - 1;
		}

		lines.push(rule);

		// Header
		if (rows.length === 0) {
			lines.push(
				` ${t.fg("accent", t.bold("Glue Watcher"))}` +
					t.fg("dim", "  No watches configured.   q close"),
			);
		} else {
			lines.push(
				` ${t.fg("accent", t.bold("Glue Watcher"))}` +
					t.fg("dim", ` (${rows.length})  —  ↑↓ select   r refresh   q close`),
			);
		}

		lines.push(rule);

		// Data rows
		for (let i = 0; i < rows.length; i++) {
			lines.push(this.formatRow(rows[i]!, i));
		}

		// Detail panel for the selected row
		const sel = rows[this.selectedIndex];
		if (sel) {
			lines.push(rule);

			const region = sel.region ?? "default";
			lines.push(
				` ${t.fg("text", sel.displayName)} — ${t.fg("dim", sel.runId)} | ` +
					t.fg("dim", `Profile: ${sel.profile} | Region: ${region}`),
			);

			const age = formatElapsed(sel.startedOn);
			let workersDetail = "-";
			if (sel.numberOfWorkers != null) {
				workersDetail = `${sel.numberOfWorkers}×${sel.workerType ?? "?"}`;
			}
			lines.push(
				t.fg("dim", ` Started: ${age} | State: ${sel.state || "?"} | Workers: ${workersDetail}`),
			);

			if (sel.errorMessage && sel.errorMessage !== "-") {
				lines.push(t.fg("dim", ` Error: ${sel.errorMessage}`));
			}
		}

		lines.push(rule);
		return lines;
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/**
	 * Build the flat list of display rows. Watches are sorted: non-terminal
	 * first (newest addedAt first), then terminal. Workflow watches expand into
	 * one row per JOB node; a single fallback row is emitted when no nodes exist.
	 */
	private buildRows(): DisplayRow[] {
		const watches = Object.values(this.getWatches()).sort((a, b) => {
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
					...(b?.numberOfWorkers !== undefined ? { numberOfWorkers: b.numberOfWorkers } : {}),
					...(b?.workerType !== undefined ? { workerType: b.workerType } : {}),
					runId: watch.runId,
					profile: watch.profile,
					...(watch.region !== undefined ? { region: watch.region } : {}),
					...(b?.errorMessage !== undefined ? { errorMessage: b.errorMessage } : {}),
					isTerminal: watch.terminal,
					watchId: watch.watchId,
				});
			} else {
				// workflow
				const b = watch.baseline as WorkflowBaseline | undefined;
				const nodes = b?.nodes;
				if (nodes && nodes.length > 0) {
					for (const node of nodes) {
						rows.push({
							displayName: `${watch.name}/${node.name}`,
							state: node.state,
							...(node.startedOn !== undefined ? { startedOn: node.startedOn } : {}),
							...(node.numberOfWorkers !== undefined ? { numberOfWorkers: node.numberOfWorkers } : {}),
							...(node.workerType !== undefined ? { workerType: node.workerType } : {}),
							runId: watch.runId,
							profile: watch.profile,
							...(watch.region !== undefined ? { region: watch.region } : {}),
							isTerminal: watch.terminal,
							watchId: watch.watchId,
						});
					}
				} else {
					// fallback: no graph nodes yet
					rows.push({
						displayName: watch.name,
						state: b?.state ?? "",
						runId: watch.runId,
						profile: watch.profile,
						...(watch.region !== undefined ? { region: watch.region } : {}),
						isTerminal: watch.terminal,
						watchId: watch.watchId,
					});
				}
			}
		}

		return rows;
	}

	private formatRow(row: DisplayRow, index: number): string {
		const t = this.theme;
		const isSelected = index === this.selectedIndex;

		const sel = isSelected ? t.fg("accent", "▶") : " ";
		const nameRaw = truncate(row.displayName, COL_NAME).padEnd(COL_NAME);
		const name = isSelected ? t.fg("accent", nameRaw) : t.fg("text", nameRaw);
		const stateRaw = (row.state || "?").padEnd(COL_STATE);
		const stateText = stateColor(t, row.state, stateRaw);

		const ageStr = formatElapsed(row.startedOn);
		const age = t.fg("dim", ageStr.padEnd(COL_AGE));

		let workersStr = "-";
		if (row.numberOfWorkers != null) {
			workersStr = `${row.numberOfWorkers}×${row.workerType ?? "?"}`;
		}
		const workers = t.fg("dim", workersStr.padEnd(COL_WORKERS));

		const rowStr = ` ${sel} ${name} ${stateText} ${age} ${workers}`;

		// Fade terminal rows
		return row.isTerminal ? t.fg("dim", rowStr) : rowStr;
	}
}
