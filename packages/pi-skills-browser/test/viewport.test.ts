import { describe, expect, it } from "vitest";

import { computeScrollPercent, computeWindow } from "../src/viewport.js";

// ---------------------------------------------------------------------------
// computeScrollPercent
// ---------------------------------------------------------------------------

describe("computeScrollPercent", () => {
	it("returns null when len is 0 (empty list, no scroll)", () => {
		expect(computeScrollPercent(0, 0)).toBeNull();
	});

	it("returns null when len is 1 — MUST NOT divide by zero or produce NaN", () => {
		// Regression: prior implementation computed `selectedIndex / (len - 1)`
		// which evaluated to 0/0 = NaN, then Math.round(NaN) = NaN.
		const result = computeScrollPercent(0, 1);
		expect(result).toBeNull();
		expect(Number.isNaN(result as unknown as number)).toBe(false);
	});

	it("returns 0 when at the top of a multi-item list", () => {
		expect(computeScrollPercent(0, 2)).toBe(0);
		expect(computeScrollPercent(0, 100)).toBe(0);
	});

	it("returns 100 when at the bottom", () => {
		expect(computeScrollPercent(1, 2)).toBe(100);
		expect(computeScrollPercent(99, 100)).toBe(100);
	});

	it("returns 50 when at the middle", () => {
		expect(computeScrollPercent(1, 3)).toBe(50);
	});

	it("rounds to the nearest integer", () => {
		// selectedIndex=1, len=4 → 1/3 = 0.333 → 33
		expect(computeScrollPercent(1, 4)).toBe(33);
	});
});

// ---------------------------------------------------------------------------
// computeWindow
// ---------------------------------------------------------------------------

describe("computeWindow", () => {
	it("returns {start:0, end:0} for an empty list", () => {
		expect(computeWindow(0, 0, 15)).toEqual({ start: 0, end: 0 });
	});

	it("returns the full range when len <= maxVisible", () => {
		expect(computeWindow(0, 5, 15)).toEqual({ start: 0, end: 5 });
		expect(computeWindow(4, 5, 15)).toEqual({ start: 0, end: 5 });
	});

	it("keeps the selected index roughly centred in the viewport", () => {
		// maxVisible=10, so floor(10/2) = 5. selectedIndex=20, len=100
		// start = max(0, min(20-5, 100-10)) = max(0, min(15, 90)) = 15
		const { start, end } = computeWindow(20, 100, 10);
		expect(start).toBe(15);
		expect(end).toBe(25);
	});

	it("clamps to start=0 when selected is near the top", () => {
		expect(computeWindow(0, 100, 15)).toEqual({ start: 0, end: 15 });
		expect(computeWindow(3, 100, 15)).toEqual({ start: 0, end: 15 });
	});

	it("clamps to end=len when selected is near the bottom", () => {
		// maxVisible=15, len=100, selectedIndex=99
		// start = min(99-7, 100-15) = min(92, 85) = 85
		const { start, end } = computeWindow(99, 100, 15);
		expect(start).toBe(85);
		expect(end).toBe(100);
	});

	it("never returns start < 0 or end > len", () => {
		const { start, end } = computeWindow(0, 3, 15);
		expect(start).toBe(0);
		expect(end).toBe(3);
	});
});
