/**
 * `/glue-watcher` TUI menu.
 *
 * Single entry-point: any invocation of `/glue-watcher` (with or without
 * args) opens an interactive menu via `ctx.ui.select`. Subcommands have
 * been removed — every action is reachable from the menu instead.
 *
 * Menu items (flat — no nested settings sub-menu):
 *   - Browse watches (N)        → opens the WatchesView overlay
 *   - Paused                    → switch (off|on)
 *   - Display mode              → switch (widget|statusline) — session-scoped
 *   - User default display mode → cycle (unset|widget|statusline) — persisted
 *   - Close
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractUiSurface } from "pi-watcher-core/ui-surface";

import { loadConfig, saveConfig, type DisplayMode } from "./config.js";
import type { GlueClient } from "./glue-client.js";
import { writeState } from "./persistence.js";
import {
	minIntervalMs,
	stopPolling,
	stopWatchPolling,
	toggleDisplayMode,
	type Runtime,
} from "./runtime.js";
import { WatchesView } from "./ui/watches-view.js";

// ---------------------------------------------------------------------------
// Menu labels (exported for tests)
// ---------------------------------------------------------------------------

export const MENU_TITLE = "Glue Watcher";
export const ITEM_BROWSE_PREFIX = "Browse watches";
export const ITEM_DISPLAY_PREFIX = "Display mode:";
export const ITEM_USER_DEFAULT_PREFIX = "User default display mode:";
export const ITEM_CLOSE = "Close";

type SettingsCtx = {
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
 * Public entry point wired via `pi.registerCommand("glue-watcher", ...)`.
 *
 * Args are accepted but ignored — the menu always opens. This is a deliberate
 * break from the previous `status | browse | settings` interface; all of
 * those actions live inside the menu now.
 */
export async function runGlueWatcherCommand(
	_args: string | undefined,
	ctx: unknown,
	rt: Runtime,
	_pi: ExtensionAPI,
	client: GlueClient,
): Promise<void> {
	const settingsCtx = ctx as SettingsCtx;
	const surface = extractUiSurface(ctx);
	const select = settingsCtx?.ui?.select;
	if (!select) {
		surface?.notify?.(
			"glue-watcher: requires an interactive UI.",
			"warning",
		);
		return;
	}

	while (true) {
		const watchCount = Object.keys(rt.watches).length;
		const sessionMode = rt.displayMode;
		const userDefault: DisplayMode | undefined = loadConfig().defaultDisplayMode;

		const browseItem = `${ITEM_BROWSE_PREFIX} (${watchCount})`;
		const displayItem = `${ITEM_DISPLAY_PREFIX} ${sessionMode}`;
		const userDefaultItem = `${ITEM_USER_DEFAULT_PREFIX} ${userDefaultLabel(userDefault)}`;

		const items = [browseItem, displayItem, userDefaultItem, ITEM_CLOSE];
		const choice = await select(MENU_TITLE, items);
		if (!choice || choice === ITEM_CLOSE) return;

		if (choice.startsWith(ITEM_BROWSE_PREFIX)) {
			await openBrowseView(ctx, rt, client);
			continue;
		}

		if (choice.startsWith(ITEM_DISPLAY_PREFIX)) {
			toggleDisplayMode(rt, ctx);
			surface?.notify?.(
				`glue-watcher: session display → ${rt.displayMode}.`,
				"info",
			);
			continue;
		}

		if (choice.startsWith(ITEM_USER_DEFAULT_PREFIX)) {
			const next = nextUserDefault(userDefault);
			const ok = saveConfig({ defaultDisplayMode: next });
			if (ok) {
				surface?.notify?.(
					`glue-watcher: user default → ${userDefaultLabel(next)} (saved to ~/.pi/agent/pi-aws-glue-watcher.json).`,
					"info",
				);
			} else {
				surface?.notify?.(
					"glue-watcher: failed to write user config; change was not saved.",
					"warning",
				);
			}
			continue;
		}
	}
}

async function openBrowseView(
	ctx: unknown,
	rt: Runtime,
	client: GlueClient,
): Promise<void> {
	const surface = extractUiSurface(ctx);
	const ctxWithCustom = ctx as {
		ui?: {
			custom?: <T>(
				factory: (
					tui: unknown,
					theme: unknown,
					kb: unknown,
					done: (v: T) => void,
				) => unknown,
				options?: unknown,
			) => Promise<T>;
		};
	};
	if (!ctxWithCustom?.ui?.custom) {
		surface?.notify?.(
			"glue-watcher: browse requires an interactive UI.",
			"warning",
		);
		return;
	}
	await ctxWithCustom.ui.custom<void>(
		(tui, theme, _kb, done) => {
			const requestRender = (tui as { requestRender: () => void }).requestRender.bind(tui);
			return new WatchesView(
				() => rt.watches,
				theme as never,
				requestRender,
				() => done(undefined),
				async (row) => {
					const watch = rt.watches[row.watchId];
					if (!watch) return;
					if (watch.type === "job") {
						await client.stopJobRun(watch.name, watch.runId, watch.profile, watch.region);
					} else {
						await client.stopWorkflowRun(watch.name, watch.runId, watch.profile, watch.region);
					}
				},
				(watchId) => {
					stopWatchPolling(rt, watchId);
					delete rt.watches[watchId];
					if (Object.keys(rt.watches).length === 0) stopPolling(rt);
					writeState(rt.pi, rt);
					rt.pi.events.emit("glue:change", {});
				},
				() => minIntervalMs(rt),
				() => toggleDisplayMode(rt, ctx),
				() => rt.displayMode,
			);
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" },
		},
	);
}
