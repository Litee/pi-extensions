/**
 * Pure key-dispatch helpers for the `/local-issue-watcher browse`
 * TUI. Extracted from `infoTui.ts` (which is excluded from coverage
 * as a live-TUI shell) so the state-machine transitions are testable
 * in isolation. See review §3.8.
 */

/** Key identifiers this module will ask `matchesKey` about. */
export type InfoTuiKeyId = "escape" | "ctrl+c" | "left";

/**
 * Discriminated union describing how the `infoTui` shell should
 * respond to a single keystroke. The shell maps these actions onto
 * concrete `SelectList` / `Input` / `done(undefined)` calls.
 */
export type InfoTuiAction =
	| { kind: "quit" }
	| { kind: "back-to-list" }
	| { kind: "list-nav" }
	| { kind: "filter-input" }
	| { kind: "ignore" };

/**
 * True iff `data` is a key the `SelectList` owns in list mode:
 * CSI arrow / Home / End / PageUp / PageDown, or Enter (CR/LF).
 * Deliberately does NOT include plain Esc — Esc is a quit/back signal.
 */
export function isListNavKey(data: string): boolean {
	if (data.startsWith("\u001b[")) return true;
	if (data === "\r" || data === "\n") return true;
	return false;
}

/**
 * Resolve a keystroke against the current mode.
 *
 *   list mode:
 *     - Ctrl-C                   → quit
 *     - Esc                      → quit
 *     - CSI arrows / Home/End /  → list-nav
 *       PageUp/PageDown / Enter
 *     - anything else            → filter-input
 *
 *   detail mode:
 *     - Ctrl-C                   → quit (emergency exit, #0026)
 *     - Esc or Left              → back-to-list
 *     - anything else            → ignore (read-only preview)
 *
 * `matchesKey` is injected so we can reuse `@mariozechner/pi-tui`'s
 * implementation in production while keeping this module free of
 * TUI imports for testability.
 */
export function dispatchKey(
	mode: "list" | "detail",
	data: string,
	matchesKey: (data: string, keyId: InfoTuiKeyId) => boolean,
): InfoTuiAction {
	// #0026: Ctrl-C is an unconditional emergency exit in both modes.
	if (matchesKey(data, "ctrl+c")) return { kind: "quit" };

	if (mode === "detail") {
		if (matchesKey(data, "escape") || matchesKey(data, "left")) {
			return { kind: "back-to-list" };
		}
		return { kind: "ignore" };
	}

	// mode === "list"
	if (matchesKey(data, "escape")) return { kind: "quit" };
	if (isListNavKey(data)) return { kind: "list-nav" };
	return { kind: "filter-input" };
}
