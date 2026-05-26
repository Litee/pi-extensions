/**
 * Tests for runtime.ts — pollOnce with injectable snapshot for unit isolation.
 *
 * For integration tests using real filesystem see poller.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	makeRuntime,
	POLL_ERROR_THRESHOLD,
	POLL_INTERVAL_MAX_MS,
	POLL_INTERVAL_MS,
	pollOnce,
	startPolling,
	stopPolling,
} from "../src/runtime.js";
import type { FsBaseline, FsWatch, TargetCondition } from "../src/types.js";

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

function makeSnapshot(baseline: FsBaseline) {
	return vi.fn().mockResolvedValue(baseline);
}

function makeErrorSnapshot(err: Error) {
	return vi.fn().mockRejectedValue(err);
}

function makeWatch(target: TargetCondition, baseline?: FsBaseline): FsWatch {
	return {
		watchId: "w1",
		path: "/test/path",
		target,
		mode: "poll",
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline,
		terminal: false,
		consecutiveErrors: 0,
	};
}

// ---------------------------------------------------------------------------
// makeRuntime
// ---------------------------------------------------------------------------

describe("makeRuntime", () => {
	it("initialises the scheduler at base interval, stopped", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		expect(rt.scheduler.isRunning).toBe(false);
		expect(rt.scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
	});

	it("starts with empty watches and paused=false, enabled=false", () => {
		const rt = makeRuntime(makePi(), vi.fn());
		expect(rt.watches).toEqual({});
		expect(rt.paused).toBe(false);
		expect(rt.enabled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// startPolling / stopPolling
// ---------------------------------------------------------------------------

describe("startPolling / stopPolling", () => {
	it("flips isRunning true/false", () => {
		const rt = makeRuntime(makePi(), makeSnapshot({ exists: false }));
		startPolling(rt);
		expect(rt.scheduler.isRunning).toBe(true);
		stopPolling(rt);
		expect(rt.scheduler.isRunning).toBe(false);
	});

	it("startPolling is idempotent", () => {
		const rt = makeRuntime(makePi(), makeSnapshot({ exists: false }));
		startPolling(rt);
		const first = rt.scheduler.timer;
		startPolling(rt);
		expect(rt.scheduler.timer).toBe(first);
		stopPolling(rt);
	});
});

// ---------------------------------------------------------------------------
// pollOnce — target fires exactly once and marks terminal
// ---------------------------------------------------------------------------

describe("pollOnce — appear (target='exists')", () => {
	it("fires exists event when path appears", async () => {
		const pi = makePi();
		const snap = makeSnapshot({ exists: true, mtimeNs: 1000n, size: 5 });
		const rt = makeRuntime(pi, snap);
		rt.watches["w1"] = makeWatch("exists", { exists: false });

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const msg = pi.sendMessage.mock.calls[0]![0] as { content: string };
		expect(msg.content).toMatch(/now exists/);
		expect(rt.watches["w1"].terminal).toBe(true);
	});

	it("does not fire while path remains absent", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeSnapshot({ exists: false }));
		rt.watches["w1"] = makeWatch("exists", { exists: false });

		await pollOnce(rt);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(rt.watches["w1"].terminal).toBe(false);
	});
});

describe("pollOnce — modify (target='changed')", () => {
	it("fires changed event when stat() differs", async () => {
		const pi = makePi();
		const snap = makeSnapshot({ exists: true, mtimeNs: 9999n, size: 100 });
		const rt = makeRuntime(pi, snap);
		rt.watches["w1"] = makeWatch("changed", { exists: true, mtimeNs: 1000n, size: 5 });

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const msg = pi.sendMessage.mock.calls[0]![0] as { content: string };
		expect(msg.content).toMatch(/changed/);
		expect(rt.watches["w1"].terminal).toBe(true);
	});

	it("does not fire when stat is identical", async () => {
		const pi = makePi();
		const snap = makeSnapshot({ exists: true, mtimeNs: 1000n, size: 5 });
		const rt = makeRuntime(pi, snap);
		rt.watches["w1"] = makeWatch("changed", { exists: true, mtimeNs: 1000n, size: 5 });

		await pollOnce(rt);

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("pollOnce — remove (target='removed')", () => {
	it("fires removed event when path disappears", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeSnapshot({ exists: false }));
		rt.watches["w1"] = makeWatch("removed", { exists: true, mtimeNs: 1000n, size: 5 });

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const msg = pi.sendMessage.mock.calls[0]![0] as { content: string };
		expect(msg.content).toMatch(/removed/);
		expect(rt.watches["w1"].terminal).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Polling fallback path — mode='poll' behaves identically (no fs.watch overhead)
// ---------------------------------------------------------------------------

describe("pollOnce — polling fallback path (mode='poll')", () => {
	it("detects file appearance via polling when mode='poll'", async () => {
		const pi = makePi();
		const snap = makeSnapshot({ exists: true, mtimeNs: 1000n, size: 10 });
		const rt = makeRuntime(pi, snap);
		// Explicitly poll mode
		rt.watches["w1"] = {
			...makeWatch("exists", { exists: false }),
			mode: "poll",
		};

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(rt.watches["w1"].terminal).toBe(true);
	});

	it("detects file removal via polling when mode='poll'", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeSnapshot({ exists: false }));
		rt.watches["w1"] = {
			...makeWatch("removed", { exists: true, mtimeNs: 1000n }),
			mode: "poll",
		};

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(rt.watches["w1"].terminal).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// re-activation hint when tool is inactive
// ---------------------------------------------------------------------------

describe("pollOnce — re-activation hint", () => {
	it("omits hint when rt.enabled=true", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeSnapshot({ exists: true, mtimeNs: 1000n, size: 1 }));
		rt.enabled = true;
		rt.watches["w1"] = makeWatch("exists", { exists: false });

		await pollOnce(rt);

		const msg = pi.sendMessage.mock.calls[0]![0] as { content: string };
		expect(msg.content).not.toContain("manage_tools");
	});

	it("appends manage_tools hint when rt.enabled=false and change detected", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeSnapshot({ exists: true, mtimeNs: 1000n, size: 1 }));
		rt.enabled = false;
		rt.watches["w1"] = makeWatch("exists", { exists: false });

		await pollOnce(rt);

		const msg = pi.sendMessage.mock.calls[0]![0] as { content: string };
		expect(msg.content).toContain("manage_tools");
		expect(msg.content).toContain("file_system_watcher");
		expect(msg.content).toContain("activate");
	});
});

// ---------------------------------------------------------------------------
// triggerTurn
// ---------------------------------------------------------------------------

describe("pollOnce — triggerTurn", () => {
	it("uses triggerTurn: true when target fires", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeSnapshot({ exists: true, mtimeNs: 1000n, size: 1 }));
		rt.watches["w1"] = makeWatch("exists", { exists: false });

		await pollOnce(rt);

		const opts = pi.sendMessage.mock.calls[0]![1] as { triggerTurn?: boolean };
		expect(opts.triggerTurn).toBe(true);
	});

	it("does not call sendMessage when no target fires", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeSnapshot({ exists: false }));
		rt.watches["w1"] = makeWatch("exists", { exists: false });

		await pollOnce(rt);

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("pollOnce — timeout", () => {
	it("fires a timeout event and marks watch terminal without calling snapshot", async () => {
		const pi = makePi();
		const snap = vi.fn();
		const rt = makeRuntime(pi, snap);
		rt.now = () => 10_000;
		const w = makeWatch("exists", { exists: false });
		w.timeoutAt = 9_000; // elapsed
		rt.watches["w1"] = w;

		await pollOnce(rt);

		expect(snap).not.toHaveBeenCalled();
		expect(w.terminal).toBe(true);
		const content = (pi.sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toMatch(/timed out waiting for 'exists'/);
	});

	it("does not fire before timeoutAt", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeSnapshot({ exists: false }));
		rt.now = () => 1_000;
		const w = makeWatch("exists", { exists: false });
		w.timeoutAt = 99_999;
		rt.watches["w1"] = w;

		await pollOnce(rt);

		expect(w.terminal).toBe(false);
	});

	it("timeout uses triggerTurn: true", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, vi.fn());
		rt.now = () => 10_000;
		const w = makeWatch("exists", { exists: false });
		w.timeoutAt = 9_000;
		rt.watches["w1"] = w;

		await pollOnce(rt);

		const opts = pi.sendMessage.mock.calls[0]![1] as { triggerTurn?: boolean };
		expect(opts.triggerTurn).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// All-terminal → stopPolling
// ---------------------------------------------------------------------------

describe("pollOnce — stops loop once every watch is terminal", () => {
	it("stops scheduler after the final watch fires", async () => {
		const rt = makeRuntime(
			makePi(),
			makeSnapshot({ exists: true, mtimeNs: 1000n, size: 1 }),
		);
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		startPolling(rt);
		await pollOnce(rt);
		expect(rt.scheduler.isRunning).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Scheduler back-off
// ---------------------------------------------------------------------------

describe("pollOnce — scheduler back-off", () => {
	it("idle-doubles when no observable change", async () => {
		const rt = makeRuntime(makePi(), makeSnapshot({ exists: false }));
		rt.watches["w1"] = makeWatch("exists", { exists: false });
		const initial = rt.scheduler.idleIntervalMs;
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(initial * 2);
	});

	it("resets to base when target fires", async () => {
		const rt = makeRuntime(
			makePi(),
			makeSnapshot({ exists: true, mtimeNs: 1000n, size: 1 }),
		);
		rt.watches["w1"] = makeWatch("exists", { exists: false });
		rt.scheduler.noteSuccess(false);
		rt.scheduler.noteSuccess(false); // push idle up
		expect(rt.scheduler.idleIntervalMs).toBeGreaterThan(POLL_INTERVAL_MS);
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
	});

	it("idle base is capped at POLL_INTERVAL_MAX_MS", () => {
		const rt = makeRuntime(makePi(), makeSnapshot({ exists: false }));
		for (let i = 0; i < 30; i++) rt.scheduler.noteSuccess(false);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MAX_MS);
	});
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("pollOnce — error handling", () => {
	it("records error via appendEntry without leaking to sendMessage below threshold", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeErrorSnapshot(new Error("disk error")));
		rt.watches["w1"] = makeWatch("exists", { exists: false });

		await pollOnce(rt);

		expect(pi.appendEntry).toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("sendMessage at threshold uses sanitized message (not raw error text)", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeErrorSnapshot(new Error("internal disk error details")));
		const w = makeWatch("exists", { exists: false });
		w.consecutiveErrors = POLL_ERROR_THRESHOLD - 1;
		rt.watches["w1"] = w;

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const content = (pi.sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).not.toContain("internal disk error details");
		expect(content).toMatch(/failed|error/i);
	});
});

// ---------------------------------------------------------------------------
// PollScheduler re-entry guard
// ---------------------------------------------------------------------------

describe("PollScheduler re-entry guard", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not re-enter pollOnce while a previous tick is awaiting", async () => {
		let resolve!: (v: FsBaseline) => void;
		const pending = new Promise<FsBaseline>((r) => {
			resolve = r;
		});
		const snap = vi.fn().mockImplementation(() => pending);
		const rt = makeRuntime(makePi(), snap);
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		startPolling(rt);

		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(snap).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
		expect(snap).toHaveBeenCalledTimes(1); // still 1 — re-entry guard holds

		resolve({ exists: false });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		expect(snap.mock.calls.length).toBeGreaterThanOrEqual(2);
		stopPolling(rt);
	});
});
