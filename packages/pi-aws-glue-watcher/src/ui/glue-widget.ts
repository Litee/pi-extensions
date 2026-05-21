/**
 * GlueWidget — TUI panel rendered below the chat editor.
 *
 * Pure row-building, state-colour mapping, and per-row formatting live in
 * `./widgetRows.ts`. This module is the Container + DynamicBorder shell
 * plus the refresh-timer / event-subscription lifecycle.
 *
 * The widget auto-refreshes every 30 seconds so elapsed-time labels stay
 * current, and also re-renders whenever a "glue:change" event fires.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import type { WatchMap } from "../types.js";
import {
	buildWidgetEntries,
	COL_FIXED_OVERHEAD,
	COL_NAME_MIN,
	renderEntryLine,
	stateStyle,
} from "./widgetRows.js";

// Mirrors runtime.ts POLL_ERROR_THRESHOLD (DEFAULT_POLL_ERROR_THRESHOLD = 5).
// keep in sync with runtime.ts
const WIDGET_POLL_ERROR_THRESHOLD = 5;

/**
 * Format the right-hand side of the widget header:
 * `" (M/N)"` where M = succeeded/completed watches and N = total watch count.
 * Appends ` ⚠` when errors are present.
 *
 * @param watches   The current watch map.
 * @param _pollIntervalMs  Accepted for back-compat; not rendered.
 * @param opts      Optional `{ hasErrors }` flag (e.g. from consecutive-error
 *                  threshold). Error state is also derived directly from
 *                  watches so the caller only needs to pass extra sources.
 */
export function formatHeaderCountsSuffix(
	watches: WatchMap,
	_pollIntervalMs?: number,
	opts?: { hasErrors?: boolean },
): string {
	const all = Object.values(watches);
	const N = all.length;
	const M = all.filter((w) => w.baseline && stateStyle(w.baseline.state) === "success").length;
	// keep in sync with runtime.ts hasErrors derivation
	const errorInStates = all.some((w) => stateStyle(w.baseline?.state ?? "") === "error");
	const effectiveHasErrors = errorInStates || (opts?.hasErrors ?? false);
	return effectiveHasErrors ? ` (${M}/${N}) ⚠` : ` (${M}/${N})`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIDGET_ID = "glue-watcher";

// ---------------------------------------------------------------------------
// Module-level helper
// ---------------------------------------------------------------------------

/**
 * Format elapsed time as a compact string.
 *
 * - With only `startedOn`: returns the live elapsed since `startedOn`
 *   (recomputed on every render, so the widget keeps ticking for in-flight
 *   runs).
 * - With both timestamps: returns the *frozen* run duration
 *   `completedOn - startedOn`. Once a run reaches a terminal state the
 *   permanent panel must stop counting up — it should display the final
 *   wall-clock duration of that run, not minutes-since-it-finished.
 *
 * Returns "-" when `startedOn` is absent or unparseable.
 *
 * Examples: "0s", "45s", "7m", "1h30m", "3h5m"
 */
export function formatElapsed(
	startedOn: string | undefined,
	completedOn?: string,
): string {
	if (!startedOn) return "-";
	const startMs = new Date(startedOn).getTime();
	if (Number.isNaN(startMs)) return "-";
	const endMs = completedOn ? new Date(completedOn).getTime() : Date.now();
	const ms = (Number.isNaN(endMs) ? Date.now() : endMs) - startMs;
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

	show(ctx: unknown): void {
		this.ctx = ctx;

		if (Object.values(this.getWatches()).length === 0) {
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

	hide(ctx: unknown): void {
		const anyCtx = ctx as { ui?: { setWidget?: (...args: unknown[]) => void } };
		anyCtx.ui?.setWidget?.(WIDGET_ID, undefined);
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = undefined;
		}
	}

	refresh(): void {
		if (this.ctx !== undefined) {
			this.show(this.ctx);
		}
	}

	destroy(): void {
		this.unsubscribe();
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = undefined;
		}
	}

	// -------------------------------------------------------------------------
	// Rendering (Container + DynamicBorder shell)
	// -------------------------------------------------------------------------

	private renderWidget(width: number, theme: unknown): string[] {
		const t = theme as {
			fg: (color: string, text: string) => string;
			bold: (text: string) => string;
		};

		const watches = this.getWatches();
		const entries = buildWidgetEntries(watches);

		// Derive hasErrors: any watch in an error state OR consecutive-error
		// threshold reached. keep in sync with runtime.ts hasErrors derivation.
		const watchList = Object.values(watches);
		const widgetHasErrors =
			watchList.some((w) => stateStyle(w.baseline?.state ?? "") === "error") ||
			watchList.some((w) => !w.terminal && w.consecutiveErrors >= WIDGET_POLL_ERROR_THRESHOLD);

		const container = new Container();
		const borderColor = (s: string) => t.fg("accent", s);

		container.addChild(new DynamicBorder(borderColor));
		container.addChild(
			new Text(
				t.fg("accent", t.bold("Glue Watcher")) +
					t.fg("dim", formatHeaderCountsSuffix(watches, this.getPollIntervalMs(), { hasErrors: widgetHasErrors })),
				1,
				0,
			),
		);

		const longestName = entries.reduce((m, e) => Math.max(m, e.displayName.length), COL_NAME_MIN);
		const colName = Math.min(longestName, width - COL_FIXED_OVERHEAD - 1);

		const rows = entries.map((entry) => renderEntryLine(entry, colName, t));

		if (rows.length > 0) {
			container.addChild(new Text(rows.join("\n"), 1, 0));
		}

		container.addChild(new DynamicBorder(borderColor));
		return container.render(width);
	}
}
