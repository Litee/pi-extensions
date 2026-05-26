/**
 * `/file-system-watcher` TUI menu for pi-file-system-watcher.
 *
 * Any invocation of `/file-system-watcher` (with or without args) opens an
 * interactive menu via `ctx.ui.select`. Menu items:
 *   - Browse watches (N)          → log the current watch list via notify
 *   - Paused: off|on              → toggle pause
 *   - Display mode: widget|statusline → toggle session display mode
 *   - User default display mode   → cycle unset|widget|statusline (persisted)
 *   - Close
 */

import { extractUiSurface } from "pi-watcher-core/ui-surface";

import { loadConfig, saveConfig, type DisplayMode } from "./config.js";
import { writeState } from "./persistence.js";
import { refreshStatus, startPolling, stopPolling, type Runtime } from "./runtime.js";

// ---------------------------------------------------------------------------
// Menu labels
// ---------------------------------------------------------------------------

export const MENU_TITLE = "FS Watcher";
export const ITEM_BROWSE_PREFIX = "Browse watches";
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

function nextUserDefault(curr: DisplayMode | undefined): DisplayMode {
	return (curr ?? "widget") === "widget" ? "statusline" : "widget";
}

/** Toggle session display mode between widget and statusline. */
function toggleDisplayMode(rt: Runtime, _ctx: unknown): void {
	rt.displayMode = rt.displayMode === "widget" ? "statusline" : "widget";
	writeState(rt.pi, rt);
	refreshStatus(rt);
}

export async function runFsWatcherCommand(
	_args: string | undefined,
	ctx: unknown,
	rt: Runtime,
): Promise<void> {
	const menuCtx = ctx as MenuCtx;
	const surface = extractUiSurface(ctx);
	const select = menuCtx?.ui?.select;

	if (!select) {
		surface?.notify?.("file-system-watcher: requires an interactive UI.", "warning");
		return;
	}

	while (true) {
		const watchCount = Object.keys(rt.watches).length;
		const userDefault: DisplayMode | undefined = loadConfig().defaultDisplayMode;

		const browseItem = `${ITEM_BROWSE_PREFIX} (${watchCount})`;
		const pausedItem = `${ITEM_PAUSED_PREFIX} ${rt.paused ? "on" : "off"}`;
		const displayItem = `${ITEM_DISPLAY_PREFIX} ${rt.displayMode}`;
		const userDefaultItem = `${ITEM_USER_DEFAULT_PREFIX} ${userDefaultLabel(userDefault)}`;

		const items = [browseItem, pausedItem, displayItem, userDefaultItem, ITEM_CLOSE];
		const choice = await select(MENU_TITLE, items);
		if (!choice || choice === ITEM_CLOSE) return;

		if (choice.startsWith(ITEM_BROWSE_PREFIX)) {
			const ids = Object.keys(rt.watches);
			if (ids.length === 0) {
				surface?.notify?.("file-system-watcher: no watches configured.", "info");
			} else {
				const lines = ids.map((id) => {
					const w = rt.watches[id];
					if (!w) return `[${id}] (missing)`;
					const state =
						w.baseline === undefined ? "?" : w.baseline.exists ? "present" : "absent";
					return `[${id}] ${w.path} target=${w.target} state=${state}${w.terminal ? " [done]" : ""}`;
				});
				surface?.notify?.(`file-system-watcher:\n${lines.join("\n")}`, "info");
			}
			continue;
		}

		if (choice.startsWith(ITEM_PAUSED_PREFIX)) {
			rt.paused = !rt.paused;
			if (rt.paused) {
				stopPolling(rt);
			} else {
				const hasActive = Object.values(rt.watches).some((w) => !w.terminal);
				if (hasActive && !rt.scheduler.isRunning) startPolling(rt);
			}
			writeState(rt.pi, rt);
			refreshStatus(rt);
			surface?.notify?.(
				`file-system-watcher: ${rt.paused ? "paused" : "resumed"}.`,
				"info",
			);
			continue;
		}

		if (choice.startsWith(ITEM_DISPLAY_PREFIX)) {
			toggleDisplayMode(rt, ctx);
			surface?.notify?.(
				`file-system-watcher: session display → ${rt.displayMode}.`,
				"info",
			);
			continue;
		}

		if (choice.startsWith(ITEM_USER_DEFAULT_PREFIX)) {
			const next = nextUserDefault(userDefault);
			const ok = saveConfig({ defaultDisplayMode: next });
			if (ok) {
				surface?.notify?.(
					`file-system-watcher: user default → ${userDefaultLabel(next)} (saved to ~/.pi/agent/pi-file-system-watcher.json).`,
					"info",
				);
			} else {
				surface?.notify?.(
					"file-system-watcher: failed to write user config; change was not saved.",
					"warning",
				);
			}
			continue;
		}
	}
}
