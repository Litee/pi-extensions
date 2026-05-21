/**
 * `/s3-watcher` TUI menu.
 *
 * Single entry-point: any invocation of `/s3-watcher` (with or without
 * args) opens an interactive menu via `ctx.ui.select`. Subcommands have
 * been removed — every action is reachable from the menu instead.
 *
 * Menu items (flat — no nested settings sub-menu):
 *   - Paused                    → switch (off|on)
 *   - Display mode              → switch (widget|statusline) — session-scoped
 *   - User default display mode → cycle (unset|widget|statusline) — persisted
 *   - Close
 *
 * S3 has no equivalent of the Glue WatchesView yet, so there is no "Browse"
 * row; the widget / status-line surfaces remain the live view of watches.
 */

import { extractUiSurface } from "pi-watcher-core/ui-surface";

import { loadConfig, saveConfig, type DisplayMode } from "./config.js";
import { writeState } from "./persistence.js";
import {
	refreshStatus,
	startPolling,
	stopPolling,
	toggleDisplayMode,
	type Runtime,
} from "./runtime.js";

// ---------------------------------------------------------------------------
// Menu labels (exported for tests)
// ---------------------------------------------------------------------------

export const MENU_TITLE = "S3 Watcher";
export const ITEM_PAUSED_PREFIX = "Paused:";
export const ITEM_DISPLAY_PREFIX = "Display mode:";
export const ITEM_USER_DEFAULT_PREFIX = "User default display mode:";
export const ITEM_CLOSE = "Close";

type MenuCtx = {
	hasUI?: boolean;
	ui?: {
		select?: (title: string, items: string[]) => Promise<string | null | undefined>;
		notify?: (msg: string, level?: "info" | "warning" | "error") => void;
	};
};

function userDefaultLabel(mode: DisplayMode | undefined): string {
	return mode ?? "unset";
}

/**
 * Two-state switch for the persisted user default. An `undefined` (never set)
 * value is treated as "widget" for the purpose of choosing the next state,
 * matching the legacy settings-menu behaviour.
 */
function nextUserDefault(curr: DisplayMode | undefined): DisplayMode {
	return (curr ?? "widget") === "widget" ? "statusline" : "widget";
}

/**
 * Public entry point wired via `pi.registerCommand("s3-watcher", ...)`.
 *
 * Args are accepted but ignored — the menu always opens.
 */
export async function runS3WatcherCommand(
	_args: string | undefined,
	ctx: unknown,
	rt: Runtime,
): Promise<void> {
	const menuCtx = ctx as MenuCtx;
	const surface = extractUiSurface(ctx);
	const select = menuCtx?.ui?.select;
	if (!select) {
		surface?.notify?.(
			"s3-watcher: requires an interactive UI.",
			"warning",
		);
		return;
	}

	while (true) {
		const sessionMode = rt.displayMode;
		const userDefault: DisplayMode | undefined = loadConfig().defaultDisplayMode;

		const pausedItem = `${ITEM_PAUSED_PREFIX} ${rt.paused ? "on" : "off"}`;
		const displayItem = `${ITEM_DISPLAY_PREFIX} ${sessionMode}`;
		const userDefaultItem = `${ITEM_USER_DEFAULT_PREFIX} ${userDefaultLabel(userDefault)}`;

		const items = [pausedItem, displayItem, userDefaultItem, ITEM_CLOSE];
		const choice = await select(MENU_TITLE, items);
		if (!choice || choice === ITEM_CLOSE) return;

		if (choice.startsWith(ITEM_PAUSED_PREFIX)) {
			togglePaused(rt);
			surface?.notify?.(
				`s3-watcher: ${rt.paused ? "paused" : "resumed"}.`,
				"info",
			);
			continue;
		}

		if (choice.startsWith(ITEM_DISPLAY_PREFIX)) {
			toggleDisplayMode(rt, ctx);
			surface?.notify?.(
				`s3-watcher: session display → ${rt.displayMode}.`,
				"info",
			);
			continue;
		}

		if (choice.startsWith(ITEM_USER_DEFAULT_PREFIX)) {
			const next = nextUserDefault(userDefault);
			const ok = saveConfig({ defaultDisplayMode: next });
			if (ok) {
				surface?.notify?.(
					`s3-watcher: user default → ${userDefaultLabel(next)} (saved to ~/.pi/agent/pi-aws-s3-watcher.json).`,
					"info",
				);
			} else {
				surface?.notify?.(
					"s3-watcher: failed to write user config; change was not saved.",
					"warning",
				);
			}
			continue;
		}
	}
}

function togglePaused(rt: Runtime): void {
	rt.paused = !rt.paused;
	if (rt.paused) {
		stopPolling(rt);
	} else {
		const hasActive = Object.values(rt.watches).some((w) => !w.terminal);
		if (hasActive && !rt.scheduler.isRunning) startPolling(rt);
	}
	writeState(rt.pi, rt);
	refreshStatus(rt);
}
