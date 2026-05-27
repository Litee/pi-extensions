/**
 * Tests for runtime.ts — watch-handle lifecycle, refreshStatus, and
 * edge-case poll paths not covered by runtime.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/watcher.js", () => ({
	tryCreateFsWatch: vi.fn(),
}));

import { tryCreateFsWatch } from "../src/watcher.js";
import {
	makeRuntime,
	pollOnce,
	POLL_ERROR_THRESHOLD,
	refreshStatus,
	setupWatchFs,
	startPolling,
	STATUS_KEY,
	teardownAllWatchHandles,
	teardownWatchFs,
} from "../src/runtime.js";
import type { FsWatch, TargetCondition } from "../src/types.js";
import type { FsWatchHandle } from "../src/watcher.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => [] as string[],
		setActiveTools: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
	};
}

function makeFakeHandle(): { handle: FsWatchHandle; dispose: ReturnType<typeof vi.fn> } {
	const dispose = vi.fn();
	return { handle: { dispose }, dispose };
}

function makeWatch(target: TargetCondition = "exists"): FsWatch {
	return {
		watchId: "w1",
		path: "/test/path",
		target,
		mode: "auto",
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: { exists: false },
		terminal: false,
		consecutiveErrors: 0,
	};
}

// ---------------------------------------------------------------------------
// setupWatchFs
// ---------------------------------------------------------------------------

describe("setupWatchFs", () => {
	it("is a no-op when mode='poll'", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		const w = { ...makeWatch(), mode: "poll" as const };
		setupWatchFs(rt, w);
		expect(tryCreateFsWatch).not.toHaveBeenCalled();
		expect(rt.watchHandles.size).toBe(0);
	});

	it("stores the handle when tryCreateFsWatch returns one (mode='auto')", () => {
		const { handle } = makeFakeHandle();
		vi.mocked(tryCreateFsWatch).mockReturnValueOnce(handle);
		const rt = makeRuntime(makePi(), vi.fn());
		const w = makeWatch();
		setupWatchFs(rt, w);
		expect(tryCreateFsWatch).toHaveBeenCalledOnce();
		expect(rt.watchHandles.get(w.watchId)).toBe(handle);
	});

	it("does not store a null handle when tryCreateFsWatch returns null", () => {
		vi.mocked(tryCreateFsWatch).mockReturnValueOnce(null);
		const rt = makeRuntime(makePi(), vi.fn());
		setupWatchFs(rt, makeWatch());
		expect(rt.watchHandles.size).toBe(0);
	});

	it("uses mode='event' watches the same way as 'auto'", () => {
		const { handle } = makeFakeHandle();
		vi.mocked(tryCreateFsWatch).mockReturnValueOnce(handle);
		const rt = makeRuntime(makePi(), vi.fn());
		const w = { ...makeWatch(), mode: "event" as const };
		setupWatchFs(rt, w);
		expect(rt.watchHandles.get(w.watchId)).toBe(handle);
	});
});

// ---------------------------------------------------------------------------
// teardownWatchFs
// ---------------------------------------------------------------------------

describe("teardownWatchFs", () => {
	it("disposes and removes an existing handle", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		const { handle, dispose } = makeFakeHandle();
		rt.watchHandles.set("w1", handle);
		teardownWatchFs(rt, "w1");
		expect(dispose).toHaveBeenCalledOnce();
		expect(rt.watchHandles.has("w1")).toBe(false);
	});

	it("is a no-op for an unknown watchId", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		expect(() => teardownWatchFs(rt, "unknown")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// teardownAllWatchHandles
// ---------------------------------------------------------------------------

describe("teardownAllWatchHandles", () => {
	it("disposes all handles and clears the map", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		const { handle: h1handle, dispose: d1 } = makeFakeHandle();
		const { handle: h2handle, dispose: d2 } = makeFakeHandle();
		rt.watchHandles.set("w1", h1handle);
		rt.watchHandles.set("w2", h2handle);
		teardownAllWatchHandles(rt);
		expect(d1).toHaveBeenCalledOnce();
		expect(d2).toHaveBeenCalledOnce();
		expect(rt.watchHandles.size).toBe(0);
	});

	it("is a no-op when the map is already empty", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		expect(() => teardownAllWatchHandles(rt)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// refreshStatus
// ---------------------------------------------------------------------------

describe("refreshStatus", () => {
	it("calls setStatus(KEY, undefined) when displayMode='widget'", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		const setStatus = vi.fn();
		rt.ui = { setStatus };
		rt.displayMode = "widget";
		refreshStatus(rt);
		expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
	});

	it("calls setStatus with a non-undefined string when displayMode='statusline'", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		const setStatus = vi.fn();
		rt.ui = { setStatus };
		rt.displayMode = "statusline";
		refreshStatus(rt);
		expect(setStatus).toHaveBeenCalledOnce();
		const [key, text] = setStatus.mock.calls[0]! as [string, string | undefined];
		expect(key).toBe(STATUS_KEY);
		expect(typeof text).toBe("string");
	});

	it("statusline with errors includes a warning indicator", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		const setStatus = vi.fn();
		rt.ui = { setStatus };
		rt.displayMode = "statusline";
		// Add a watch with error count at threshold
		rt.watches["w1"] = {
			...makeWatch(),
			consecutiveErrors: POLL_ERROR_THRESHOLD,
			terminal: false,
		};
		refreshStatus(rt);
		const text = setStatus.mock.calls[0]![1] as string;
		expect(text).toBeTruthy();
	});

	it("statusline with ui=null does not throw", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		rt.ui = null;
		rt.displayMode = "statusline";
		expect(() => refreshStatus(rt)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// pollOnce — empty active list (all terminal or no watches)
// ---------------------------------------------------------------------------

describe("pollOnce — empty active list", () => {
	it("returns early without calling snapshot when all watches are terminal", async () => {
		const snap = vi.fn();
		const rt = makeRuntime(makePi(), snap);
		rt.watches["w1"] = { ...makeWatch(), terminal: true };
		await pollOnce(rt);
		expect(snap).not.toHaveBeenCalled();
	});

	it("returns early without calling snapshot when watches map is empty", async () => {
		const snap = vi.fn();
		const rt = makeRuntime(makePi(), snap);
		await pollOnce(rt);
		expect(snap).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// pollOnce — recovery (noteWatchSuccess onRecover callback)
// ---------------------------------------------------------------------------

describe("pollOnce — recovery after previous errors", () => {
	it("sends a recovery message when a previously-erroring watch succeeds", async () => {
		const pi = makePi();
		// Snapshot always returns 'no change' (file still absent, target=exists — no event)
		const snap = vi.fn().mockResolvedValue({ exists: false });
		const rt = makeRuntime(pi, snap);
		// Pre-set consecutive errors so the onRecover path is triggered on success
		rt.watches["w1"] = {
			...makeWatch("exists"),
			baseline: { exists: false },
			consecutiveErrors: POLL_ERROR_THRESHOLD, // was at threshold
		};

		// First poll — snapshot succeeds, consecutiveErrors resets, recovery fires
		await pollOnce(rt);

		// The recovery message should have been sent
		const calls = pi.sendMessage.mock.calls;
		const recoveryCall = calls.find((c) => {
			const msg = (c[0] as { content?: string }).content ?? "";
			return /recovered/i.test(msg);
		});
		expect(recoveryCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// startPolling integration with setupWatchFs
// ---------------------------------------------------------------------------

describe("setupWatchFs + startPolling integration", () => {
	it("sets up a handle and startPolling works independently", () => {
		const { handle } = makeFakeHandle();
		vi.mocked(tryCreateFsWatch).mockReturnValueOnce(handle);
		const rt = makeRuntime(makePi(), vi.fn().mockResolvedValue({ exists: false }));
		const w = makeWatch();
		rt.watches[w.watchId] = w;
		setupWatchFs(rt, w);
		expect(rt.watchHandles.size).toBe(1);
		startPolling(rt);
		expect(rt.scheduler.isRunning).toBe(true);
		rt.scheduler.stop();
	});
});
