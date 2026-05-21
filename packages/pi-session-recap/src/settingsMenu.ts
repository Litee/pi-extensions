/**
 * `/recap-settings` interactive TUI menu.
 *
 * Shows a read-only snapshot of the current recap status (same content as
 * the legacy `/recap status` subcommand printed in the chat) plus an
 * editable `Idle timeout` row. Selections that map to read-only rows are
 * a no-op and just redraw the menu; `Edit idle timeout` prompts for a
 * number; `Close` exits.
 *
 * All overrides set from this menu are session-scoped — they live in the
 * caller's mutable `state` object and are reset on `session_shutdown`
 * back in `index.ts`.
 *
 * This module is split out from `index.ts` so the menu logic can be
 * unit-tested with a stub `ctx.ui` surface (no pi runtime, no real TUI).
 */

import { buildStatusLine, type StatusLineOptions } from "./helpers.js";

// ---------------------------------------------------------------------------
// Menu labels (exported for tests)
// ---------------------------------------------------------------------------

export const MENU_TITLE = "Recap settings";
export const ITEM_EDIT_IDLE_PREFIX = "Edit idle timeout:";
export const ITEM_CLOSE = "Close";
export const SEPARATOR = "─".repeat(20);
/** Minimum accepted idle timeout, mirroring `idleSeconds()` in `index.ts`. */
export const MIN_IDLE_SECONDS = 5;

// ---------------------------------------------------------------------------
// Surfaces / dependencies (kept minimal for testability)
// ---------------------------------------------------------------------------

interface MenuUI {
	select?: (title: string, items: string[]) => Promise<string | null | undefined>;
	input?: (prompt: string, defaultValue?: string) => Promise<string | null | undefined>;
	notify?: (msg: string, level?: "info" | "warning" | "error") => void;
}

interface MenuCtx {
	hasUI?: boolean;
	ui?: MenuUI;
}

export interface RecapSettingsMenuDeps {
	/** Current effective idle timeout in seconds (override OR flag fallback). */
	idleSeconds: () => number;
	/** Apply a session-scoped idle override (no persistence). */
	setIdleOverride: (value: number) => void;
	/** Resolve the same `StatusLineOptions` used by the chat-scroll status. */
	resolveStatusOptions: () => StatusLineOptions;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Open the `/recap-settings` menu and loop until the user picks `Close`
 * (or `select` returns null/undefined, treated as cancel).
 */
export async function runRecapSettingsCommand(
	ctx: unknown,
	deps: RecapSettingsMenuDeps,
): Promise<void> {
	const menuCtx = ctx as MenuCtx;
	const select = menuCtx?.ui?.select;
	const notify = menuCtx?.ui?.notify;
	if (!menuCtx?.hasUI || !select) {
		notify?.("recap-settings: requires an interactive UI.", "warning");
		return;
	}

	while (true) {
		const items = buildMenuItems(deps);
		const choice = await select(MENU_TITLE, items);
		if (!choice || choice === ITEM_CLOSE) return;

		if (choice.startsWith(ITEM_EDIT_IDLE_PREFIX)) {
			await editIdleTimeout(menuCtx, deps);
			continue;
		}
		// Read-only / separator rows: no-op, just redraw.
	}
}

/**
 * Build the ordered list of menu items: every `buildStatusLine` row except
 * the `recap status` header, then a separator, then the editable
 * idle-timeout row, then `Close`.
 *
 * Exported for tests so we can assert structure without running `select`.
 */
export function buildMenuItems(deps: RecapSettingsMenuDeps): string[] {
	const status = buildStatusLine(deps.resolveStatusOptions()).split("\n");
	// Drop the "recap status" header line — it's the menu title now.
	const statusRows = status.slice(1).map((row) => row.replace(/^\s+/, ""));

	return [
		...statusRows,
		SEPARATOR,
		`${ITEM_EDIT_IDLE_PREFIX} ${deps.idleSeconds()}s`,
		ITEM_CLOSE,
	];
}

// ---------------------------------------------------------------------------
// Edit handlers
// ---------------------------------------------------------------------------

async function editIdleTimeout(menuCtx: MenuCtx, deps: RecapSettingsMenuDeps): Promise<void> {
	const input = menuCtx.ui?.input;
	const notify = menuCtx.ui?.notify;
	if (!input) {
		notify?.(
			"recap-settings: text input is unavailable in this terminal; cannot edit idle timeout.",
			"warning",
		);
		return;
	}
	const current = deps.idleSeconds();
	const raw = await input(
		`Idle timeout in seconds (min ${MIN_IDLE_SECONDS}):`,
		String(current),
	);
	if (raw == null) return; // user cancelled
	const trimmed = raw.trim();
	if (trimmed === "") return;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed) || parsed < MIN_IDLE_SECONDS) {
		notify?.(
			`recap-settings: invalid idle timeout "${trimmed}" — must be a number ≥ ${MIN_IDLE_SECONDS}.`,
			"warning",
		);
		return;
	}
	const next = Math.floor(parsed);
	deps.setIdleOverride(next);
	notify?.(
		`recap-settings: idle timeout → ${next}s (this session only).`,
		"info",
	);
}
