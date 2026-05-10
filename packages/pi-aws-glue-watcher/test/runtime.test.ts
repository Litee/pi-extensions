/**
 * Runtime-layer tests for the PollScheduler migration.
 *
 * The bulk of runtime behaviour (pollOnce event shape, error threshold,
 * persistence side-effects, widget wiring) is exercised indirectly from
 * command.test.ts and index.test.ts. This file adds direct coverage of
 * the properties that changed when the hand-rolled setInterval /
 * bumpIdleInterval / resetIntervalAfterUpdate machinery was replaced with
 * pi-watcher-core's PollScheduler:
 *
 *   1. `rt.scheduler` is initialised, stopped, at base interval.
 *   2. `startPolling` / `stopPolling` drive `rt.scheduler.isRunning`.
 *   3. `pollOnce` calls `noteSuccess(anyUpdate)` so idle base doubles on
 *      a quiet poll and resets on a poll with events.
 *   4. Re-entry guard: a parked tick must NOT be re-entered by the timer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlueClient, JobRunResponse } from "../src/cli-client.js";
import {
	makeRuntime,
	POLL_INTERVAL_MAX_MS,
	POLL_INTERVAL_MS,
	pollOnce,
	startPolling,
	stopPolling,
} from "../src/runtime.js";
import type { GlueWatch, JobBaseline } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
	} as unknown as Parameters<typeof makeRuntime>[0];
}

function makeJobRunResponse(state: string): JobRunResponse {
	return { JobRun: { JobRunState: state, ErrorMessage: "" } };
}

function makeClient(respondWith: JobRunResponse): GlueClient {
	return {
		getJobRun: vi.fn().mockResolvedValue(respondWith),
		// not used in these tests:
		getWorkflowRun: vi.fn(),
	} as unknown as GlueClient;
}

function makeJobWatch(baseline?: JobBaseline): GlueWatch {
	return {
		watchId: "aabbccdd",
		type: "job",
		name: "etl",
		runId: "jr_1",
		profile: "p",
		region: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline,
		terminal: false,
		consecutiveErrors: 0,
	};
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

describe("makeRuntime", () => {
	it("initialises scheduler at base interval, stopped", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		expect(rt.scheduler.isRunning).toBe(false);
		expect(rt.scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
	});
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

describe("startPolling / stopPolling", () => {
	it("startPolling flips isRunning to true; stopPolling flips it back", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		rt.enabled = true;
		startPolling(rt);
		expect(rt.scheduler.isRunning).toBe(true);
		stopPolling(rt);
		expect(rt.scheduler.isRunning).toBe(false);
	});

	it("startPolling is idempotent", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		rt.enabled = true;
		startPolling(rt);
		const firstTimer = rt.scheduler.timer;
		startPolling(rt);
		expect(rt.scheduler.timer).toBe(firstTimer);
		stopPolling(rt);
	});
});

// ---------------------------------------------------------------------------
// Idle back-off via scheduler.noteSuccess
// ---------------------------------------------------------------------------

describe("pollOnce — idle back-off via PollScheduler", () => {
	it("doubles the idle base when the poll produces no events", async () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		rt.enabled = true;
		// Seed a watch whose baseline matches current state → no event.
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		const initialIdle = rt.scheduler.idleIntervalMs;
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(initialIdle * 2);
	});

	it("resets interval to base when the poll produces an event", async () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("SUCCEEDED")));
		rt.enabled = true;
		// Baseline = RUNNING, current = SUCCEEDED → state_changed event.
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		// Drive the idle base up first.
		rt.scheduler.noteSuccess(false);
		rt.scheduler.noteSuccess(false);
		expect(rt.scheduler.idleIntervalMs).toBeGreaterThan(POLL_INTERVAL_MS);
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
		expect(rt.scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
	});

	it("idle base is capped at POLL_INTERVAL_MAX_MS", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		for (let i = 0; i < 30; i++) rt.scheduler.noteSuccess(false);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MAX_MS);
	});
});

// ---------------------------------------------------------------------------
// Re-entry guard
// ---------------------------------------------------------------------------

describe("PollScheduler re-entry guard", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("the scheduler must not re-enter pollOnce while a previous tick is awaiting", async () => {
		// Park the getJobRun call on a controllable promise.
		let resolve!: (v: JobRunResponse) => void;
		const pending = new Promise<JobRunResponse>((r) => { resolve = r; });
		const getJobRun = vi.fn().mockImplementation(() => pending);
		const client = { getJobRun, getWorkflowRun: vi.fn() } as unknown as GlueClient;
		const rt = makeRuntime(makePi(), client);
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		startPolling(rt);

		// First tick fires after baseMs, then parks on `pending`.
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(getJobRun).toHaveBeenCalledTimes(1);

		// Advance many intervals while the tick is still parked — the
		// setTimeout chain only reschedules after the tick resolves, so
		// no second call must occur.
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
		expect(getJobRun).toHaveBeenCalledTimes(1);

		// Resolve the parked tick; next tick schedules off end-of-tick.
		resolve(makeJobRunResponse("RUNNING"));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		expect(getJobRun.mock.calls.length).toBeGreaterThanOrEqual(2);
		stopPolling(rt);
	});
});
