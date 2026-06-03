/**
 * `/local-issue-watcher` TUI menu.
 *
 * Single entry-point: any invocation of `/local-issue-watcher` (with or
 * without args) opens an interactive `ctx.ui.select` menu. Args are accepted
 * but ignored — every action is reachable from the menu instead.
 *
 * Menu items (in order):
 *   1. Browse issues (N open)  → opens the TUI picker via makeInfoTuiPicker
 *   2. Refresh                 → forced poll-equivalent scan + diff
 *   3. Close                   → exit the loop
 */

import { existsSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type WatcherState } from "./format.js";
import { handleInfo, type InfoPicker } from "./infoHandler.js";
import { makeInfoTuiPicker } from "./infoTui.js";
import { scanIssueFiles } from "./scanner.js";
import type { Snapshot } from "./types.js";

// Import Runtime as a type only — type-only imports are erased at compile time,
// so this creates zero runtime circular dependency even if index.ts imports
// runLocalIssueWatcherCommand from this file.
import type { Runtime } from "./index.js";

// ---------------------------------------------------------------------------
// Menu labels (exported for tests)
// ---------------------------------------------------------------------------

/** The key used with `ctx.ui.setStatus` to manage the persistent footer row. */
export const STATUS_KEY = "pi-local-issue-watcher";

export const MENU_TITLE = "Local Issue Watcher";
export const ITEM_BROWSE_PREFIX = "Browse issues";
export const ITEM_REFRESH = "Refresh";
export const ITEM_ENABLE = "Enable watcher";
export const ITEM_DISABLE = "Disable watcher";
export const ITEM_CLOSE = "Close";

// ---------------------------------------------------------------------------
// Dependency injection — avoids circular imports with index.ts
// ---------------------------------------------------------------------------

/** Runtime callbacks that index.ts provides to the command. */
export interface LocalIssueWatcherCommandDeps {
	startPolling: (rt: Runtime) => void;
	stopPolling: (rt: Runtime) => void;
	/**
	 * Force-refresh: scan + diff + emit chat. Updates rt.snapshot, refreshes the status row.
	 */
	forceRefresh: (rt: Runtime) => void;
	refreshStatusLine: (
		ui: Runtime["ui"],
		rt: Pick<Runtime, "dbRoot">,
		state: WatcherState,
		snapshot: Snapshot,
	) => void;
	/** Return the current infoPickerOverride (or null to fall back to the real TUI). */
	getInfoPickerOverride: () => InfoPicker | null;
	/** Persist the enabled flag to the session log. */
	persistEnabled: (enabled: boolean) => void;
}

type MenuCtx = {
	hasUI?: boolean;
	ui?: {
		select?: (title: string, items: string[]) => Promise<string | null | undefined>;
		notify?: (msg: string, level?: "info" | "warning" | "error") => void;
		setStatus?: (key: string, text: string | undefined) => void;
		hasUI?: boolean;
	};
};

/**
 * Public entry point wired via `pi.registerCommand("local-issue-watcher", ...)`.
 *
 * Args are accepted but ignored — the menu always opens.
 */
export async function runLocalIssueWatcherCommand(
	_args: string | undefined,
	ctx: unknown,
	rt: Runtime,
	_pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">,
	deps: LocalIssueWatcherCommandDeps,
): Promise<void> {
	const menuCtx = ctx as MenuCtx;
	const ui = menuCtx?.ui;
	const select = ui?.select;

	if (!select) {
		ui?.notify?.(
			"local-issue-watcher: requires an interactive UI.",
			"warning",
		);
		return;
	}

	// Sync rt.ui from the current ctx so forceRefresh / refreshStatusLine see
	// a live notification channel even when called before session_start (e.g.
	// in tests that invoke the command handler directly).
	const anyCtx = ctx as { hasUI?: boolean; ui?: Runtime["ui"] };
	const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
	if (hasUI) {
		rt.ui = anyCtx.ui ?? null;
	}

	while (true) {
		const openCount = Object.values(rt.snapshot).filter(
			(i) => i.status === "open",
		).length;
		const browseItem = `${ITEM_BROWSE_PREFIX} (${openCount} open)`;
		const items = [
			browseItem,
			ITEM_REFRESH,
			rt.enabled ? ITEM_DISABLE : ITEM_ENABLE,
			ITEM_CLOSE,
		];

		const choice = await select(MENU_TITLE, items);
		if (!choice || choice === ITEM_CLOSE) return;

		// ── Enable ──────────────────────────────────────────────────────────
		if (choice === ITEM_ENABLE) {
			deps.persistEnabled(true);
			rt.enabled = true;
			deps.startPolling(rt);
			deps.refreshStatusLine(rt.ui, rt, "active", rt.snapshot);
			continue;
		}

		// ── Disable ─────────────────────────────────────────────────────────
		if (choice === ITEM_DISABLE) {
			deps.persistEnabled(false);
			rt.enabled = false;
			deps.stopPolling(rt);
			ui?.setStatus?.(STATUS_KEY, undefined);
			continue;
		}

		// ── Browse ──────────────────────────────────────────────────────────
		if (choice.startsWith(ITEM_BROWSE_PREFIX)) {
			if (!existsSync(rt.dbRoot)) {
				ui?.notify?.(
					`local-issue-watcher browse: dbRoot not found (${rt.dbRoot})`,
					"warning",
				);
				continue; // stay in the menu — do NOT close
			}
			const picker =
				deps.getInfoPickerOverride() ?? makeInfoTuiPicker(ctx as never);
			await handleInfo({
				dbRoot: rt.dbRoot,
				scan: (root) => scanIssueFiles(root),
				picker,
			});
			continue;
		}

		// ── Refresh ─────────────────────────────────────────────────────────
		if (choice === ITEM_REFRESH) {
			if (!existsSync(rt.dbRoot)) {
				ui?.notify?.(
					`local-issue-watcher: dbRoot not found (${rt.dbRoot})`,
					"warning",
				);
				continue;
			}
			deps.forceRefresh(rt);
			const openAfter = Object.values(rt.snapshot).filter(
				(i) => i.status === "open",
			).length;
			ui?.notify?.(
				`local-issue-watcher: refreshed (${openAfter} open)`,
				"info",
			);
			continue;
		}
	}
}
