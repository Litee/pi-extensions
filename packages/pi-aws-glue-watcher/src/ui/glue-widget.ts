/**
 * GlueWidget — TUI panel rendered below the chat editor.
 *
 * Shows a table of active (non-terminal) Glue job/workflow watches with
 * their current state, how long they have been running, and — for job
 * watches — the worker count and type.
 *
 * The widget auto-refreshes every 30 seconds so elapsed-time labels stay
 * current, and also re-renders immediately whenever a "glue:change" event
 * is emitted by the poll loop or by tool add/remove actions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import type { JobBaseline, WatchMap, WorkflowBaseline } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIDGET_ID = "glue-watcher";

// Fixed column widths (characters, before ANSI codes are added)
const COL_STATE = 12;
const COL_STARTED = 7;
const COL_WORKERS = 10;
// spaces between columns (1 leading + 3 separators) = 4
const COL_FIXED_OVERHEAD = COL_STATE + COL_STARTED + COL_WORKERS + 4;
const COL_NAME_MIN = 20;

// ---------------------------------------------------------------------------
// Module-level helper
// ---------------------------------------------------------------------------

/**
 * Format elapsed time since an ISO-8601 timestamp as a compact string.
 * Returns "-" when the timestamp is absent or unparseable.
 *
 * Examples: "0s", "45s", "7m", "1h30m", "3h5m"
 */
export function formatElapsed(iso: string | undefined): string {
	if (!iso) return "-";
	const ms = Date.now() - new Date(iso).getTime();
	const s = Math.floor(ms / 1000);
	if (s <= 0) return "0s";
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rem = s % 60;
	if (h >= 1) return `${h}h${m}m`;
	if (m >= 1) return `${m}m`;
	return `${rem}s`;
}

// ---------------------------------------------------------------------------
// GlueWidget
// ---------------------------------------------------------------------------

export class GlueWidget {
	private ctx: unknown = undefined;
	private refreshInterval: NodeJS.Timeout | undefined;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly pi: Pick<ExtensionAPI, "events">,
		private readonly getWatches: () => WatchMap,
		private readonly getPollIntervalMs: () => number,
	) {
		this.unsubscribe = this.pi.events.on("glue:change", () => this.refresh());
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/** Mount (or re-mount) the widget. Hides automatically when no active watches. */
	show(ctx: unknown): void {
		this.ctx = ctx;

		const active = Object.values(this.getWatches()).filter((w) => !w.terminal);
		if (active.length === 0) {
			this.hide(ctx);
			return;
		}

		const anyCtx = ctx as { ui?: { setWidget?: (...args: unknown[]) => void } };
		anyCtx.ui?.setWidget?.(
			WIDGET_ID,
			(_tui: unknown, theme: unknown) => ({
				render: (width: number) => this.renderWidget(width, theme),
				invalidate: () => {},
			}),
			{ placement: "belowEditor" },
		);

		if (!this.refreshInterval) {
			this.refreshInterval = setInterval(() => this.refresh(), 30_000);
		}
	}

	/** Unmount the widget and stop the refresh timer. */
	hide(ctx: unknown): void {
		const anyCtx = ctx as { ui?: { setWidget?: (...args: unknown[]) => void } };
		anyCtx.ui?.setWidget?.(WIDGET_ID, undefined);
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = undefined;
		}
	}

	/** Re-render using the last stored ctx. No-op if show() was never called. */
	refresh(): void {
		if (this.ctx !== undefined) {
			this.show(this.ctx);
		}
	}

	/** Clean up event subscription and timer. Call on session_shutdown. */
	destroy(): void {
		this.unsubscribe();
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = undefined;
		}
	}

	// -------------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------------

	private renderWidget(width: number, theme: unknown): string[] {
		const t = theme as {
			fg: (color: string, text: string) => string;
			bold: (text: string) => string;
		};

		const watches = Object.values(this.getWatches()).filter((w) => !w.terminal);

		// Build flat display entries: job watches → one entry; workflow watches →
		// one entry per JOB node (or a single fallback row when no nodes yet).
		type Entry = {
			displayName: string;
			state: string;
			startedOn?: string;
			numberOfWorkers?: number;
			workerType?: string;
		};

		const entries: Entry[] = [];
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
					entries.push({
						displayName: watch.name,
						state: b?.state ?? "",
					});
				}
			}
		}

		const container = new Container();
		const borderColor = (s: string) => t.fg("accent", s);

		container.addChild(new DynamicBorder(borderColor));
		container.addChild(
			new Text(
				t.fg("accent", t.bold("Glue Watcher")) +
					t.fg("dim", ` (${entries.length})  poll: ${Math.round(this.getPollIntervalMs() / 1000)}s`),
				1,
				0,
			),
		);

		const seen = new Set<string>();
		const dedupedEntries = entries.filter((e) => {
			if (seen.has(e.displayName)) return false;
			seen.add(e.displayName);
			return true;
		});
		const longestName = dedupedEntries.reduce((m, e) => Math.max(m, e.displayName.length), COL_NAME_MIN);
		const colName = Math.min(longestName, width - COL_FIXED_OVERHEAD - 1);

		const rows = dedupedEntries.map((entry) => {
			const state = entry.state;

			// -- name --
			const nameRaw =
				entry.displayName.length > colName
					? `${entry.displayName.substring(0, colName - 3)}...`
					: entry.displayName;
			const name = t.fg("text", nameRaw.padEnd(colName));

			// -- state: colored by outcome --
			const stateRaw = (state || "?").padEnd(COL_STATE);
			let stateStr: string;
			if (state === "RUNNING" || state === "STARTING") {
				stateStr = t.fg("warning", stateRaw);
			} else if (state === "SUCCEEDED" || state === "COMPLETED") {
				stateStr = t.fg("success", stateRaw);
			} else if (
				state === "FAILED" ||
				state === "ERROR" ||
				state === "TIMEOUT" ||
				state === "STOPPED"
			) {
				stateStr = t.fg("error", stateRaw);
			} else {
				stateStr = stateRaw;
			}

			// -- elapsed time --
			const started = formatElapsed(entry.startedOn).padEnd(COL_STARTED);

			// -- worker count × type --
			let workersStr = "-";
			if (entry.numberOfWorkers != null) {
				workersStr = `${entry.numberOfWorkers}×${entry.workerType ?? "?"}`;
			}
			const workers = workersStr.padEnd(COL_WORKERS);

			return ` ${name} ${stateStr} ${started} ${workers}`;
		});

		if (rows.length > 0) {
			container.addChild(new Text(rows.join("\n"), 1, 0));
		}

		container.addChild(new DynamicBorder(borderColor));
		return container.render(width);
	}
}
