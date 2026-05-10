import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BashRenderState } from "../src/renderers.js";
import { tickBashTimer } from "../src/renderers.js";

describe("tickBashTimer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a Running label with no duration when startedAt is not set", () => {
		const state: BashRenderState = {};
		const tick = tickBashTimer(state, Date.now(), /*isPartial*/ true, /*isError*/ false);
		expect(tick).toEqual({ label: "Running", clearTimer: false });
		// State is untouched while still partial.
		expect(state.endedAt).toBeUndefined();
	});

	it("appends the formatted elapsed time when startedAt is set", () => {
		const now = Date.now();
		const state: BashRenderState = { startedAt: now };
		vi.advanceTimersByTime(2500);
		const tick = tickBashTimer(state, Date.now(), true, false);
		expect(tick.label).toBe("Running · 2.5s");
		expect(tick.clearTimer).toBe(false);
	});

	it("ticks upward as time advances across repeated calls", () => {
		const started = Date.now();
		const state: BashRenderState = { startedAt: started };
		const labels: string[] = [];
		for (const advance of [1000, 2000, 5000]) {
			vi.setSystemTime(started + advance);
			labels.push(tickBashTimer(state, Date.now(), true, false).label);
		}
		expect(labels).toEqual(["Running · 1.0s", "Running · 2.0s", "Running · 5.0s"]);
		expect(state.endedAt).toBeUndefined();
	});

	it("freezes endedAt exactly once on completion and asks to clear the timer", () => {
		const started = Date.now();
		const state: BashRenderState = { startedAt: started };
		vi.advanceTimersByTime(1500);
		const completedAt = Date.now();

		const first = tickBashTimer(state, completedAt, /*isPartial*/ false, /*isError*/ false);
		expect(first).toEqual({ label: "", clearTimer: true });
		expect(state.endedAt).toBe(completedAt);

		// A second final-render pass must not move endedAt.
		vi.advanceTimersByTime(5000);
		const second = tickBashTimer(state, Date.now(), false, false);
		expect(second.clearTimer).toBe(true);
		expect(state.endedAt).toBe(completedAt);
	});

	it("treats isError=true as completion even while isPartial is still true", () => {
		const started = Date.now();
		const state: BashRenderState = { startedAt: started };
		vi.advanceTimersByTime(700);
		const now = Date.now();

		const tick = tickBashTimer(state, now, /*isPartial*/ true, /*isError*/ true);
		expect(tick.clearTimer).toBe(true);
		expect(tick.label).toBe("");
		expect(state.endedAt).toBe(now);
	});
});
