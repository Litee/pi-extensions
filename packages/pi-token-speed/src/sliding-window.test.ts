import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { SlidingWindow } from "./sliding-window.js";

describe("SlidingWindow", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns 0 when empty", () => {
		const sw = new SlidingWindow(1000);
		expect(sw.getTps(1_000_000)).toBe(0);
	});

	it("records tokens and returns non-zero TPS", () => {
		const sw = new SlidingWindow(1000);
		sw.record(10);
		vi.setSystemTime(1_000_500);
		sw.record(10);
		const tps = sw.getTps(1_000_500);
		expect(tps).toBeGreaterThan(0);
	});

	it("excludes events older than the window", () => {
		const sw = new SlidingWindow(1000);
		sw.record(100);
		vi.setSystemTime(2_000_000); // 1s later
		sw.record(10);
		const tps = sw.getTps(2_000_000);
		// Only the last 10 tokens should be in the window
		// The time span is 0ms (same instant), clamped to MIN_SLIDING_WINDOW (100ms)
		// So TPS = 10 * 1000 / 100 = 100
		expect(tps).toBe(100);
	});

	it("resets discards all events", () => {
		const sw = new SlidingWindow(1000);
		sw.record(50);
		sw.reset();
		expect(sw.getTps(1_000_000)).toBe(0);
	});

	it("uses minimum span to avoid burst spikes", () => {
		const sw = new SlidingWindow(1000);
		sw.record(10);
		// Record at the same timestamp
		const tps = sw.getTps(1_000_000);
		// Should use MIN_SLIDING_WINDOW (100ms) as span, not 0
		expect(tps).toBe(10 * 1000 / 100); // 100 tps
	});

	it("compacts when index reaches threshold", () => {
		const sw = new SlidingWindow(1000);
		// COMPACTION_THRESHOLD = 5000
		// Record events at 2ms intervals, then call getTps far enough ahead
		// that all recorded events are outside the window
		for (let i = 0; i < 5000; i++) {
			sw.record(1);
			vi.setSystemTime(1_000_000 + i * 2);
		}
		// Now call getTps at time 2_000_000 (1s later)
		// windowStart = 2_000_000 - 1000 = 1_999_000
		// Events at times 1_000_000 to 1_009_998 are all < 1_999_000
		// So windowStartIndex advances to 5000
		sw.getTps(2_000_000);
		// Access private field via unknown first, then bracket notation
		const obj = sw as unknown as Record<string, unknown>;
		const windowStartIndex = obj["windowStartIndex"] as number;
		expect(windowStartIndex).toBe(5000);

		// Next record triggers compaction
		sw.record(1);
		const events = obj["events"] as { time: number; tokens: number }[];
		expect(events.length).toBe(1);
	});

	it("handles very large window values", () => {
		const sw = new SlidingWindow(30_000);
		sw.record(100);
		expect(sw.getTps(1_000_000)).toBeGreaterThan(0);
	});

	it("handles zero tokens gracefully", () => {
		const sw = new SlidingWindow(1000);
		sw.record(0);
		expect(sw.getTps(1_000_000)).toBe(0);
	});

	it("returns correct TPS for steady stream", () => {
		const sw = new SlidingWindow(1000);
		for (let i = 0; i < 100; i++) {
			sw.record(1);
			vi.setSystemTime(1_000_000 + i * 10);
		}
		const tps = sw.getTps(1_001_000);
		expect(tps).toBeCloseTo(100, 0);
	});
});
