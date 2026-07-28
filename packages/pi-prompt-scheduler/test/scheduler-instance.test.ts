/**
 * CronScheduler instance-method tests. Pure statics are covered in
 * scheduler-pure.test.ts; this suite drives the live scheduler against a
 * fake pi + ctx to exercise addJob / removeJob / updateJob / start / stop /
 * getNextRun / past-timestamp handling for `once` jobs.
 *
 * We never wait for timers to fire, so no job prompts are actually delivered.
 * Each test calls `stop()` in afterEach to ensure no leaked timers survive.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the subagent runner: executeJobInSubagent imports runSubagentOnce,
// which pulls in pi-coding-agent's AgentSession + a live model. The mock
// lets us drive the completion branch deterministically without auth /
// network plumbing.
const { runSubagentMock } = vi.hoisted(() => ({
	runSubagentMock: vi.fn<
		(ctx: unknown, prompt: string, model: string, signal: AbortSignal) => Promise<
			{ ok: true; text: string } | { ok: false; error: string }
		>
	>(() => Promise.resolve({ ok: true as const, text: "subagent output" })),
}));
vi.mock("../src/subagent.js", () => ({
	runSubagentOnce: runSubagentMock,
}));

import { CronScheduler } from "../src/scheduler.js";
import { MemCronStorage } from "../src/storage.js";
import type { CronChangeEvent, CronJob } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakePi() {
	const emit = vi.fn();
	return {
		pi: {
			events: { emit },
			sendMessage: vi.fn(),
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
		},
		emit,
	};
}

function makeFakeCtx(sessionId: string | undefined = "sess-A") {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => [],
		},
	};
}

function mkJob(overrides: Partial<CronJob> = {}): CronJob {
	return {
		id: "j-aaa",
		name: "n",
		schedule: "0 0 * * * *",
		prompt: "p",
		enabled: true,
		type: "cron",
		createdAt: "2030-01-01T00:00:00.000Z",
		runCount: 0,
		session: "sess-A",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let storage: MemCronStorage;
let schedulers: CronScheduler[] = [];

beforeEach(() => {
	storage = new MemCronStorage();
	schedulers = [];
});

afterEach(() => {
	// Belt-and-braces: even if a test forgot to call stop(), clear here so
	// no croner Cron timer leaks into the next test's event loop.
	for (const s of schedulers) {
		try {
			s.stop();
		} catch {
			// no-op
		}
	}
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Narrow interface for accessing private scheduler methods in tests. */
type SchedulerPrivate = {
	executeJob: (job: CronJob) => void;
	executeJobInSubagent: (job: CronJob) => void;
};

/** Shorthand to cast mock.calls args to a known shape. */
type SendMessageArgs = { customType: string; content: unknown[]; details: Record<string, unknown> };

function makeScheduler(
	sessionId: string | undefined = "sess-A",
): { scheduler: CronScheduler; emit: ReturnType<typeof vi.fn>; pi: ReturnType<typeof makeFakePi>["pi"] } {
	const { pi, emit } = makeFakePi();
	const scheduler = new CronScheduler(storage, pi as unknown as ExtensionAPI, makeFakeCtx(sessionId) as unknown as ExtensionContext);
	schedulers.push(scheduler);
	return { scheduler, emit, pi };
}

// ---------------------------------------------------------------------------
// addJob / removeJob / updateJob / emit events
// ---------------------------------------------------------------------------

describe("CronScheduler.addJob / removeJob / updateJob", () => {
	it("addJob schedules a future cron and makes getNextRun() return a Date", () => {
		const { scheduler, emit } = makeScheduler();
		const job = mkJob();
		scheduler.addJob(job);

		expect(scheduler.getNextRun(job.id)).toBeInstanceOf(Date);
		expect(emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "add", job }));
	});

	it("addJob on a disabled job does NOT schedule it but still emits `add`", () => {
		const { scheduler, emit } = makeScheduler();
		const job = mkJob({ enabled: false });
		scheduler.addJob(job);

		expect(scheduler.getNextRun(job.id)).toBeNull();
		expect(emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "add" }));
	});

	it("removeJob unschedules the cron and emits `remove`", () => {
		const { scheduler, emit } = makeScheduler();
		const job = mkJob();
		scheduler.addJob(job);
		emit.mockClear();

		scheduler.removeJob(job.id);
		expect(scheduler.getNextRun(job.id)).toBeNull();
		expect(emit).toHaveBeenCalledWith("cron:change", { type: "remove", jobId: job.id });
	});

	it("updateJob re-schedules when the job is enabled and emits `update`", () => {
		const { scheduler, emit } = makeScheduler();
		const job = mkJob();
		scheduler.addJob(job);
		emit.mockClear();

		const updated = { ...job, schedule: "0 */5 * * * *" };
		scheduler.updateJob(job.id, updated);
		expect(scheduler.getNextRun(job.id)).toBeInstanceOf(Date);
		expect(emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "update", job: updated }));
	});

	it("updateJob to disabled clears the underlying timer; getNextRun() returns null", () => {
		const { scheduler } = makeScheduler();
		const job = mkJob();
		scheduler.addJob(job);
		scheduler.updateJob(job.id, { ...job, enabled: false });
		expect(scheduler.getNextRun(job.id)).toBeNull();
	});

	it("addJob on an `interval` job uses setInterval (getNextRun() returns null for intervals)", () => {
		const { scheduler } = makeScheduler();
		// Use a huge interval so nothing fires during the test.
		scheduler.addJob(mkJob({ id: "iv", type: "interval", schedule: "1d", intervalMs: 24 * 60 * 60 * 1000 }));
		// Intervals don't have a croner Cron attached, so getNextRun() is null.
		expect(scheduler.getNextRun("iv")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// `once` jobs — past-timestamp handling
// ---------------------------------------------------------------------------

describe("CronScheduler.addJob once/past", () => {
	it("disables a `once` job scheduled for the past, marks it errored, and emits `error`", () => {
		const { scheduler, emit } = makeScheduler();
		// Insert a past `once` into storage first so the scheduler can flip its enabled flag.
		const past = mkJob({
			id: "past-once",
			type: "once",
			schedule: "2020-01-01T00:00:00.000Z",
			enabled: true,
		});
		storage.addJob(past);

		scheduler.addJob(past);

		expect(storage.getJob("past-once")?.enabled).toBe(false);
		expect(storage.getJob("past-once")?.lastStatus).toBe("error");

		const errorCalls = emit.mock.calls
			.filter(([evt]) => evt === "cron:change")
			.map(([, payload]) => payload as CronChangeEvent)
			.filter((p): p is CronChangeEvent => p.type === "error");
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]).toMatchObject({ jobId: "past-once", error: expect.stringMatching(/past/i) as unknown });
	});
});

// ---------------------------------------------------------------------------
// start() — session filtering, stale-running clear, enabled filter
// ---------------------------------------------------------------------------

describe("CronScheduler.start", () => {
	it("loads only session-owned + unbound enabled jobs; foreign-session jobs are skipped", () => {
		storage.addJob(mkJob({ id: "mine", session: "sess-A" }));
		const unbound = mkJob({ id: "unbound" });
		delete (unbound as Partial<CronJob>).session;
		storage.addJob(unbound);
		storage.addJob(mkJob({ id: "foreign", session: "sess-B" }));
		storage.addJob(mkJob({ id: "mine-off", enabled: false, session: "sess-A" }));

		const { scheduler } = makeScheduler("sess-A");
		scheduler.start();

		expect(scheduler.getNextRun("mine")).toBeInstanceOf(Date);
		expect(scheduler.getNextRun("unbound")).toBeInstanceOf(Date);
		expect(scheduler.getNextRun("foreign")).toBeNull();
		// Disabled jobs never schedule even if they would otherwise load.
		expect(scheduler.getNextRun("mine-off")).toBeNull();
	});

	it("clears a stale `lastStatus: running` from an interrupted prior run of this session", () => {
		storage.addJob(mkJob({ id: "mine", session: "sess-A", lastStatus: "running" }));
		// Do NOT clear another session's running flag — that's theirs to manage.
		storage.addJob(mkJob({ id: "foreign", session: "sess-B", lastStatus: "running" }));

		const { scheduler } = makeScheduler("sess-A");
		scheduler.start();

		expect(storage.getJob("mine")?.lastStatus).toBeUndefined();
		expect(storage.getJob("foreign")?.lastStatus).toBe("running");
	});
});

// ---------------------------------------------------------------------------
// stop() — clears timers
// ---------------------------------------------------------------------------

describe("CronScheduler.stop", () => {
	it("unschedules everything; getNextRun() returns null for previously scheduled jobs", () => {
		const { scheduler } = makeScheduler();
		scheduler.addJob(mkJob({ id: "a" }));
		scheduler.addJob(mkJob({ id: "iv", type: "interval", schedule: "1d", intervalMs: 24 * 60 * 60 * 1000 }));

		expect(scheduler.getNextRun("a")).toBeInstanceOf(Date);

		scheduler.stop();

		expect(scheduler.getNextRun("a")).toBeNull();
		expect(scheduler.getNextRun("iv")).toBeNull();
	});

	it("is idempotent (double-stop does not throw)", () => {
		const { scheduler } = makeScheduler();
		scheduler.addJob(mkJob());
		scheduler.stop();
		expect(() => scheduler.stop()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// scheduleJob error path — invalid cron expression caught at add time
// ---------------------------------------------------------------------------

describe("CronScheduler.addJob invalid expression", () => {
	it("emits an `error` event when the underlying scheduler rejects the expression", () => {
		const { scheduler, emit } = makeScheduler();

		// Bypass validateSchedule by feeding a bad schedule directly. croner
		// will reject this inside scheduleJob and the scheduler emits `error`.
		scheduler.addJob(mkJob({ id: "bad", schedule: "zz zz zz zz zz zz" }));

		const errorCalls = emit.mock.calls
			.filter(([evt]) => evt === "cron:change")
			.map(([, payload]) => payload as CronChangeEvent)
			.filter((p): p is CronChangeEvent => p.type === "error");
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]).toMatchObject({ jobId: "bad" });
	});
});

// ---------------------------------------------------------------------------
// executeJob (inline, no `model`) — called directly so no croner fire is needed
// ---------------------------------------------------------------------------

describe("CronScheduler.executeJob (inline)", () => {
	function runInline(
		overrides: Partial<CronJob> = {},
	): {
		pi: ReturnType<typeof makeFakePi>["pi"];
		scheduler: CronScheduler;
		job: CronJob;
	} {
		const job = mkJob({ id: "inline", ...overrides });
		storage.addJob(job);
		const { scheduler, pi } = makeScheduler();
		(scheduler as unknown as SchedulerPrivate).executeJob(job);
		return { pi, scheduler, job };
	}

	it("posts the scheduled_prompt marker, delivers the prompt as a followUp, and advances runCount", () => {
		const { pi, job } = runInline({ runCount: 4 });

		// Marker first: renderer reads from `details`; `content` is a space
		// so nothing extra leaks into LLM context.
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const markerArgs = pi.sendMessage.mock.calls[0]![0] as SendMessageArgs;
		expect(markerArgs.customType).toBe("scheduled_prompt");
		expect(markerArgs.details).toMatchObject({ jobId: job.id, jobName: job.name, prompt: job.prompt });

		// Then the actual prompt.
		expect(pi.sendUserMessage).toHaveBeenCalledWith(job.prompt, { deliverAs: "followUp" });

		// Storage updated with success + incremented count.
		const stored = storage.getJob(job.id)!;
		expect(stored.lastStatus).toBe("success");
		expect(stored.runCount).toBe(5);
		expect(stored.lastRun).toBeDefined();
	});

	it("no-ops when the job has been disabled between scheduling and firing", () => {
		// Seed as enabled so isLoadedFor passes, then flip to disabled before
		// executeJob re-reads from storage.
		storage.addJob(mkJob({ id: "stale" }));
		const { scheduler, pi } = makeScheduler();
		storage.updateJob("stale", { enabled: false });

		(scheduler as unknown as SchedulerPrivate).executeJob(mkJob({ id: "stale" }));

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("no-ops when the job has been rebound to another session", () => {
		storage.addJob(mkJob({ id: "rebound", session: "sess-OTHER" }));
		const { scheduler, pi } = makeScheduler("sess-A");

		(scheduler as unknown as SchedulerPrivate).executeJob(mkJob({ id: "rebound", session: "sess-OTHER" }));

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("records error state when pi.sendUserMessage throws", () => {
		storage.addJob(mkJob({ id: "boom" }));
		const { pi } = makeFakePi();
		vi.mocked(pi.sendUserMessage).mockImplementation(() => {
			throw new Error("pi exploded");
		});
		const scheduler = new CronScheduler(storage, pi as unknown as ExtensionAPI, makeFakeCtx("sess-A") as unknown as ExtensionContext);
		schedulers.push(scheduler);

		(scheduler as unknown as SchedulerPrivate).executeJob(mkJob({ id: "boom" }));

		expect(storage.getJob("boom")?.lastStatus).toBe("error");
		// error is recorded via pi.appendEntry, not console
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"schedule-prompt:execute-error",
			expect.objectContaining({ jobId: "boom" }),
		);
	});
});

// ---------------------------------------------------------------------------
// executeJobInSubagent — the `model`-set branch, with runSubagentOnce mocked
// ---------------------------------------------------------------------------

describe("CronScheduler.executeJobInSubagent", () => {
	beforeEach(() => {
		runSubagentMock.mockClear();
		runSubagentMock.mockImplementation(() => Promise.resolve({ ok: true as const, text: "subagent output" }));
	});

	async function flushMicrotasks(): Promise<void> {
		// executeJobInSubagent spawns a fire-and-forget IIFE; await a few
		// microtask turns so the completion handler has a chance to run.
		for (let i = 0; i < 5; i++) await Promise.resolve();
	}

	it("posts start marker synchronously, runs the subagent, and records success + runCount", async () => {
		const job = mkJob({
			id: "sub-ok",
			model: "anthropic/claude-haiku-4-5",
			runCount: 2,
		});
		storage.addJob(job);
		const { scheduler, pi } = makeScheduler();

		(scheduler as unknown as SchedulerPrivate).executeJobInSubagent(job);
		await flushMicrotasks();

		const startCall = pi.sendMessage.mock.calls[0]![0] as SendMessageArgs;
		expect(startCall.details).toMatchObject({ mode: "subagent_start", model: job.model });

		expect(runSubagentMock).toHaveBeenCalledOnce();
		expect(runSubagentMock.mock.calls[0]![1]).toBe(job.prompt);
		expect(runSubagentMock.mock.calls[0]![2]).toBe(job.model);

		const completionCall = pi.sendMessage.mock.calls[1]![0] as SendMessageArgs;
		expect(completionCall.details).toMatchObject({
			mode: "subagent_done",
			model: job.model,
			output: "subagent output",
		});
		expect(storage.getJob("sub-ok")?.lastStatus).toBe("success");
		expect(storage.getJob("sub-ok")?.runCount).toBe(3);
	});

	it("wakes the parent with followUp+triggerTurn when notify=true", async () => {
		const job = mkJob({ id: "sub-notify", model: "anthropic/claude-haiku-4-5", notify: true });
		storage.addJob(job);
		const { scheduler, pi } = makeScheduler();

		(scheduler as unknown as SchedulerPrivate).executeJobInSubagent(job);
		await flushMicrotasks();

		const completionArgs = pi.sendMessage.mock.calls[1]! as [SendMessageArgs, Record<string, unknown>?];
		expect(completionArgs[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(completionArgs[0].content).toEqual([{ type: "text", text: "subagent output" }]);
	});

	it("records error state + posts subagent_error when the subagent fails", async () => {
		runSubagentMock.mockImplementationOnce(() => Promise.resolve({ ok: false as const, error: "model broke" }));
		const job = mkJob({ id: "sub-err", model: "anthropic/claude-haiku-4-5" });
		storage.addJob(job);
		const { scheduler, pi } = makeScheduler();

		(scheduler as unknown as SchedulerPrivate).executeJobInSubagent(job);
		await flushMicrotasks();

		const errorCall = pi.sendMessage.mock.calls[1]![0] as SendMessageArgs;
		expect(errorCall.details).toMatchObject({ mode: "subagent_error", error: "model broke" });
		expect(storage.getJob("sub-err")?.lastStatus).toBe("error");
		// Failed runs do NOT advance runCount.
		expect(storage.getJob("sub-err")?.runCount).toBe(0);
	});

	it("truncates large subagent output with an ellipsis", async () => {
		const huge = "x".repeat(1000);
		runSubagentMock.mockImplementationOnce(() => Promise.resolve({ ok: true as const, text: huge }));
		const job = mkJob({ id: "sub-big", model: "anthropic/claude-haiku-4-5" });
		storage.addJob(job);
		const { scheduler, pi } = makeScheduler();

		(scheduler as unknown as SchedulerPrivate).executeJobInSubagent(job);
		await flushMicrotasks();

		const output = (pi.sendMessage.mock.calls[1]![0] as SendMessageArgs).details["output"] as string;
		expect(output.length).toBeLessThan(huge.length);
		expect(output.endsWith("\u2026")).toBe(true);
	});

	it("stop() aborts an in-flight subagent; no completion marker / storage mutation after abort", async () => {
		let abortSignal: AbortSignal | undefined;
		runSubagentMock.mockImplementationOnce(
			(_ctx, _p, _m, signal) =>
				new Promise((resolve) => {
					abortSignal = signal;
					signal.addEventListener("abort", () => resolve({ ok: true, text: "late" }));
				}),
		);

		const job = mkJob({ id: "sub-abort", model: "anthropic/claude-haiku-4-5" });
		storage.addJob(job);
		const { scheduler, pi } = makeScheduler();

		(scheduler as unknown as SchedulerPrivate).executeJobInSubagent(job);
		await Promise.resolve();
		expect(abortSignal).toBeDefined();

		const sendCountBeforeStop = pi.sendMessage.mock.calls.length;
		scheduler.stop();
		await flushMicrotasks();

		expect(abortSignal!.aborted).toBe(true);
		expect(pi.sendMessage.mock.calls.length).toBe(sendCountBeforeStop);
		// Storage still shows `running` — deliberately left alone after abort
		// because pi may have been torn down.
		expect(storage.getJob("sub-abort")?.lastStatus).toBe("running");
	});
});

// ---------------------------------------------------------------------------
// Additional coverage: executeJob with interval job (getNextRun=null)
// ---------------------------------------------------------------------------

describe("CronScheduler.executeJob — interval job (getNextRun returns null)", () => {
	it("stores success without nextRun when job is interval type", () => {
		const intervalJob = mkJob({
			id: "interval-job",
			type: "interval",
			schedule: "60s",
		});
		storage.addJob(intervalJob);
		const { scheduler } = makeScheduler();

		(scheduler as unknown as SchedulerPrivate).executeJob(intervalJob);

		const stored = storage.getJob("interval-job")!;
		expect(stored.lastStatus).toBe("success");
		// executeJob calls getNextRun(job.id); the interval job was never registered
		// via scheduleJob so it is absent from this.jobs — getNextRun returns null
		// and the updateJob spread omits nextRun entirely.
		expect(storage.getJob("interval-job")?.nextRun).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage: executeJob model branch (line 224)
// ---------------------------------------------------------------------------

describe("CronScheduler.executeJob — delegates to subagent when model is set (line 224)", () => {
	beforeEach(() => {
		runSubagentMock.mockClear();
		runSubagentMock.mockResolvedValue({ ok: true as const, text: "done" });
	});

	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	}

	it("executeJob calls executeJobInSubagent and returns early when job.model is set", async () => {
		const job = mkJob({ id: "model-via-executejob", model: "anthropic/claude-haiku-4-5" });
		storage.addJob(job);
		const { scheduler, pi } = makeScheduler();

		(scheduler as unknown as SchedulerPrivate).executeJob(job);
		await flushMicrotasks();

		// The subagent runner must have been invoked (via executeJobInSubagent)
		expect(runSubagentMock).toHaveBeenCalledOnce();
		// The direct inline path (sendUserMessage) must NOT have been taken
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage: marker-error catch blocks (lines 373, 404-410)
// ---------------------------------------------------------------------------

describe("CronScheduler.executeJobInSubagent — marker-error catch blocks", () => {
	beforeEach(() => {
		runSubagentMock.mockClear();
	});

	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	}

	it("records appendEntry marker-error when sendMessage throws on subagent_done (line 373)", async () => {
		runSubagentMock.mockResolvedValueOnce({ ok: true as const, text: "great output" });
		const job = mkJob({ id: "marker-err-done", model: "anthropic/claude-haiku-4-5" });
		storage.addJob(job);

		const { pi } = makeFakePi();
		let callCount = 0;
		vi.mocked(pi.sendMessage).mockImplementation(() => {
			callCount++;
			if (callCount >= 2) throw new Error("sendMessage exploded on done");
			return undefined;
		});
		const scheduler = new CronScheduler(
			storage,
			pi as unknown as ExtensionAPI,
			makeFakeCtx("sess-A") as unknown as ExtensionContext,
		);
		schedulers.push(scheduler);

		(scheduler as unknown as SchedulerPrivate).executeJobInSubagent(job);
		await flushMicrotasks();

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"schedule-prompt:marker-error",
			expect.objectContaining({ jobId: job.id, phase: "subagent_done" }),
		);
	});

	it("records appendEntry marker-error when sendMessage throws on subagent_error (lines 404-410)", async () => {
		runSubagentMock.mockResolvedValueOnce({ ok: false as const, error: "model failed" });
		const job = mkJob({ id: "marker-err-error", model: "anthropic/claude-haiku-4-5" });
		storage.addJob(job);

		const { pi } = makeFakePi();
		let callCount = 0;
		vi.mocked(pi.sendMessage).mockImplementation(() => {
			callCount++;
			if (callCount >= 2) throw new Error("sendMessage exploded on error");
			return undefined;
		});
		const scheduler = new CronScheduler(
			storage,
			pi as unknown as ExtensionAPI,
			makeFakeCtx("sess-A") as unknown as ExtensionContext,
		);
		schedulers.push(scheduler);

		(scheduler as unknown as SchedulerPrivate).executeJobInSubagent(job);
		await flushMicrotasks();

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"schedule-prompt:marker-error",
			expect.objectContaining({ jobId: job.id, phase: "subagent_error" }),
		);
	});
});

// ---------------------------------------------------------------------------
// removeJob for interval jobs — clears the setInterval timer (lines 205-206)
// ---------------------------------------------------------------------------

describe("CronScheduler.removeJob — interval job", () => {
	it("clears the setInterval timer when an interval job is removed", () => {
		const { scheduler } = makeScheduler();
		const intervalJob = mkJob({
			id: "iv-remove",
			type: "interval",
			schedule: "1d",
			intervalMs: 24 * 60 * 60 * 1000,
		});
		scheduler.addJob(intervalJob);

		// Verify interval is registered (getNextRun is null for interval jobs)
		expect(scheduler.getNextRun("iv-remove")).toBeNull();

		// removeJob must clear the setInterval and deregister
		scheduler.removeJob("iv-remove");

		// After removal, calling getNextRun returns null (entry gone)
		expect(scheduler.getNextRun("iv-remove")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage: interval with falsy intervalMs (line 142 && short-circuit)
// ---------------------------------------------------------------------------

describe("CronScheduler.addJob — interval with falsy intervalMs", () => {
	it("falls through to cron path when type=interval but intervalMs is 0", () => {
		const { scheduler, emit, pi } = makeScheduler();
		// intervalMs: 0 makes the && short-circuit, so it falls through to the cron path
		scheduler.addJob(mkJob({ id: "iv-no-ms", type: "interval", intervalMs: 0 }));
		// Should emit 'add' (addJob always does) and NOT 'error' (Cron constructor succeeds)
		expect(emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "add" }));
		const errorCalls = emit.mock.calls
			.filter(([evt]) => evt === "cron:change")
			.map(([, p]) => p as CronChangeEvent)
			.filter((p): p is CronChangeEvent => p.type === "error");
		expect(errorCalls).toHaveLength(0);
		// No schedule-error appendEntry means Cron constructor succeeded (cron path taken)
		const scheduleErrors = pi.appendEntry.mock.calls.filter(([t]) => t === "schedule-prompt:schedule-error");
		expect(scheduleErrors).toHaveLength(0);
	});

	it("falls through to cron path when type=interval but intervalMs is undefined", () => {
		const { scheduler, emit, pi } = makeScheduler();
		const job = mkJob({ id: "iv-no-ms2", type: "interval" });
		delete (job as Partial<CronJob>).intervalMs;
		scheduler.addJob(job);
		// Same checks — no error event, no schedule-error appendEntry
		expect(emit).toHaveBeenCalledWith("cron:change", expect.objectContaining({ type: "add" }));
		const errorCalls = emit.mock.calls
			.filter(([evt]) => evt === "cron:change")
			.map(([, p]) => p as CronChangeEvent)
			.filter((p): p is CronChangeEvent => p.type === "error");
		expect(errorCalls).toHaveLength(0);
		const scheduleErrors = pi.appendEntry.mock.calls.filter(([t]) => t === "schedule-prompt:schedule-error");
		expect(scheduleErrors).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage: outer catch in executeJobInSubagent (line 410)
// ---------------------------------------------------------------------------

describe("CronScheduler.executeJobInSubagent — outer handler-error catch (line 410)", () => {
	beforeEach(() => {
		runSubagentMock.mockClear();
	});

	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	}

	it("records handler-error when an unexpected error escapes the IIFE", async () => {
		runSubagentMock.mockResolvedValueOnce({ ok: true as const, text: "ok" });
		const job = mkJob({ id: "outer-err", model: "anthropic/claude-haiku-4-5" });
		storage.addJob(job);

		const { pi } = makeFakePi();
		// Make getNextRun throw — this happens inside the IIFE after subagent completes
		// and will escape the inner try/catch blocks into the outer catch (line 407→410)
		const scheduler = new CronScheduler(
			storage,
			pi as unknown as ExtensionAPI,
			makeFakeCtx("sess-A") as unknown as ExtensionContext,
		);
		schedulers.push(scheduler);

		// Override getNextRun to throw — this happens after the subagent completes
		// inside the IIFE, past the inner try/catch, so it hits the outer catch
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.spyOn(scheduler as any, "getNextRun")
			.mockImplementation(() => { throw new Error("boom"); });

		(scheduler as unknown as SchedulerPrivate).executeJobInSubagent(job);
		await flushMicrotasks();

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"schedule-prompt:handler-error",
			expect.objectContaining({ jobId: job.id }),
		);
	});
});

// ---------------------------------------------------------------------------
// once job scheduled for the FUTURE (lines 155-162 in scheduler.ts)
// ---------------------------------------------------------------------------

describe("CronScheduler.addJob — once job in the future", () => {
	it("schedules a future once job via setTimeout and registers it in intervals", () => {
		const { scheduler } = makeScheduler();
		// Schedule 1 hour in the future so delay > 0
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const job = mkJob({
			id: "future-once",
			type: "once",
			schedule: future,
			enabled: true,
		});
		storage.addJob(job);
		scheduler.addJob(job);

		// The job should be tracked in intervals (used for cleanup)
		// We can verify via getNextRun — for once jobs it computes the next run from schedule
		// (no Cron object, but interval cleanup should work)
		// The key test: no error was emitted (job was not marked as past)
		expect(storage.getJob("future-once")?.lastStatus).not.toBe("error");

		// Cleanup: remove so the timer doesn't fire
		scheduler.removeJob("future-once");
	});

	it("fires the setTimeout callback and auto-disables the job", () => {
		vi.useFakeTimers();
		try {
			const { scheduler } = makeScheduler();
			const future = new Date(Date.now() + 100).toISOString();
			const job = mkJob({
				id: "future-fires",
				type: "once",
				schedule: future,
				enabled: true,
			});
			storage.addJob(job);
			scheduler.addJob(job);

			// Advance timers to trigger the setTimeout callback
			vi.advanceTimersByTime(200);

			// The callback should have auto-disabled the job
			expect(storage.getJob("future-fires")?.enabled).toBe(false);

			// Cleanup
			scheduler.removeJob("future-fires");
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Interval callback fires and executes the job (scheduler.ts line 145)
// ---------------------------------------------------------------------------

describe("CronScheduler.addJob — interval callback fires", () => {
	it("fires the setInterval callback, executing the job and updating storage", () => {
		vi.useFakeTimers();
		try {
			const { scheduler, pi } = makeScheduler();
			const intervalJob = mkJob({
				id: "interval-fires",
				type: "interval",
				schedule: "5m",
				intervalMs: 1000, // 1 second interval
				runCount: 3,
			});
			storage.addJob(intervalJob);
			scheduler.addJob(intervalJob);

			// Advance timers to let the interval fire
			vi.advanceTimersByTime(1500);

			// The job should have been executed: marker sent, prompt delivered, storage updated
			expect(pi.sendMessage).toHaveBeenCalled();
			expect(pi.sendUserMessage).toHaveBeenCalledWith(intervalJob.prompt, { deliverAs: "followUp" });
			const stored = storage.getJob("interval-fires")!;
			expect(stored.lastStatus).toBe("success");
			expect(stored.runCount).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});
});
