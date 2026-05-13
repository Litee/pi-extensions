/**
 * Pure state machine for translating DECSET ?1004 focus events into
 * sidebar-pill transitions.
 *
 * Background: the original implementation cleared the red `done` dot to
 * green `idle` on every focus-in event. In practice, terminals (and
 * cmux itself) commonly emit a focus-in sequence whenever the active
 * pane's child process returns to its prompt, which fired *immediately*
 * after `agent_end` and silently masked the red circle. The bolt
 * `working` icon was hidden by the same race when turns were short.
 *
 * The fix: only treat focus-in as "user returned to the pane" when we
 * previously observed a focus-out. If the pane never lost focus, an
 * incoming focus-in is spurious and must be ignored. This matches the
 * README's stated UX: the red circle is the persistent "response ready"
 * marker until the user either tabs away+back or types a new message.
 *
 * Kept pure (no I/O, no module state) so the index.ts wiring stays
 * trivial and the transitions are exhaustively unit-tested.
 */

import type { FocusEvent } from "./focusParser.js";

export interface FocusState {
	/** True between `agent_end` and the next user input or focus-in clear. */
	hasPendingDot: boolean;
	/**
	 * True once a focus-out has been observed and not yet matched by a
	 * focus-in. Acts as a guard so spurious focus-in events (the kind a
	 * terminal emits when the prompt regains the cursor) do not clear
	 * the pending dot.
	 */
	focusedAway: boolean;
}

export interface FocusTransition {
	/** Next state to assign back to the runtime. */
	nextState: FocusState;
	/** Side effect: caller should flip the pill to `idle` (green check). */
	transitionToIdle: boolean;
}

/**
 * Apply a single focus event to the state machine. Pure: no I/O, no
 * side effects beyond returning the next state + a boolean signalling
 * whether the caller should issue a `set-status idle` call.
 */
export function applyFocusEvent(
	state: FocusState,
	ev: FocusEvent,
): FocusTransition {
	if (ev === "out") {
		return {
			nextState: { ...state, focusedAway: true },
			transitionToIdle: false,
		};
	}
	// ev === "in"
	if (state.focusedAway && state.hasPendingDot) {
		return {
			nextState: { hasPendingDot: false, focusedAway: false },
			transitionToIdle: true,
		};
	}
	// Spurious focus-in (no preceding focus-out) — clear the focusedAway
	// flag if it was set, but leave the pending dot intact.
	return {
		nextState: { ...state, focusedAway: false },
		transitionToIdle: false,
	};
}
