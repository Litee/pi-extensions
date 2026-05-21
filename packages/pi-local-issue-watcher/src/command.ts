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
 *   3. Paused: on/off          → toggle pause state
 *   4. Close                   → exit the loop
 */

import { existsSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildParseFailureToast, type WatcherState } from "./format.js";
import { handleInfo, type InfoPicker } from "./infoHandler.js";
import { makeInfoTuiPicker } from "./infoTui.js";
import { persistRunState } from "./persistence.js";
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
export const ITEM_PAUSED_PREFIX = "Paused:";
export const ITEM_CLOSE = "Close";

// ---------------------------------------------------------------------------
// Dependency injection — avoids circular imports with index.ts
// ---------------------------------------------------------------------------

/** Runtime callbacks that index.ts provides to the command. */
export interface LocalIssueWatcherCommandDeps {
	startPolling: (rt: Runtime) => void;
	stopPolling: (rt: Runtime) => void;
	/**
	 * Force-refresh: scan + diff + emit chat (same as pollOnce but ignores the
	 * paused flag). Updates rt.snapshot, refreshes the status row.
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
 * Args are accepted but ignored — the menu always opens. This replaces the
 * old `pause | resume | status | browse` subcommand interface.
 */
export async function runLocalIssueWatcherCommand(
	_args: string | undefined,
	ctx: unknown,
	rt: Runtime,
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">,
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
		const pausedItem = `${ITEM_PAUSED_PREFIX} ${rt.paused ? "on" : "off"}`;
		const items = [browseItem, ITEM_REFRESH, pausedItem, ITEM_CLOSE];

		const choice = await select(MENU_TITLE, items);
		if (!choice || choice === ITEM_CLOSE) return;

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

		// ── Pause / Resume ───────────────────────────────────────────────────
		if (choice.startsWith(ITEM_PAUSED_PREFIX)) {
			if (!rt.paused) {
				// Pause ↓
				rt.paused = true;
				deps.stopPolling(rt);
				try {
					persistRunState(pi, true);
				} catch {
					/* persistence failure must not abort the action */
				}
				// #0019: paused = silent + zero-IO. Clear the pinned status row.
				rt.ui?.setStatus?.(STATUS_KEY, undefined);
				ui?.notify?.(
					`local-issue-watcher: paused (dbRoot=${rt.dbRoot})`,
					"info",
				);
			} else {
				// Resume ↑
				rt.paused = false;
				try {
					persistRunState(pi, false);
				} catch {
					/* persistence failure must not abort the action */
				}
				let resumeFailureCount = 0;
				const resumedSnap = existsSync(rt.dbRoot)
					? scanIssueFiles(rt.dbRoot, rt.snapshot, () => {
							resumeFailureCount += 1;
					  })
					: ({} as Snapshot);
				if (existsSync(rt.dbRoot)) {
					rt.snapshot = resumedSnap;
					deps.startPolling(rt);
				}
				// #0029: resume is a fresh scan site — fire the one-shot toast if
				// bad files were found and the session hasn't already toasted.
				if (
					resumeFailureCount > 0 &&
					ui !== undefined &&
					ui.hasUI !== false &&
					ui.notify !== undefined &&
					!rt.parseFailureToastState.hasToasted
				) {
					ui.notify(buildParseFailureToast(resumeFailureCount), "warning");
					rt.parseFailureToastState.hasToasted = true;
				}
				deps.refreshStatusLine(rt.ui, rt, "active", resumedSnap);
				ui?.notify?.(
					`local-issue-watcher: resumed (dbRoot=${rt.dbRoot})`,
					"info",
				);
			}
			continue;
		}
	}
}
