/**
 * Pure key-dispatch for the ask_user_question dialog.
 *
 * The live TUI shell (`dialog.ts`) forwards every keystroke here and
 * interprets the returned {@link KeyAction}. Extracting the routing table
 * keeps the order-sensitive priorities (input mode > submit tab > regular
 * tab > tab-switching > up/down > n > space > enter > escape) under test
 * without requiring a live pi-tui runtime.
 *
 * Priority order (see `dispatchKey` body for the exact branches):
 *   1. Any active input mode swallows everything; Esc closes the editor,
 *      every other byte is passed through to the Editor component.
 *   2. On the Submit/review tab, only Tab/Shift-Tab/←/→/Enter/Esc do
 *      anything; other keys are ignored.
 *   3. On a regular question tab:
 *        - Tab / Shift-Tab / ← / → switch tabs *only* when there is more
 *          than one question.
 *        - ↑ / ↓ move the row cursor.
 *        - "n" requests a note on the current row (the shell calls
 *          `ctrl.beginNote()` and falls back to ignore on failure — since
 *          no later case matches the byte "n", "begin-note" is safe to
 *          return unconditionally).
 *        - Space toggles the current option when the question is
 *          multi-select.
 *        - Enter / Esc map to the controller's primary / cancel actions.
 *
 * No imports from `@earendil-works/pi-tui` are allowed here.
 */

import type { DialogState } from "./controller.js";
import type { TQuestion } from "./schema.js";

/** Identifier for a named key; resolved against raw stdin data by {@link KeyProbe.matches}. */
export type KeyId =
	| "tab"
	| "shift-tab"
	| "left"
	| "right"
	| "up"
	| "down"
	| "enter"
	| "escape"
	| "space";

/**
 * Thin abstraction over pi-tui's `matchesKey`. Keeping the real Key constants
 * out of this module lets the unit tests use a string map instead of booting
 * the pi-tui runtime.
 */
export interface KeyProbe {
	matches: (data: string, keyId: KeyId) => boolean;
}

/**
 * Discriminated union of every action the input router can request. The
 * shell is responsible for translating these into controller calls, editor
 * updates, and `done()` plumbing.
 */
export type KeyAction =
	| { kind: "cancel-input" }
	| { kind: "editor-input"; data: string }
	| { kind: "next-tab" }
	| { kind: "prev-tab" }
	| { kind: "move-up" }
	| { kind: "move-down" }
	| { kind: "begin-note" }
	| { kind: "toggle-current" }
	| { kind: "enter" }
	| { kind: "cancel" }
	| { kind: "ignore" };

function isTabSwitchForward(data: string, keys: KeyProbe): boolean {
	return keys.matches(data, "tab") || keys.matches(data, "right");
}

function isTabSwitchBack(data: string, keys: KeyProbe): boolean {
	return keys.matches(data, "shift-tab") || keys.matches(data, "left");
}

/**
 * Classify a keystroke into a {@link KeyAction}.
 *
 * Pure: depends only on the supplied state, question list, raw byte data
 * and key probe. Safe to call from tests without a pi-tui runtime.
 */
export function dispatchKey(
	state: DialogState,
	questions: TQuestion[],
	data: string,
	keys: KeyProbe,
): KeyAction {
	// 1. Input mode intercept.
	if (state.inputMode !== "none") {
		if (keys.matches(data, "escape")) return { kind: "cancel-input" };
		return { kind: "editor-input", data };
	}

	const isSubmit = state.currentTab === questions.length;

	// 2. Submit tab.
	if (isSubmit) {
		if (isTabSwitchForward(data, keys)) return { kind: "next-tab" };
		if (isTabSwitchBack(data, keys)) return { kind: "prev-tab" };
		if (keys.matches(data, "enter")) return { kind: "enter" };
		if (keys.matches(data, "escape")) return { kind: "cancel" };
		return { kind: "ignore" };
	}

	// 3. Regular question tab.
	if (questions.length > 1) {
		if (isTabSwitchForward(data, keys)) return { kind: "next-tab" };
		if (isTabSwitchBack(data, keys)) return { kind: "prev-tab" };
	}

	if (keys.matches(data, "up")) return { kind: "move-up" };
	if (keys.matches(data, "down")) return { kind: "move-down" };

	if (data === "n") return { kind: "begin-note" };

	const q = questions[state.currentTab];
	const isMulti = q?.multiSelect === true;
	if (isMulti && keys.matches(data, "space")) return { kind: "toggle-current" };

	if (keys.matches(data, "enter")) return { kind: "enter" };
	if (keys.matches(data, "escape")) return { kind: "cancel" };

	return { kind: "ignore" };
}
