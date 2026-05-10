import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArchonClient } from "../src/archon-client.js";
import {
	ERROR_THRESHOLD,
	POLL_INTERVAL_MAX_MS,
	POLL_INTERVAL_MS,
	STATUS_KEY,
	makeRuntime,
	pollOnce,
	refreshStatus,
	startPolling,
	stopPolling,
} from "../src/runtime.js";
import type { ArchonRun } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<ArchonRun> & { id: string; status: string }): ArchonRun {
	const base: ArchonRun = {
		id: overrides.id,
		status: overrides.status,
	};
	if (overrides.workflowName !== undefined) base.workflowName = overrides.workflowName;
	return base;
}

interface StubPi {
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
}

function makePi(): StubPi {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
	};
}

function makeClient(runs: ArchonRun[] | Error): ArchonClient {
	if (runs instanceof Error) {
		return {
			getWorkflowStatus: vi.fn().mockRejectedValue(runs),
		};
	}
	return {
		getWorkflowStatus: vi.fn().mockResolvedValue(runs),
	};
}

// ---------------------------------------------------------------------------
// makeRuntime
// ---------------------------------------------------------------------------

describe("makeRuntime", () => {
	it("initialises with empty snapshot, not paused, scheduler stopped", () => {
		const pi = makePi();
		const client = makeClient([]);
		const rt = makeRuntime(pi as never, client);
		expect(rt.snapshot).toEqual({});
		expect(rt.paused).toBe(false);
		expect(rt.scheduler.isRunning).toBe(false);
		expect(rt.scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
		expect(rt.consecutiveErrors).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// startPolling / stopPolling
// ---------------------------------------------------------------------------

describe("startPolling / stopPolling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("startPolling makes the scheduler run", () => {
		const rt = makeRuntime(makePi() as never, makeClient([]));
		startPolling(rt);
		expect(rt.scheduler.isRunning).toBe(true);
		stopPolling(rt);
	});

	it("startPolling is idempotent (second call does not restart the scheduler)", () => {
		const rt = makeRuntime(makePi() as never, makeClient([]));
		startPolling(rt);
		const firstTimer = rt.scheduler.timer;
		startPolling(rt); // second call
		expect(rt.scheduler.timer).toBe(firstTimer);
		stopPolling(rt);
	});

	it("stopPolling stops the scheduler", () => {
		const rt = makeRuntime(makePi() as never, makeClient([]));
		startPolling(rt);
		stopPolling(rt);
		expect(rt.scheduler.isRunning).toBe(false);
	});

	it("stopPolling is safe to call when already stopped", () => {
		const rt = makeRuntime(makePi() as never, makeClient([]));
		expect(() => stopPolling(rt)).not.toThrow();
	});

	it("fires pollOnce after POLL_INTERVAL_MS", async () => {
		const runs = [makeRun({ id: "r1", status: "running" })];
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(runs));
		rt.watchedIds.add("r1");
		startPolling(rt);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(pi.appendEntry).toHaveBeenCalled(); // writeSnapshot called
		stopPolling(rt);
	});
});

// ---------------------------------------------------------------------------
// pollOnce
// ---------------------------------------------------------------------------

describe("pollOnce", () => {
	it("returns immediately when paused", async () => {
		const pi = makePi();
		const client = makeClient([]);
		const rt = makeRuntime(pi as never, client);
		rt.paused = true;
		await pollOnce(rt);
		expect(client.getWorkflowStatus).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does nothing when there are no runs and no baseline", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient([]));
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		// snapshot persisted even when empty
		expect(pi.appendEntry).toHaveBeenCalled();
	});

	it("emits a chat message when a status change is detected", async () => {
		const pi = makePi();
		const client = makeClient([makeRun({ id: "r1", status: "completed" })]);
		const rt = makeRuntime(pi as never, client);
		rt.snapshot = { r1: makeRun({ id: "r1", status: "running" }) };
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg, opts] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display: boolean },
			{ deliverAs: string; triggerTurn: boolean },
		];
		expect(msg.customType).toBe("pi-archon-workflow-watcher");
		expect(msg.display).toBe(true);
		expect(opts.triggerTurn).toBe(true); // completed → shouldTriggerTurn
	});

	it("does not emit a chat message when no changes detected", async () => {
		const pi = makePi();
		const run = makeRun({ id: "r1", status: "running" });
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.snapshot = { r1: run };
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("updates rt.snapshot to current after poll", async () => {
		const pi = makePi();
		const updated = makeRun({ id: "r1", status: "completed" });
		const rt = makeRuntime(pi as never, makeClient([updated]));
		rt.snapshot = { r1: makeRun({ id: "r1", status: "running" }) };
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		expect(rt.snapshot["r1"]!.status).toBe("completed");
	});

	it("filters out runs with empty id", async () => {
		const pi = makePi();
		const runs: ArchonRun[] = [
			{ id: "", status: "running" }, // should be filtered
			makeRun({ id: "r1", status: "running" }),
		];
		const rt = makeRuntime(pi as never, makeClient(runs));
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		expect(rt.snapshot[""]).toBeUndefined();
		expect(rt.snapshot["r1"]).toBeDefined();
	});

	it("persists the snapshot on each poll", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient([makeRun({ id: "r1", status: "running" })]));
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		const appendCalls = pi.appendEntry.mock.calls as Array<[string, unknown]>;
		expect(appendCalls.some(([t]) => t === "pi-archon-workflow-watcher:state")).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Error handling
	// -------------------------------------------------------------------------

	it("increments consecutiveErrors on failure and returns without updating snapshot", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("connection refused")));
		rt.snapshot = { r1: makeRun({ id: "r1", status: "running" }) };
		rt.watchedIds.add("r1");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await pollOnce(rt);
		warnSpy.mockRestore();
		expect(rt.consecutiveErrors).toBe(1);
		expect(rt.snapshot["r1"]).toBeDefined(); // snapshot unchanged
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not send a warning message until ERROR_THRESHOLD is reached", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("fail")));
		rt.watchedIds.add("r1");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 0; i < ERROR_THRESHOLD - 1; i++) {
			await pollOnce(rt);
		}
		warnSpy.mockRestore();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("sends a warning chat message exactly at ERROR_THRESHOLD", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("fail")));
		rt.watchedIds.add("r1");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 0; i < ERROR_THRESHOLD; i++) {
			await pollOnce(rt);
		}
		warnSpy.mockRestore();
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [{ customType: string; content: string }];
		expect(msg.customType).toBe("pi-archon-workflow-watcher");
		expect(msg.content).toContain("consecutive poll failures");
	});

	it("does not send another warning message for errors beyond ERROR_THRESHOLD", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("fail")));
		rt.watchedIds.add("r1");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let i = 0; i < ERROR_THRESHOLD + 3; i++) {
			await pollOnce(rt);
		}
		warnSpy.mockRestore();
		expect(pi.sendMessage).toHaveBeenCalledOnce(); // only once at threshold
	});

	it("resets consecutiveErrors to 0 on successful poll", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("fail")));
		rt.watchedIds.add("r1");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await pollOnce(rt); // fail
		warnSpy.mockRestore();
		expect(rt.consecutiveErrors).toBe(1);

		// Now succeed
		const client2 = makeClient([]);
		rt.client = client2;
		await pollOnce(rt);
		expect(rt.consecutiveErrors).toBe(0);
	});

	// -------------------------------------------------------------------------
	// triggerTurn logic
	// -------------------------------------------------------------------------

	it("sends with triggerTurn=false when only new_run events (no shouldTriggerTurn)", async () => {
		const pi = makePi();
		const rt = makeRuntime(
			pi as never,
			makeClient([makeRun({ id: "r1", status: "running" })]),
		);
		rt.watchedIds.add("r1");
		// empty baseline → new_run event only
		await pollOnce(rt);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [, opts] = pi.sendMessage.mock.calls[0] as [
			unknown,
			{ triggerTurn: boolean },
		];
		expect(opts.triggerTurn).toBe(false); // new_run never triggers turn
	});

	it("sends with triggerTurn=true when a status_changed event has shouldTriggerTurn=true", async () => {
		const pi = makePi();
		const rt = makeRuntime(
			pi as never,
			makeClient([makeRun({ id: "r1", status: "paused" })]),
		);
		rt.snapshot = { r1: makeRun({ id: "r1", status: "running" }) };
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		const [, opts] = pi.sendMessage.mock.calls[0] as [
			unknown,
			{ triggerTurn: boolean },
		];
		expect(opts.triggerTurn).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// refreshStatus
// ---------------------------------------------------------------------------

describe("refreshStatus", () => {
	it("clears the status row when paused", () => {
		const pi = makePi();
		const setStatus = vi.fn();
		const rt = makeRuntime(pi as never, makeClient([]));
		rt.paused = true;
		rt.ui = { setStatus };
		refreshStatus(rt);
		expect(setStatus).toHaveBeenCalledWith("pi-archon-workflow-watcher", undefined);
	});

	it("sets a status string when not paused", () => {
		const pi = makePi();
		const setStatus = vi.fn();
		const rt = makeRuntime(pi as never, makeClient([]));
		rt.ui = { setStatus };
		rt.snapshot = { r1: makeRun({ id: "r1", status: "running" }) };
		rt.watchedIds.add("r1");
		refreshStatus(rt);
		expect(setStatus).toHaveBeenCalledWith(
			"pi-archon-workflow-watcher",
			expect.any(String),
		);
		const text = (setStatus.mock.calls[0] as [string, string])[1];
		expect(text).toContain("archon-watcher");
	});

	it("uses theme.fg for accent color when ui.theme is present (only when runs are active)", () => {
		const pi = makePi();
		const setStatus = vi.fn();
		const fg = vi.fn((_color: string, text: string) => `<fg:${_color}>${text}</fg>`);
		const rt = makeRuntime(pi as never, makeClient([]));
		rt.ui = { setStatus, theme: { fg } };
		// With an empty snapshot, refreshStatus should clear the row — not set it.
		refreshStatus(rt);
		expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
		expect(fg).not.toHaveBeenCalled();

		// Seed an active run and confirm the status row is now set with accent color.
		rt.snapshot = { r1: { id: "r1", status: "running" } };
		rt.watchedIds.add("r1");
		refreshStatus(rt);
		expect(fg).toHaveBeenCalledWith("accent", expect.any(String));
		const text = (setStatus.mock.calls[1] as [string, string])[1];
		expect(text).toContain("<fg:accent>");
	});

	it("does not throw when ui is null", () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient([]));
		rt.ui = null;
		expect(() => refreshStatus(rt)).not.toThrow();
	});
});

describe("idle back-off via PollScheduler", () => {
	it("pollOnce calls noteSuccess(false) when no changes detected — idle base doubles", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient([]));
		rt.watchedIds.add("r1");
		const initialIdle = rt.scheduler.idleIntervalMs;
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(initialIdle * 2);
		expect(rt.scheduler.intervalMs).toBe(initialIdle * 2);
	});

	it("pollOnce calls noteSuccess(true) when changes detected — interval snaps back to base", async () => {
		const pi = makePi();
		const run = makeRun({ id: "r1", status: "running" });
		const rt = makeRuntime(pi as never, makeClient([run]));
		// Seed an old snapshot with different status to trigger a change
		rt.snapshot = { r1: makeRun({ id: "r1", status: "paused" }) };
		rt.watchedIds.add("r1");
		rt.scheduler.forceInterval(POLL_INTERVAL_MAX_MS);
		// Drive idle base up so the reset is observable.
		rt.scheduler.noteSuccess(false);
		rt.scheduler.noteSuccess(false);
		expect(rt.scheduler.idleIntervalMs).toBeGreaterThan(POLL_INTERVAL_MS);
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
		expect(rt.scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
	});

	it("idle back-off caps at POLL_INTERVAL_MAX_MS", () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient([]));
		for (let i = 0; i < 30; i++) rt.scheduler.noteSuccess(false);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MAX_MS);
	});
});

describe("PollScheduler re-entry guard", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("timer does not re-enter pollOnce while the previous tick is still awaiting", async () => {
		// Build a client whose getWorkflowStatus parks on a controllable promise.
		let resolve!: (v: ArchonRun[]) => void;
		const pending = new Promise<ArchonRun[]>((r) => { resolve = r; });
		const getWorkflowStatus = vi.fn().mockImplementation(() => pending);
		const client: ArchonClient = { getWorkflowStatus };
		const pi = makePi();
		const rt = makeRuntime(pi as never, client);
		rt.watchedIds.add("r1");
		startPolling(rt);

		// First tick kicks off after baseMs, then parks on `pending`.
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(getWorkflowStatus).toHaveBeenCalledTimes(1);

		// Advance through multiple would-be intervals while tick is still parked.
		// The setTimeout chain only schedules the next tick AFTER the current
		// tick's promise resolves, so no second call must occur.
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
		expect(getWorkflowStatus).toHaveBeenCalledTimes(1);

		// Resolve the parked tick and let the chain schedule the next one.
		resolve([]);
		await vi.advanceTimersByTimeAsync(0); // flush microtasks
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		expect(getWorkflowStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
		stopPolling(rt);
	});
});

describe("pollOnce — db-locked handling", () => {
	it("does NOT increment consecutiveErrors when error is db-locked", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pi = makePi();
		const err = new Error("archon workflow status failed: Command failed\nstderr: Error: Failed to list workflow runs: database is locked");
		const rt = makeRuntime(pi as never, makeClient(err));
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		warnSpy.mockRestore();
		expect(rt.consecutiveErrors).toBe(0);
	});

	it("does NOT send a chat message for a db-locked error", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pi = makePi();
		const err = new Error("archon workflow status failed\nstderr: database is locked");
		const rt = makeRuntime(pi as never, makeClient(err));
		rt.watchedIds.add("r1");
		// Run more than ERROR_THRESHOLD times — still no message
		for (let i = 0; i < 6; i++) await pollOnce(rt);
		warnSpy.mockRestore();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(rt.consecutiveErrors).toBe(0);
	});

	it("still increments consecutiveErrors for non-db-locked errors", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("some other error")));
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		warnSpy.mockRestore();
		expect(rt.consecutiveErrors).toBe(1);
	});
});
