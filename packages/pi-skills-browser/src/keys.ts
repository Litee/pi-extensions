import type { KeyId } from "@earendil-works/pi-tui";

/**
 * Pure keypress dispatcher for the skills browser.
 *
 * Extracted from `index.ts` so the branching table (up/down/toggle-sort/
 * backspace/printable-character) can be unit-tested without driving a live
 * TUI. Escape / quit is handled by the caller *before* invoking this
 * dispatcher (it terminates the overlay via `done()`), so it is intentionally
 * NOT part of this action union.
 */

/** The set of state mutations the dispatcher can request. */
export type SkillsBrowserAction =
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "toggle-sort" }
	| { kind: "backspace" }
	| { kind: "filter-char"; char: string }
	| { kind: "ignore" };

/** Injectable matcher with the same shape as pi-tui's `matchesKey`. */
export type MatchesKey = (data: string, keyId: KeyId) => boolean;

/**
 * Classify a raw stdin chunk into a `SkillsBrowserAction`.
 *
 * Order matters: `s` is checked as a navigation key BEFORE the printable
 * filter-character branch so typing "s" toggles the sort mode instead of
 * being swallowed into the filter query.
 */
export function dispatchKey(
	data: string,
	matchesKey: MatchesKey,
): SkillsBrowserAction {
	if (matchesKey(data, "up")) return { kind: "up" };
	if (matchesKey(data, "down")) return { kind: "down" };
	// "Ctrl-S" toggles sort mode — bare "s" falls through to filter-char.
	if (matchesKey(data, "ctrl+s")) return { kind: "toggle-sort" };
	// Backspace / Delete → remove last filter character.
	if (matchesKey(data, "backspace") || matchesKey(data, "delete"))
		return { kind: "backspace" };
	// Printable ASCII (excluding keys already handled above) → extend filter.
	if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127)
		return { kind: "filter-char", char: data };
	return { kind: "ignore" };
}
