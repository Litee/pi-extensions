/**
 * Tests for watcher.ts — debounce logic and fs.watch wrapper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	watch: vi.fn(),
}));

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

import { createDebounced, tryCreateFsWatch } from "../src/watcher.js";

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

// ---------------------------------------------------------------------------
// tryCreateFsWatch
// ---------------------------------------------------------------------------

function makeFakeWatcher(overrides?: {
	on?: ReturnType<typeof vi.fn>;
	close?: ReturnType<typeof vi.fn>;
}): { watcher: FSWatcher; on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
	const on = overrides?.on ?? vi.fn().mockReturnThis();
	const close = overrides?.close ?? vi.fn();
	const watcher = { on, close } as unknown as FSWatcher;
	return { watcher, on, close };
}

describe("tryCreateFsWatch — success path", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.mocked(watch).mockReset();
	});

	it("returns a non-null handle when fs.watch succeeds", () => {
		const { watcher } = makeFakeWatcher();
		vi.mocked(watch).mockReturnValue(watcher);
		const handle = tryCreateFsWatch("/some/path", vi.fn(), 100);
		expect(handle).not.toBeNull();
	});

	it("registers an 'error' listener on the FSWatcher", () => {
		const { watcher, on } = makeFakeWatcher();
		vi.mocked(watch).mockReturnValue(watcher);
		tryCreateFsWatch("/some/path", vi.fn(), 100);
		expect(on).toHaveBeenCalledWith("error", expect.any(Function));
	});

	it("dispose() cancels the debounce and closes the watcher", async () => {
		const { watcher, close } = makeFakeWatcher();
		vi.mocked(watch).mockReturnValue(watcher);
		const onEvent = vi.fn();
		const handle = tryCreateFsWatch("/some/path", onEvent, 100);
		handle!.dispose();
		// Timer should be cancelled — onEvent must not fire after dispose
		await vi.advanceTimersByTimeAsync(200);
		expect(onEvent).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it("dispose() is safe to call twice (idempotent close)", () => {
		const { watcher } = makeFakeWatcher();
		vi.mocked(watch).mockReturnValue(watcher);
		const handle = tryCreateFsWatch("/some/path", vi.fn(), 100);
		handle!.dispose();
		expect(() => handle!.dispose()).not.toThrow();
	});

	it("dispose() tolerates watcher.close() throwing", () => {
		const { watcher } = makeFakeWatcher({
			close: vi.fn().mockImplementation(() => {
				throw new Error("already closed");
			}),
		});
		vi.mocked(watch).mockReturnValue(watcher);
		const handle = tryCreateFsWatch("/some/path", vi.fn(), 100);
		expect(() => handle!.dispose()).not.toThrow();
	});

	it("fs.watch callback triggers debounce which calls onEvent after delay", async () => {
		let watchCallback: (() => void) | null = null;
		vi.mocked(watch).mockImplementation(
			((
				_path: unknown,
				_opts: unknown,
				cb: (() => void) | undefined,
			) => {
				watchCallback = cb ?? null;
				return makeFakeWatcher().watcher;
			}) as never,
		);
		const onEvent = vi.fn();
		tryCreateFsWatch("/some/path", onEvent, 100);
		expect(watchCallback).not.toBeNull();
		watchCallback!();
		expect(onEvent).not.toHaveBeenCalled(); // still debouncing
		await vi.advanceTimersByTimeAsync(100);
		expect(onEvent).toHaveBeenCalledOnce();
	});
});

describe("tryCreateFsWatch — error path (fs.watch throws)", () => {
	afterEach(() => {
		vi.mocked(watch).mockReset();
	});

	it("returns null when fs.watch throws synchronously (ENOSYS / EPERM)", () => {
		vi.mocked(watch).mockImplementation(() => {
			throw Object.assign(new Error("ENOSYS: function not implemented"), { code: "ENOSYS" });
		});
		const handle = tryCreateFsWatch("/some/path", vi.fn(), 100);
		expect(handle).toBeNull();
	});
});

describe("tryCreateFsWatch — error event path", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.mocked(watch).mockReset();
	});

	it("handles error event: cancels debounce and closes the watcher", async () => {
		let errorHandler: (() => void) | null = null;
		const onFn = vi.fn().mockImplementation((event: string, cb: () => void) => {
			if (event === "error") errorHandler = cb;
			return fw;
		});
		const { watcher: fw, close } = makeFakeWatcher({ on: onFn });
		vi.mocked(watch).mockReturnValue(fw);

		const onEvent = vi.fn();
		tryCreateFsWatch("/some/path", onEvent, 100);

		expect(errorHandler).not.toBeNull();
		errorHandler!(); // fire the error event

		// debounce should have been cancelled
		await vi.advanceTimersByTimeAsync(200);
		expect(onEvent).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it("error event: tolerates watcher.close() throwing", () => {
		let errorHandler: (() => void) | null = null;
		const onFn = vi.fn().mockImplementation((event: string, cb: () => void) => {
			if (event === "error") errorHandler = cb;
			return fw;
		});
		const closeFn = vi.fn().mockImplementation(() => {
			throw new Error("already closed");
		});
		const { watcher: fw } = makeFakeWatcher({ on: onFn, close: closeFn });
		vi.mocked(watch).mockReturnValue(fw);

		tryCreateFsWatch("/some/path", vi.fn(), 100);
		expect(() => errorHandler!()).not.toThrow();
	});
});
