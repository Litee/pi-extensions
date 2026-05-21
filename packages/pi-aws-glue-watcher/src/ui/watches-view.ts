/**
 * WatchesView — TUI overlay opened by `/glue-watcher` (no args or `jobs`).
 *
 * Pure pieces — row building, sort/dedup, colour routing, per-row
 * formatting — live in `./watchesModel.ts`. Pure key dispatch lives in
 * `./watchesKeys.ts`. This file is strictly the `Component` shell that
 * glues them together with confirm-mode state and the outer render.
 */

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

import type { WatchMap } from "../types.js";
import { formatElapsed } from "./glue-widget.js";
import {
	buildRows,
	COL_FIXED_OVERHEAD,
	COL_NAME_MIN,
	formatRowLine,
	type DisplayRow,
	type RowTheme,
} from "./watchesModel.js";
import { dispatchKey } from "./watchesKeys.js";

type Theme = RowTheme & { bold: (text: string) => string };

export class WatchesView implements Component {
	private selectedIndex = 0;
	private confirm: { kind: "stop" | "unwatch"; displayName: string; row: DisplayRow } | null = null;
	private actionError: string | null = null;

	constructor(
		private readonly getWatches: () => WatchMap,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly stopRow: (row: DisplayRow) => Promise<void>,
		private readonly removeWatch: (watchId: string) => void,
		private readonly getPollIntervalMs: () => number,
		private readonly toggleDisplay: () => void,
		private readonly getDisplayMode: () => "widget" | "statusline",
	) {}

	invalidate(): void {
		// no cached render output
	}

	handleInput(data: string): void {
		const action = dispatchKey(this.confirm !== null, data, matchesKey);

		switch (action.kind) {
			case "ignore":
				return;
			case "confirm": {
				const target = this.confirm;
				if (!target) return;
				this.confirm = null;
				this.actionError = null;
				if (target.kind === "stop") {
					this.stopRow(target.row)
						.catch((err: unknown) => {
							this.actionError = err instanceof Error ? err.message : String(err);
						})
						.finally(() => {
							this.requestRender();
						});
				} else {
					this.removeWatch(target.row.watchId);
				}
				this.requestRender();
				return;
			}
			case "cancel":
				this.confirm = null;
				this.requestRender();
				return;
			case "quit":
				this.done();
				return;
			case "move-up":
				if (this.selectedIndex > 0) this.selectedIndex--;
				return;
			case "move-down": {
				const rows = buildRows(this.getWatches());
				if (this.selectedIndex < rows.length - 1) this.selectedIndex++;
				return;
			}
			case "refresh":
				this.actionError = null;
				this.requestRender();
				return;
			case "toggle-display":
				this.toggleDisplay();
				return;
			case "begin-stop": {
				const rows = buildRows(this.getWatches());
				const sel = rows[this.selectedIndex];
				if (sel && !sel.isTerminal) {
					this.confirm = { kind: "stop", displayName: sel.displayName, row: sel };
					this.actionError = null;
					this.requestRender();
				}
				return;
			}
			case "begin-unwatch": {
				const rows = buildRows(this.getWatches());
				const sel = rows[this.selectedIndex];
				if (sel) {
					this.confirm = { kind: "unwatch", displayName: sel.displayName, row: sel };
					this.actionError = null;
					this.requestRender();
				}
				return;
			}
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = buildRows(this.getWatches());
		const longestName = rows.reduce((m, r) => Math.max(m, r.displayName.length), COL_NAME_MIN);
		const colName = Math.min(longestName, width - COL_FIXED_OVERHEAD);
		const rule = t.fg("dim", "─".repeat(Math.max(1, width)));
		const lines: string[] = [];

		if (rows.length > 0 && this.selectedIndex >= rows.length) {
			this.selectedIndex = rows.length - 1;
		}

		lines.push(rule);

		if (rows.length === 0) {
			lines.push(
				` ${t.fg("accent", t.bold("Glue Watcher"))}` +
					t.fg("dim", "  No watches configured.   q close"),
			);
		} else if (this.confirm) {
			const verb = this.confirm.kind === "stop" ? "Stop" : "Unwatch";
			lines.push(
				` ${t.fg("warning", `${verb} "${this.confirm.displayName}"?`)}` +
					t.fg("dim", "  y confirm   n cancel"),
			);
		} else if (this.actionError) {
			lines.push(
				` ${t.fg("error", `Failed: ${this.actionError}`)}` +
					t.fg("dim", "   q close"),
			);
		} else {
			lines.push(
				` ${t.fg("accent", t.bold("Glue Watcher"))}` +
					t.fg(
						"dim",
						` (${rows.length})  —  poll: ${Math.round(this.getPollIntervalMs() / 1000)}s   ↑↓ select   x stop   d unwatch   t → ${this.getDisplayMode() === "widget" ? "statusline" : "widget"}   r refresh   q close`,
					),
			);
		}

		lines.push(rule);

		for (let i = 0; i < rows.length; i++) {
			lines.push(formatRowLine(rows[i]!, i === this.selectedIndex, colName, t));
		}

		const sel = rows[this.selectedIndex];
		if (sel) {
			lines.push(rule);
			const region = sel.region ?? "default";
			lines.push(
				` ${t.fg("text", sel.displayName)} — ${t.fg("dim", sel.runId)} | ` +
					t.fg("dim", `Profile: ${sel.profile} | Region: ${region}`),
			);
			const age = formatElapsed(sel.startedOn, sel.completedOn);
			let workersDetail = "-";
			if (sel.numberOfWorkers != null) {
				workersDetail = `${sel.numberOfWorkers}×${sel.workerType ?? "?"}`;
			}
			const timeoutDetail = sel.timeoutMinutes != null ? `${sel.timeoutMinutes}m` : "inherited";
			lines.push(
				t.fg("dim", ` Started: ${age} | State: ${sel.state || "?"} | Workers: ${workersDetail} | Timeout: ${timeoutDetail}`),
			);
			if (sel.errorMessage && sel.errorMessage !== "-") {
				lines.push(t.fg("dim", ` Error: ${sel.errorMessage}`));
			}
		}

		lines.push(rule);
		return lines;
	}
}
