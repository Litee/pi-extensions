/**
 * S3Widget — TUI panel rendered below the chat editor.
 *
 * Pure row-building lives in `./widgetRows.ts`. This module is the
 * Container + DynamicBorder shell plus the refresh-timer / event-subscription
 * lifecycle.
 *
 * The widget auto-refreshes every 30 seconds so timeout labels stay current,
 * and also re-renders whenever an "s3:change" event fires.
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
} from "./widgetRows.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIDGET_ID = "s3-watcher";

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Format the right-hand side of the widget header:
 * `" (N)  poll: Xs"` where N is the count of non-terminal watches.
 */
export function formatHeaderSuffix(watches: WatchMap, pollIntervalMs: number): string {
	const activeCount = Object.values(watches).filter((w) => !w.terminal).length;
	const pollSeconds = Math.round(pollIntervalMs / 1000);
	return ` (${activeCount})  poll: ${pollSeconds}s`;
}

// ---------------------------------------------------------------------------
// S3Widget
// ---------------------------------------------------------------------------

export class S3Widget {
	private ctx: unknown = undefined;
	private refreshInterval: NodeJS.Timeout | undefined;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly pi: Pick<ExtensionAPI, "events">,
		private readonly getWatches: () => WatchMap,
		private readonly getPollIntervalMs: () => number,
	) {
		this.unsubscribe = this.pi.events.on("s3:change", () => this.refresh());
	}

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

	hide(ctx: unknown): void {
		const anyCtx = ctx as { ui?: { setWidget?: (...args: unknown[]) => void } };
		anyCtx.ui?.setWidget?.(WIDGET_ID, undefined);
		// Clear the cached ctx so a later s3:change event (from the poll loop)
		// does not re-show the panel after the user switched display modes.
		this.ctx = undefined;
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

		const entries = buildWidgetEntries(this.getWatches());

		const container = new Container();
		const borderColor = (s: string) => t.fg("accent", s);

		container.addChild(new DynamicBorder(borderColor));
		container.addChild(
			new Text(
				t.fg("accent", t.bold("S3 Watcher")) +
					t.fg("dim", formatHeaderSuffix(this.getWatches(), this.getPollIntervalMs())),
				1,
				0,
			),
		);

		const longestName = entries.reduce(
			(m, e) => Math.max(m, e.displayName.length),
			COL_NAME_MIN,
		);
		const nameColWidth = Math.min(longestName, width - COL_FIXED_OVERHEAD - 1);

		const rows = entries.map((entry) => renderEntryLine(entry, nameColWidth, t));

		if (rows.length > 0) {
			container.addChild(new Text(rows.join("\n"), 1, 0));
		}

		container.addChild(new DynamicBorder(borderColor));
		return container.render(width);
	}
}
