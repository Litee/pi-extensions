/**
 * Pure state machine + key dispatcher for the `/sandbox-workflow` TUI.
 *
 * Four-screen flow:
 *
 *   menu (Browse / Close)            list (workflows)
 *   ────────────────────────         ──────────────────────────────
 *   Browse  ─ activate ────────────▶  ── back ──▶ menu
 *                                    ── r ──────▶ runs (for highlighted wf)
 *   Close   ─ activate ───┐          ── close ──▶ exit
 *   back    (Esc)         ├── close ──▶ exit
 *   close   (Ctrl+C)      ┘
 *
 *   runs (past runs for one workflow)     run-detail (events of one run)
 *   ─────────────────────────────────     ─────────────────────────────
 *   ↑/↓ navigate list                     ↑/↓ scroll event list
 *   enter → run-detail                    back → runs
 *   back → list
 *
 * The pi-tui shell lives in `index.ts` (where `ctx.ui.custom` is
 * available). Everything testable — key dispatch, navigation clamping,
 * row formatting — lives here so unit tests don't need a live TUI.
 */
import type { KeyId } from "@earendil-works/pi-tui";
import { homedir as osHomedir } from "node:os";

import type { WorkflowScript } from "./discovery.js";

/** Outcome of a single keypress. */
export type BrowseAction =
	| { readonly kind: "up" }
	| { readonly kind: "down" }
	| { readonly kind: "activate" }
	| { readonly kind: "back" }
	| { readonly kind: "close" }
	| { readonly kind: "runs" }
	| { readonly kind: "ignore" };

/**
 * Subset of `matchesKey(data, keyId)` from `@earendil-works/pi-tui`.
 * Mirrors the real signature so the production `matchesKey` is
 * assignable here without a cast.
 */
export type MatchesKey = (data: string, keyId: KeyId) => boolean;

/** Top-level menu items, in display order. */
export const MENU_ITEMS = ["Browse", "Close"] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

export type Screen = "menu" | "list" | "runs" | "run-detail";

export interface BrowseState {
	readonly screen: Screen;
	/** 0..MENU_ITEMS.length-1. Persisted across screen switches so a
	 *  back-from-list lands on whatever menu item the user had selected. */
	readonly menuIndex: number;
	/** 0..workflows.length-1. */
	readonly listIndex: number;
	/** 0..runs.length-1 (runs screen). */
	readonly runsIndex: number;
	/** Scroll offset in the flat agent-event list (run-detail screen). */
	readonly runDetailIndex: number;
}

export const initialBrowseState: BrowseState = {
	screen: "menu",
	menuIndex: 0,
	listIndex: 0,
	runsIndex: 0,
	runDetailIndex: 0,
};

/** Effect requested by the reducer after applying an action. */
export type BrowseEffect =
	| { readonly kind: "render" }
	| { readonly kind: "close" };

export interface BrowseStep {
	readonly state: BrowseState;
	readonly effect: BrowseEffect;
}

/**
 * Map a raw stdin chunk to a {@link BrowseAction}. Defers to pi-tui's
 * `matchesKey` for the legacy/Kitty key-encoding details so tests can
 * stub it.
 *
 *   Esc    → back   (soft cancel; on root menu becomes `close` via reducer)
 *   Ctrl+C → close  (hard abort, always exits)
 *   Enter  → activate
 *   ↑/↓    → up/down
 *   r      → runs   (open run history for the highlighted workflow)
 */
export function dispatchBrowseKey(
	data: string,
	matchesKey: MatchesKey,
): BrowseAction {
	if (matchesKey(data, "ctrl+c")) return { kind: "close" };
	if (matchesKey(data, "escape")) return { kind: "back" };
	if (matchesKey(data, "enter")) return { kind: "activate" };
	if (matchesKey(data, "up")) return { kind: "up" };
	if (matchesKey(data, "down")) return { kind: "down" };
	if (matchesKey(data, "r")) return { kind: "runs" };
	return { kind: "ignore" };
}

/**
 * Apply a {@link BrowseAction} to the current {@link BrowseState} and
 * return the new state plus a render/close effect for the shell to act
 * on. Pure — no I/O, no `process.exit`. The shell calls
 * `tui.requestRender()` on `render` and `done(undefined)` on `close`.
 *
 * @param runsLength - Number of runs for the highlighted workflow.
 *   Only relevant when `state.screen === "runs"`; pass 0 or omit otherwise.
 */
export function reduceBrowse(
	state: BrowseState,
	action: BrowseAction,
	listLength: number,
	runsLength = 0,
): BrowseStep {
	if (action.kind === "ignore") {
		return { state, effect: { kind: "render" } };
	}
	if (action.kind === "close") {
		// Ctrl+C exits regardless of which screen the user is on.
		return { state, effect: { kind: "close" } };
	}

	if (state.screen === "runs") {
		switch (action.kind) {
			case "up":
				return {
					state: {
						...state,
						runsIndex:
							runsLength === 0 ? 0 : Math.max(0, state.runsIndex - 1),
					},
					effect: { kind: "render" },
				};
			case "down":
				return {
					state: {
						...state,
						runsIndex:
							runsLength === 0
								? 0
								: Math.min(runsLength - 1, state.runsIndex + 1),
					},
					effect: { kind: "render" },
				};
			case "activate":
				return {
					state: { ...state, screen: "run-detail", runDetailIndex: 0 },
					effect: { kind: "render" },
				};
			case "back":
				return {
					state: { ...state, screen: "list" },
					effect: { kind: "render" },
				};
			case "runs":
				// Already on runs screen — no-op.
				return { state, effect: { kind: "render" } };
		}
	}

	if (state.screen === "run-detail") {
		switch (action.kind) {
			case "up":
				return {
					state: {
						...state,
						runDetailIndex: Math.max(0, state.runDetailIndex - 1),
					},
					effect: { kind: "render" },
				};
			case "down":
				return {
					state: { ...state, runDetailIndex: state.runDetailIndex + 1 },
					effect: { kind: "render" },
				};
			case "back":
				return {
					state: { ...state, screen: "runs" },
					effect: { kind: "render" },
				};
			case "activate":
			case "runs":
				return { state, effect: { kind: "render" } };
		}
	}

	if (state.screen === "menu") {
		switch (action.kind) {
			case "up":
				return {
					state: { ...state, menuIndex: Math.max(0, state.menuIndex - 1) },
					effect: { kind: "render" },
				};
			case "down":
				return {
					state: {
						...state,
						menuIndex: Math.min(MENU_ITEMS.length - 1, state.menuIndex + 1),
					},
					effect: { kind: "render" },
				};
			case "activate": {
				const item = MENU_ITEMS[state.menuIndex];
				if (item === "Browse") {
					return {
						state: { ...state, screen: "list", listIndex: 0 },
						effect: { kind: "render" },
					};
				}
				// "Close" menu item also exits.
				return { state, effect: { kind: "close" } };
			}
			case "back":
				// Menu IS the root — Esc exits.
				return { state, effect: { kind: "close" } };
			case "runs":
				// 'r' has no meaning from the menu.
				return { state, effect: { kind: "render" } };
		}
	}

	// state.screen === "list"
	switch (action.kind) {
		case "up":
			return {
				state: {
					...state,
					listIndex:
						listLength === 0 ? 0 : Math.max(0, state.listIndex - 1),
				},
				effect: { kind: "render" },
			};
		case "down":
			return {
				state: {
					...state,
					listIndex:
						listLength === 0
							? 0
							: Math.min(listLength - 1, state.listIndex + 1),
				},
				effect: { kind: "render" },
			};
		case "back":
			// Soft back: return to the menu, preserving menuIndex.
			return {
				state: { ...state, screen: "menu" },
				effect: { kind: "render" },
			};
		case "activate":
			// No per-row action yet (could later open in editor, show full
			// path, etc.). Render so the cached frame refreshes.
			return { state, effect: { kind: "render" } };
		case "runs":
			// 'r' from list: open the runs browser for the highlighted workflow.
			return {
				state: { ...state, screen: "runs", runsIndex: 0 },
				effect: { kind: "render" },
			};
	}
}

/**
 * Replace the user's home dir at the start of an absolute path with `~`
 * for compact display. If `p` does not start with `home`, returns `p`
 * unchanged.
 */
export function tildify(p: string, home: string = osHomedir()): string {
	if (p === home) return "~";
	const prefix = home.endsWith("/") ? home : `${home}/`;
	if (p.startsWith(prefix)) return `~/${p.slice(prefix.length)}`;
	return p;
}

export interface RowParts {
	readonly cursor: string;
	readonly name: string;
	readonly file: string;
	readonly source: string;
}

/**
 * Compose the four columns we render per workflow row. Pure (no theme,
 * no truncation) so tests can assert on content without parsing ANSI.
 */
export function buildRowParts(
	script: WorkflowScript,
	selected: boolean,
	home: string = osHomedir(),
): RowParts {
	const file = script.path.split("/").slice(-1)[0] ?? script.path;
	return {
		cursor: selected ? "\u203a" : " ",
		name: script.name,
		file,
		source: tildify(script.sourceDir, home),
	};
}
