/**
 * Tests for watcher.ts — debounce logic and fs.watch wrapper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDebounced } from "../src/watcher.js";

// ---------------------------------------------------------------------------
// createDebounced
// ---------------------------------------------------------------------------

describe("createDebounced — debounce of rapid successive events", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("delays invocation by debounceMs after a single trigger", async () => {
		const fn = vi.fn();
		const dh = createDebounced(fn, 500);
		dh.trigger();
		expect(fn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(499);
		expect(fn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(fn).toHaveBeenCalledOnce();
	});

	it("collapses rapid successive triggers into one invocation", async () => {
		const fn = vi.fn();
		const dh = createDebounced(fn, 500);
		dh.trigger();
		dh.trigger();
		dh.trigger();
		dh.trigger();
		await vi.advanceTimersByTimeAsync(499);
		expect(fn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(fn).toHaveBeenCalledOnce();
	});

	it("resets the timer on each trigger (trailing edge)", async () => {
		const fn = vi.fn();
		const dh = createDebounced(fn, 500);
		dh.trigger();
		await vi.advanceTimersByTimeAsync(300);
		dh.trigger(); // reset the timer
		await vi.advanceTimersByTimeAsync(499);
		expect(fn).not.toHaveBeenCalled(); // 300 + 499 = 799 ms total but reset at 300
		await vi.advanceTimersByTimeAsync(1); // exactly 500ms after last trigger
		expect(fn).toHaveBeenCalledOnce();
	});

	it("cancel() prevents the pending invocation", async () => {
		const fn = vi.fn();
		const dh = createDebounced(fn, 500);
		dh.trigger();
		dh.cancel();
		await vi.advanceTimersByTimeAsync(1000);
		expect(fn).not.toHaveBeenCalled();
	});

	it("allows a new trigger after cancel", async () => {
		const fn = vi.fn();
		const dh = createDebounced(fn, 500);
		dh.trigger();
		dh.cancel();
		dh.trigger();
		await vi.advanceTimersByTimeAsync(500);
		expect(fn).toHaveBeenCalledOnce();
	});

	it("fires multiple times for well-spaced triggers", async () => {
		const fn = vi.fn();
		const dh = createDebounced(fn, 100);
		dh.trigger();
		await vi.advanceTimersByTimeAsync(200);
		dh.trigger();
		await vi.advanceTimersByTimeAsync(200);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
