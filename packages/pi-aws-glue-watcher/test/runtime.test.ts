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

import type { GlueClient, JobRunResponse } from "../src/glue-client.js";
import {
	makeRuntime,
	POLL_ERROR_THRESHOLD,
	POLL_INTERVAL_MAX_MS,
	POLL_INTERVAL_MS,
	pollOnce,
	pollWatch,
	startPolling,
	startWatchPolling,
	stopPolling,
	stopWatchPolling,
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
	};
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
	it("initialises with empty schedulers map", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		expect(rt.schedulers.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

describe("startPolling / stopPolling", () => {
	it("startPolling creates per-watch schedulers; stopPolling removes them", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		startPolling(rt);
		expect(rt.schedulers.size).toBe(1);
		expect(rt.schedulers.get(watch.watchId)?.isRunning).toBe(true);
		stopPolling(rt);
		expect(rt.schedulers.size).toBe(0);
	});

	it("startPolling is idempotent — does not create a second scheduler for the same watch", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		startPolling(rt);
		const firstScheduler = rt.schedulers.get(watch.watchId);
		startPolling(rt);
		expect(rt.schedulers.get(watch.watchId)).toBe(firstScheduler);
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
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		// start scheduler so it exists
		startPolling(rt);
		const scheduler = rt.schedulers.get(watch.watchId)!;
		const initialIdle = scheduler.idleIntervalMs;
		await pollWatch(rt, watch.watchId);
		expect(scheduler.idleIntervalMs).toBe(initialIdle * 2);
		stopPolling(rt);
	});

	it("resets interval to base when the poll produces an event", async () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("SUCCEEDED")));
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		startPolling(rt);
		const scheduler = rt.schedulers.get(watch.watchId)!;
		// Drive the idle base up first.
		scheduler.noteSuccess(false);
		scheduler.noteSuccess(false);
		expect(scheduler.idleIntervalMs).toBeGreaterThan(POLL_INTERVAL_MS);
		await pollWatch(rt, watch.watchId);
		expect(scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
		expect(scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
		stopPolling(rt);
	});

	it("idle base is capped at POLL_INTERVAL_MAX_MS", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		startPolling(rt);
		const scheduler = rt.schedulers.get(watch.watchId)!;
		for (let i = 0; i < 30; i++) scheduler.noteSuccess(false);
		expect(scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MAX_MS);
		stopPolling(rt);
	});

	it("per-watch back-off is independent: one watch's back-off does not affect another", async () => {
		// watchA: no events (will back off)
		// watchB: event fires (resets to base)
		const piMock = makePi();
		const watchA = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const watchB = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const clientA = makeClient(makeJobRunResponse("RUNNING")); // no change
		const clientB = makeClient(makeJobRunResponse("SUCCEEDED")); // event
		// Use separate runtimes to isolate schedulers, then share watches.
		const rtA = makeRuntime(piMock, clientA);
		rtA.enabled = true;
		rtA.watches[watchA.watchId] = watchA;
		startPolling(rtA);
		const schedulerA = rtA.schedulers.get(watchA.watchId)!;
		const initialA = schedulerA.idleIntervalMs;
		await pollWatch(rtA, watchA.watchId);
		expect(schedulerA.idleIntervalMs).toBe(initialA * 2); // backed off

		const rtB = makeRuntime(piMock, clientB);
		rtB.enabled = true;
		rtB.watches[watchB.watchId] = watchB;
		startPolling(rtB);
		const schedulerB = rtB.schedulers.get(watchB.watchId)!;
		// Pre-back-off B then fire an event — it should reset.
		schedulerB.noteSuccess(false);
		schedulerB.noteSuccess(false);
		const backedOffB = schedulerB.idleIntervalMs;
		expect(backedOffB).toBeGreaterThan(POLL_INTERVAL_MS);
		await pollWatch(rtB, watchB.watchId);
		expect(schedulerB.idleIntervalMs).toBe(POLL_INTERVAL_MS); // reset

		// A's scheduler is unchanged by B's reset.
		expect(schedulerA.idleIntervalMs).toBe(initialA * 2);

		stopPolling(rtA);
		stopPolling(rtB);
	});

	it("global pause halts all per-watch schedulers; resume restarts them", () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		rt.enabled = true;
		const wA = { ...makeJobWatch({ state: "RUNNING", errorMessage: "" }), watchId: "watch-a" };
		const wB = { ...makeJobWatch({ state: "RUNNING", errorMessage: "" }), watchId: "watch-b" };
		rt.watches[wA.watchId] = wA;
		rt.watches[wB.watchId] = wB;
		startPolling(rt);
		expect(rt.schedulers.size).toBe(2);
		stopPolling(rt); // simulates pause clearing all schedulers
		expect(rt.schedulers.size).toBe(0);
		// resume re-creates them
		startPolling(rt);
		expect(rt.schedulers.size).toBe(2);
		stopPolling(rt);
	});

	it("staggered-start race: delayed scheduler replaced by set-interval does not ghost-start the old one", async () => {
		// Reproduces the bug where the delayMs timeout checks .has(watchId) instead
		// of identity equality, allowing a replaced scheduler to start as a ghost.
		vi.useFakeTimers();
		try {
			const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
			rt.enabled = true;
			const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
			rt.watches[watch.watchId] = watch;

			// Stagger delay of 50ms so the timeout fires in this test.
			startWatchPolling(rt, watch.watchId, 50);
			const originalScheduler = rt.schedulers.get(watch.watchId)!;
			expect(originalScheduler.isRunning).toBe(false); // not yet started

			// Simulate set-interval replacing the scheduler before the timeout fires.
			stopWatchPolling(rt, watch.watchId);
			startWatchPolling(rt, watch.watchId); // delayMs=0, starts immediately
			const replacementScheduler = rt.schedulers.get(watch.watchId)!;
			expect(replacementScheduler).not.toBe(originalScheduler);
			expect(replacementScheduler.isRunning).toBe(true);

			// After the original 50ms timeout fires, the original scheduler must NOT have started.
			await vi.advanceTimersByTimeAsync(100);
			expect(originalScheduler.isRunning).toBe(false); // ghost prevented
			expect(rt.schedulers.get(watch.watchId)).toBe(replacementScheduler);
			stopPolling(rt);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// triggerTurn
// ---------------------------------------------------------------------------

describe("pollWatch — triggerTurn on change events", () => {
	it("uses triggerTurn: true when a state change is detected", async () => {
		const pi = makePi();
		// Client returns SUCCEEDED; baseline is RUNNING — state change fires
		const client = makeClient(makeJobRunResponse("SUCCEEDED"));
		const rt = makeRuntime(pi, client);
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;

		await pollWatch(rt, watch.watchId);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [, opts] = pi.sendMessage.mock.calls[0] as [unknown, { triggerTurn?: boolean }];
		expect(opts.triggerTurn).toBe(true);
	});

	it("does NOT use triggerTurn: true when there is no state change", async () => {
		const pi = makePi();
		// Client returns RUNNING; baseline is RUNNING — no change
		const client = makeClient(makeJobRunResponse("RUNNING"));
		const rt = makeRuntime(pi, client);
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;

		await pollWatch(rt, watch.watchId);

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe("pollOnce — error classification", () => {

	function makeErrorClient(err: Error): GlueClient {
		return {
			getJobRun: vi.fn().mockRejectedValue(err),
			getWorkflowRun: vi.fn(),
		} as unknown as GlueClient;
	}

	it("appendEntry receives raw error for diagnostics; sendMessage gets sanitized string", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeErrorClient(
			Object.assign(new Error("session token expired — internal detail"), { name: "CredentialsProviderError" }),
		));
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		await pollOnce(rt);
		// appendEntry gets the raw message (useful for internal diagnostics)
		const entryArg = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { message: string };
		expect(entryArg.message).toContain("internal detail");
		// sendMessage (user-visible) is NOT called yet (threshold not reached)
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("sendMessage at threshold uses sanitized message, not raw error", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeErrorClient(
			Object.assign(new Error("session token expired — internal detail"), { name: "CredentialsProviderError" }),
		));
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		watch.consecutiveErrors = POLL_ERROR_THRESHOLD - 1;
		rt.watches[watch.watchId] = watch;
		await pollOnce(rt);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const content = (pi.sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).not.toContain("401");
		expect(content).toContain("authentication");
	});

	it("auth error triggers scheduler.noteBackoff", async () => {
		const rt = makeRuntime(
			makePi(),
			makeErrorClient(
				Object.assign(new Error("token expired — internal detail"), { name: "CredentialsProviderError" }),
			),
		);
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;
		startPolling(rt);
		const scheduler = rt.schedulers.get(watch.watchId)!;
		const initialInterval = scheduler.intervalMs;
		await pollWatch(rt, watch.watchId);
		expect(scheduler.intervalMs).toBeGreaterThan(initialInterval);
		stopPolling(rt);
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

// ---------------------------------------------------------------------------
// refreshStatus, toggleDisplayMode, minIntervalMs
// ---------------------------------------------------------------------------
import {
	minIntervalMs,
	refreshStatus,
	toggleDisplayMode,
} from "../src/runtime.js";

function makeRtWithUi() {
	const setStatusSpy = vi.fn();
	const rt = makeRuntime(
		{
			sendMessage: vi.fn(),
			appendEntry: vi.fn(),
			registerTool: vi.fn(),
			getActiveTools: vi.fn(() => [] as string[]),
			setActiveTools: vi.fn(),
			events: { emit: vi.fn(), on: vi.fn() },
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
		{} as unknown as import("../src/glue-client.js").GlueClient,
	);
	rt.ui = {
		setStatus: setStatusSpy,
		theme: { fg: (_c: string, t: string) => t },
	} satisfies NonNullable<typeof rt.ui>;
	return { rt, setStatusSpy };
}

describe("refreshStatus", () => {
	it("clears status when displayMode is not 'statusline'", () => {
		const { rt, setStatusSpy } = makeRtWithUi();
		rt.displayMode = "widget";
		refreshStatus(rt);
		expect(setStatusSpy).toHaveBeenCalledWith(expect.any(String), undefined);
	});

	it("sets a status string when displayMode is 'statusline' with no watches", () => {
		const { rt, setStatusSpy } = makeRtWithUi();
		rt.displayMode = "statusline";
		refreshStatus(rt);
		expect(setStatusSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String));
	});

	it("includes error indicator in status when a watch has consecutiveErrors >= threshold", () => {
		const { rt, setStatusSpy } = makeRtWithUi();
		rt.displayMode = "statusline";
		rt.watches["aa"] = {
			watchId: "aa",
			type: "job",
			name: "my-job",
			runId: "jr_1",
			profile: "p",
			region: undefined,
			addedAt: Date.now(),
			lastPolledAt: undefined,
			baseline: { state: "RUNNING", errorMessage: "" },
			terminal: false,
			consecutiveErrors: POLL_ERROR_THRESHOLD,
		};
		refreshStatus(rt);
		expect(setStatusSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String));
	});

	it("is a no-op when rt.ui is null", () => {
		const { rt, setStatusSpy } = makeRtWithUi();
		rt.ui = null;
		rt.displayMode = "statusline";
		expect(() => refreshStatus(rt)).not.toThrow();
		expect(setStatusSpy).not.toHaveBeenCalled();
	});
});

describe("toggleDisplayMode", () => {
	it("switches from widget to statusline and calls widget.hide + refreshStatus", () => {
		const { rt } = makeRtWithUi();
		const hideSpy = vi.fn();
		rt.widget = { hide: hideSpy, show: vi.fn() } as never;
		rt.displayMode = "widget";

		toggleDisplayMode(rt, {});

		expect(rt.displayMode).toBe("statusline");
		expect(hideSpy).toHaveBeenCalled();
	});

	it("switches from statusline to widget and calls widget.show", () => {
		const { rt, setStatusSpy } = makeRtWithUi();
		const showSpy = vi.fn();
		rt.widget = { hide: vi.fn(), show: showSpy } as never;
		rt.displayMode = "statusline";

		toggleDisplayMode(rt, {});

		expect(rt.displayMode).toBe("widget");
		expect(showSpy).toHaveBeenCalled();
		// When switching to widget, status is cleared
		expect(setStatusSpy).toHaveBeenCalledWith(expect.any(String), undefined);
	});

	it("works when widget is null (no-op on hide/show)", () => {
		const { rt } = makeRtWithUi();
		rt.widget = null;
		rt.displayMode = "widget";
		expect(() => toggleDisplayMode(rt, {})).not.toThrow();
		expect(rt.displayMode).toBe("statusline");
	});
});

describe("minIntervalMs", () => {
	it("returns POLL_INTERVAL_MS when no schedulers exist", () => {
		const rt = makeRuntime({} as never, {} as never);
		expect(minIntervalMs(rt)).toBe(POLL_INTERVAL_MS);
	});

	it("returns the minimum intervalMs across all schedulers", () => {
		const rt = makeRuntime({} as never, {} as never);
		rt.schedulers.set("a", { intervalMs: 30_000 } as never);
		rt.schedulers.set("b", { intervalMs: 10_000 } as never);
		rt.schedulers.set("c", { intervalMs: 60_000 } as never);
		expect(minIntervalMs(rt)).toBe(10_000);
	});

	it("returns POLL_INTERVAL_MS when all schedulers have Infinity intervalMs", () => {
		const rt = makeRuntime({} as never, {} as never);
		rt.schedulers.set("a", { intervalMs: Infinity } as never);
		expect(minIntervalMs(rt)).toBe(POLL_INTERVAL_MS);
	});
});

// ---------------------------------------------------------------------------
// pollWatch — workflow type and terminal events
// ---------------------------------------------------------------------------
import type { WorkflowRunResponse } from "../src/glue-client.js";

describe("pollWatch — workflow watch calls detectWorkflowChanges", () => {
	it("polls a workflow watch", async () => {
		const pi = makePi();
		const client: GlueClient = {
			getJobRun: vi.fn(),
			getWorkflowRun: vi.fn().mockResolvedValue({
				Run: {
					Status: "RUNNING",
					Statistics: { TotalActions: 2, SucceededActions: 0, FailedActions: 0, RunningActions: 2 },
					Graph: { Nodes: [] },
				},
			} satisfies WorkflowRunResponse),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn(),
			stopWorkflowRun: vi.fn(),
		};
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		const watch: GlueWatch = {
			watchId: "wf1",
			type: "workflow",
			name: "my-wf",
			runId: "wr_1",
			profile: "p",
			region: undefined,
			addedAt: 1000,
			lastPolledAt: undefined,
			baseline: { state: "RUNNING", totalActions: 2, succeededActions: 0, failedActions: 0, runningActions: 2, reportedFailedNodes: [], nodes: [] },
			terminal: false,
			consecutiveErrors: 0,
		};
		rt.watches["wf1"] = watch;

		await pollWatch(rt, "wf1");

		expect(client.getWorkflowRun).toHaveBeenCalled();
	});
});

describe("pollWatch — terminal event marks watch as terminal", () => {
	it("marks watch.terminal = true when a terminal event is detected", async () => {
		const pi = makePi();
		const client = makeClient(makeJobRunResponse("SUCCEEDED"));
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;

		await pollWatch(rt, watch.watchId);

		expect(watch.terminal).toBe(true);
	});
});

describe("pollWatch — recovery message on consecutive errors then success", () => {
	it("sends recovery message when consecutiveErrors >= threshold then succeeds", async () => {
		const pi = makePi();
		const client = makeClient(makeJobRunResponse("RUNNING"));
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		watch.consecutiveErrors = POLL_ERROR_THRESHOLD; // previously hit threshold
		rt.watches[watch.watchId] = watch;

		await pollWatch(rt, watch.watchId);

		const sendCalls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls as Array<[{ content: string }]>;
		const recovery = sendCalls.find(([msg]) => msg.content.includes("recovered"));
		expect(recovery).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage: delayed scheduler identity check passes (line 176)
// ---------------------------------------------------------------------------

describe("startWatchPolling — delayed scheduler starts when identity check passes", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("scheduler.start() is called inside setTimeout when the scheduler is still the current one (line 176)", async () => {
		const rt = makeRuntime(makePi(), makeClient(makeJobRunResponse("RUNNING")));
		rt.enabled = true;
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		rt.watches[watch.watchId] = watch;

		startWatchPolling(rt, watch.watchId, 50);
		const scheduler = rt.schedulers.get(watch.watchId)!;
		expect(scheduler.isRunning).toBe(false); // not yet started

		// Do NOT replace the scheduler — let the timeout fire with the original
		await vi.advanceTimersByTimeAsync(100);

		// The identity check passes: same scheduler still in the map → it must have started
		expect(scheduler.isRunning).toBe(true);
		stopPolling(rt);
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage: pollWatch paused / terminal branches (lines 226, 229-230)
// ---------------------------------------------------------------------------

describe("pollWatch — early-exit branches", () => {

	it("stops polling and returns when the watch is already terminal", async () => {
		const pi = makePi();
		const client = makeClient(makeJobRunResponse("SUCCEEDED"));
		const rt = makeRuntime(pi, client);
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		watch.terminal = true;
		rt.watches[watch.watchId] = watch;

		// Manually register a scheduler so stopWatchPolling has something to clean up
		startWatchPolling(rt, watch.watchId); // no-ops (terminal watch), so scheduler is not added
		// Call pollWatch directly — the !watch || watch.terminal branch stops and returns
		await pollWatch(rt, watch.watchId);

		// The client must not have been called (returned before the poll)
		expect(client.getJobRun).not.toHaveBeenCalled();
	});

	it("stops polling and returns when the watchId is absent from rt.watches", async () => {
		const pi = makePi();
		const client = makeClient(makeJobRunResponse("RUNNING"));
		const rt = makeRuntime(pi, client);

		await pollWatch(rt, "nonexistent-watch");

		expect(client.getJobRun).not.toHaveBeenCalled();
	});
});
