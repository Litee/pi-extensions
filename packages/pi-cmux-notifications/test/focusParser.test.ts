/**
 * Unit tests for `feedFocusBytes` — the pure ESC-sequence scanner used by
 * pi-cmux-notifications to detect DECSET ?1004 focus-in / focus-out events
 * in binary stdin chunks.
 *
 * We exercise three dimensions:
 *   - straddled reads (chunk boundary lands mid-sequence),
 *   - malformed / unrelated bytes mixed with real sequences,
 *   - interleaved focus-in / focus-out in a single chunk.
 */

import { describe, expect, it } from "vitest";

import { feedFocusBytes } from "../src/focusParser.js";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

describe("feedFocusBytes", () => {
	it("returns empty events for an empty chunk", () => {
		const { events, rest } = feedFocusBytes("", "");
		expect(events).toEqual([]);
		expect(rest).toBe("");
	});

	it("emits a single focus-in event for a complete ESC[I", () => {
		const { events, rest } = feedFocusBytes("", FOCUS_IN);
		expect(events).toEqual(["in"]);
		expect(rest).toBe("");
	});

	it("emits a single focus-out event for a complete ESC[O", () => {
		const { events, rest } = feedFocusBytes("", FOCUS_OUT);
		expect(events).toEqual(["out"]);
		expect(rest).toBe("");
	});

	it("handles interleaved focus-in and focus-out sequences in one chunk", () => {
		const { events, rest } = feedFocusBytes("", FOCUS_OUT + FOCUS_IN + FOCUS_OUT);
		expect(events).toEqual(["out", "in", "out"]);
		expect(rest).toBe("");
	});

	it("stashes a trailing partial ESC prefix in `rest` (straddled read)", () => {
		// Chunk ends mid-sequence: ESC + [ (2 bytes, need 3).
		const first = feedFocusBytes("", FOCUS_OUT + "\x1b[");
		expect(first.events).toEqual(["out"]);
		expect(first.rest).toBe("\x1b[");

		// Next chunk completes the sequence.
		const second = feedFocusBytes(first.rest, "I");
		expect(second.events).toEqual(["in"]);
		expect(second.rest).toBe("");
	});

	it("handles a sequence split exactly at the ESC boundary across two reads", () => {
		const first = feedFocusBytes("", "\x1b");
		expect(first.events).toEqual([]);
		// `rest` must retain the lone ESC so the next read can complete it.
		expect(first.rest).toBe("\x1b");

		const second = feedFocusBytes(first.rest, "[O");
		expect(second.events).toEqual(["out"]);
		expect(second.rest).toBe("");
	});

	it("ignores unrelated bytes surrounding valid sequences", () => {
		const { events } = feedFocusBytes("", "abc" + FOCUS_IN + "xyz" + FOCUS_OUT + "q");
		expect(events).toEqual(["in", "out"]);
	});

	it("does not misfire on a malformed ESC[X sequence", () => {
		const { events, rest } = feedFocusBytes("", "\x1b[X" + FOCUS_IN);
		expect(events).toEqual(["in"]);
		expect(rest).toBe("");
	});

	it("never fires the same completed sequence twice across repeated calls", () => {
		const first = feedFocusBytes("", FOCUS_IN);
		expect(first.events).toEqual(["in"]);
		const second = feedFocusBytes(first.rest, "");
		expect(second.events).toEqual([]);
	});

	it("bounds the carried-over `rest` so a runaway non-ESC stream cannot grow unbounded", () => {
		// 200 bytes of unrelated input with no ESC — rest must stay tiny.
		const junk = "x".repeat(200);
		const { events, rest } = feedFocusBytes("", junk);
		expect(events).toEqual([]);
		// Conservative upper bound: well under the 64-byte safety cap.
		expect(rest.length).toBeLessThanOrEqual(4);
	});
});
