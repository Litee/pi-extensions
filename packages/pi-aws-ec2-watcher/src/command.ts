/**
 * `/ec2-watcher` TUI menu.
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
import { WatchesView } from "./ui/watches-view.js";

// ---------------------------------------------------------------------------
// Menu labels (exported for tests)
// ---------------------------------------------------------------------------

export const MENU_TITLE = "EC2 Instance Watcher";
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

export async function runEc2WatcherCommand(
	_args: string | undefined,
	ctx: unknown,
	rt: Runtime,
): Promise<void> {
	const menuCtx = ctx as MenuCtx;
	const surface = extractUiSurface(ctx);
	const select = menuCtx?.ui?.select;
	if (!select) {
		surface?.notify?.("ec2-watcher: requires an interactive UI.", "warning");
		return;
	}

	while (true) {
		const watchCount = Object.keys(rt.watches).length;
		const sessionMode = rt.displayMode;
		const userDefault: DisplayMode | undefined = loadConfig().defaultDisplayMode;

		const browseItem = `${ITEM_BROWSE_PREFIX} (${watchCount})`;
		const pausedItem = `${ITEM_PAUSED_PREFIX} ${rt.paused ? "on" : "off"}`;
		const displayItem = `${ITEM_DISPLAY_PREFIX} ${sessionMode}`;
		const userDefaultItem = `${ITEM_USER_DEFAULT_PREFIX} ${userDefaultLabel(userDefault)}`;

		const items = [browseItem, pausedItem, displayItem, userDefaultItem, ITEM_CLOSE];
		const choice = await select(MENU_TITLE, items);
		if (!choice || choice === ITEM_CLOSE) return;

		if (choice.startsWith(ITEM_BROWSE_PREFIX)) {
			await openBrowseView(ctx, rt);
			continue;
		}

		if (choice.startsWith(ITEM_PAUSED_PREFIX)) {
			togglePaused(rt);
			surface?.notify?.(
				`ec2-watcher: ${rt.paused ? "paused" : "resumed"}.`,
				"info",
			);
			continue;
		}

		if (choice.startsWith(ITEM_DISPLAY_PREFIX)) {
			toggleDisplayMode(rt, ctx);
			surface?.notify?.(
				`ec2-watcher: session display → ${rt.displayMode}.`,
				"info",
			);
			continue;
		}

		if (choice.startsWith(ITEM_USER_DEFAULT_PREFIX)) {
			const next = nextUserDefault(userDefault);
			const ok = saveConfig({ defaultDisplayMode: next });
			if (ok) {
				surface?.notify?.(
					`ec2-watcher: user default → ${userDefaultLabel(next)} (saved to ~/.pi/agent/pi-aws-ec2-watcher.json).`,
					"info",
				);
			} else {
				surface?.notify?.(
					"ec2-watcher: failed to write user config; change was not saved.",
					"warning",
				);
			}
			continue;
		}
	}
}

async function openBrowseView(ctx: unknown, rt: Runtime): Promise<void> {
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
		surface?.notify?.("ec2-watcher: browse requires an interactive UI.", "warning");
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
					await rt.client.stopInstance(watch.instanceId, watch.profile, watch.region);
				},
				async (row) => {
					const watch = rt.watches[row.watchId];
					if (!watch) return;
					await rt.client.startInstance(watch.instanceId, watch.profile, watch.region);
				},
				(watchId) => {
					delete rt.watches[watchId];
					const stillActive = Object.values(rt.watches).some((w) => !w.terminal);
					if (!stillActive) stopPolling(rt);
					writeState(rt.pi, rt);
					rt.pi.events.emit("ec2:change", {});
				},
				() => rt.scheduler.intervalMs,
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
