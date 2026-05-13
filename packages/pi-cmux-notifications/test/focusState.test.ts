/**
 * Unit tests for the pure focus state machine.
 *
 * These tests pin the regression: focus-in events that arrive without a
 * preceding focus-out (the kind terminals emit spuriously when a prompt
 * regains the cursor) must NOT clear the pending red circle. Only a
 * genuine "user left the pane and came back" sequence should.
 */

import { describe, expect, it } from "vitest";

import { applyFocusEvent, type FocusState } from "../src/focusState.js";

const initial: FocusState = { hasPendingDot: false, focusedAway: false };

describe("applyFocusEvent", () => {
	it("focus-out flips focusedAway=true without side effect", () => {
		const r = applyFocusEvent(initial, "out");
		expect(r.transitionToIdle).toBe(false);
		expect(r.nextState).toEqual({ hasPendingDot: false, focusedAway: true });
	});

	it("a focus-in WITHOUT a preceding focus-out is ignored even if the dot is pending", () => {
		// Regression: this is the case that previously masked the red circle.
		// agent_end set hasPendingDot=true, then the terminal redrew the prompt
		// and emitted a spurious focus-in, which used to instantly clear back
		// to idle. The fix requires focusedAway=true to take that path.
		const state: FocusState = { hasPendingDot: true, focusedAway: false };
		const r = applyFocusEvent(state, "in");
		expect(r.transitionToIdle).toBe(false);
		expect(r.nextState.hasPendingDot).toBe(true);
		expect(r.nextState.focusedAway).toBe(false);
	});

	it("focus-in AFTER a focus-out clears the pending dot when one is set", () => {
		const state: FocusState = { hasPendingDot: true, focusedAway: true };
		const r = applyFocusEvent(state, "in");
		expect(r.transitionToIdle).toBe(true);
		expect(r.nextState).toEqual({ hasPendingDot: false, focusedAway: false });
	});

	it("focus-in after a focus-out with NO pending dot just resets focusedAway", () => {
		// User tabs away and back during agent thinking time. No pending
		// dot to clear; we just reset focusedAway so the *next* legitimate
		// out/in pair behaves correctly.
		const state: FocusState = { hasPendingDot: false, focusedAway: true };
		const r = applyFocusEvent(state, "in");
		expect(r.transitionToIdle).toBe(false);
		expect(r.nextState).toEqual({ hasPendingDot: false, focusedAway: false });
	});

	it("a stream of spurious focus-ins never clears a pending dot", () => {
		let s: FocusState = { hasPendingDot: true, focusedAway: false };
		for (let i = 0; i < 5; i++) {
			const r = applyFocusEvent(s, "in");
			expect(r.transitionToIdle).toBe(false);
			s = r.nextState;
		}
		expect(s.hasPendingDot).toBe(true);
	});

	it("out → in → out → in → done sequence: only the final in (after agent_end set the dot) clears", () => {
		// Simulate: user tabs away (out), comes back (in), tabs away again (out),
		// while still in 'working' state (no dot). Then agent_end fires (caller
		// flips hasPendingDot to true). Finally user returns (in) — this MUST
		// clear to idle.
		let s: FocusState = { hasPendingDot: false, focusedAway: false };
		s = applyFocusEvent(s, "out").nextState;
		s = applyFocusEvent(s, "in").nextState;
		s = applyFocusEvent(s, "out").nextState;
		// Caller (agent_end handler) sets the dot:
		s = { ...s, hasPendingDot: true };
		const r = applyFocusEvent(s, "in");
		expect(r.transitionToIdle).toBe(true);
		expect(r.nextState).toEqual({ hasPendingDot: false, focusedAway: false });
	});
});
