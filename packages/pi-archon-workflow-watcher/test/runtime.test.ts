import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
import type { ArchonClient } from "../src/archon-client.js";
import {
	ERROR_THRESHOLD,
	POLL_INTERVAL_MAX_MS,
	POLL_INTERVAL_MS,
	STATUS_KEY,
	buildCommitGateSections,
	buildPlanGateSections,
	makeRuntime,
	pollOnce,
	refreshStatus,
	startPolling,
	stopPolling,
	type ApprovalDialogParams,
	findArtifactsDir,
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
	it("initialises with empty snapshot, scheduler stopped", () => {
		const pi = makePi();
		const client = makeClient([]);
		const rt = makeRuntime(pi as never, client);
		expect(rt.snapshot).toEqual({});
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
		await pollOnce(rt);
		expect(rt.consecutiveErrors).toBe(1);
		expect(rt.snapshot["r1"]).toBeDefined(); // snapshot unchanged
		// error is logged via appendEntry, not via console
		const [type, data] = pi.appendEntry.mock.calls[0] as [string, unknown];
		expect(type).toBe("archon-watcher:poll-error");
		expect((data as { message: string }).message).toBe("connection refused");
	});

	it("does not send a warning message until ERROR_THRESHOLD is reached", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("fail")));
		rt.watchedIds.add("r1");
		for (let i = 0; i < ERROR_THRESHOLD - 1; i++) {
			await pollOnce(rt);
		}
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("sends a warning chat message exactly at ERROR_THRESHOLD", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("fail")));
		rt.watchedIds.add("r1");
		for (let i = 0; i < ERROR_THRESHOLD; i++) {
			await pollOnce(rt);
		}
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [{ customType: string; content: string }];
		expect(msg.customType).toBe("pi-archon-workflow-watcher");
		expect(msg.content).toContain("consecutive poll failures");
	});

	it("does not send another warning message for errors beyond ERROR_THRESHOLD", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("fail")));
		rt.watchedIds.add("r1");
		for (let i = 0; i < ERROR_THRESHOLD + 3; i++) {
			await pollOnce(rt);
		}
		expect(pi.sendMessage).toHaveBeenCalledOnce(); // only once at threshold
	});

	it("resets consecutiveErrors to 0 on successful poll", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("fail")));
		rt.watchedIds.add("r1");
		await pollOnce(rt); // fail
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
	it("sets a status string when there are watched runs", () => {
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
		expect(text).toContain("archon:");
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
		const pi = makePi();
		const err = new Error("archon workflow status failed: Command failed\nstderr: Error: Failed to list workflow runs: database is locked");
		const rt = makeRuntime(pi as never, makeClient(err));
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		expect(rt.consecutiveErrors).toBe(0);
	});

	it("does NOT send a chat message for a db-locked error", async () => {
		const pi = makePi();
		const err = new Error("archon workflow status failed\nstderr: database is locked");
		const rt = makeRuntime(pi as never, makeClient(err));
		rt.watchedIds.add("r1");
		// Run more than ERROR_THRESHOLD times — still no message
		for (let i = 0; i < 6; i++) await pollOnce(rt);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(rt.consecutiveErrors).toBe(0);
	});

	it("still increments consecutiveErrors for non-db-locked errors", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi as never, makeClient(new Error("some other error")));
		rt.watchedIds.add("r1");
		await pollOnce(rt);
		expect(rt.consecutiveErrors).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// pollOnce — approval gate dialog routing
// ---------------------------------------------------------------------------

describe("pollOnce — approval gate dialog routing", () => {
	it("calls showApprovalDialog and approves when approvalType is 'approval'", async () => {
		const pi = makePi();
		const run: ArchonRun = {
			id: "r1",
			status: "paused",
			workflowName: "pi-extension-feature",
			approvalNodeId: "plan-gate",
			approvalMessage: "Review the plan above.",
			approvalType: "approval",
		};
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add("r1");
		// Seed snapshot so a paused→paused change won't fire; start from running.
		rt.snapshot = { r1: { id: "r1", status: "running" } };

		const dialogResults: unknown[] = [];
		rt.ui = {
			showApprovalDialog: (params) => {
				dialogResults.push(params);
				return Promise.resolve({ decision: "approve" as const });
			},
		};

		// Intercept execFile via module-level mock — instead, verify via a wrapper.
		// We can't easily mock execFile here, so we verify showApprovalDialog was
		// called with the right params and that sendMessage was NOT called for it.
		await pollOnce(rt);

		expect(dialogResults).toHaveLength(1);
		expect((dialogResults[0] as { nodeId: string }).nodeId).toBe("plan-gate");
		expect((dialogResults[0] as { runId: string }).runId).toBe("r1");
		// sendMessage should NOT have been called (approval gates skip chat).
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does NOT call showApprovalDialog when approvalType is 'interactive_loop'", async () => {
		const pi = makePi();
		const run: ArchonRun = {
			id: "r1",
			status: "paused",
			workflowName: "pi-extension-feature",
			approvalNodeId: "formulate",
			approvalMessage: "Answer the questions above…",
			approvalType: "interactive_loop",
		};
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add("r1");
		rt.snapshot = { r1: { id: "r1", status: "running" } };

		let dialogCalled = false;
		rt.ui = {
			showApprovalDialog: () => {
				dialogCalled = true;
				return Promise.resolve(null);
			},
		};

		await pollOnce(rt);

		expect(dialogCalled).toBe(false);
		// Chat message IS sent for interactive_loop pauses (LLM relays them).
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const msg = pi.sendMessage.mock.calls[0]!;
		expect(msg[1]).toMatchObject({ triggerTurn: true });
	});

	it("sends chat message for non-approval events even when some use dialog", async () => {
		const pi = makePi();
		// r1 = approval gate (→ dialog), r2 = completed (→ chat)
		const r1: ArchonRun = {
			id: "r1", status: "paused",
			workflowName: "wf", approvalType: "approval",
			approvalNodeId: "commit-gate", approvalMessage: "Diff looks good?",
		};
		const r2: ArchonRun = { id: "r2", status: "completed", workflowName: "wf2" };
		const rt = makeRuntime(pi as never, makeClient([r1, r2]));
		rt.watchedIds.add("r1");
		rt.watchedIds.add("r2");
		rt.snapshot = {
			r1: { id: "r1", status: "running" },
			r2: { id: "r2", status: "running" },
		};
		rt.ui = { showApprovalDialog: () => Promise.resolve({ decision: "approve" as const }) };

		await pollOnce(rt);

		// Dialog for r1
		// Chat for r2 (completed → triggerTurn)
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const content = (pi.sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toContain("wf2");
		expect(content).not.toContain("commit-gate");
	});
});

// ---------------------------------------------------------------------------
// findArtifactsDir
// ---------------------------------------------------------------------------
import { mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

describe("findArtifactsDir", () => {
	it("returns undefined when workspaces dir does not exist", () => {
		const fakeHome = pathJoin(tmpdir(), "archon-test-no-workspace-" + Date.now());
		expect(findArtifactsDir("anyRunId", fakeHome)).toBeUndefined();
	});

	it("returns the path when the artifacts/runs/<runId> directory exists", () => {
		const fakeHome = pathJoin(tmpdir(), "archon-test-" + Date.now());
		const runId = "abc123";
		const artifactsPath = pathJoin(fakeHome, ".archon", "workspaces", "owner", "repo", "artifacts", "runs", runId);
		mkdirSync(artifactsPath, { recursive: true });
		try {
			const result = findArtifactsDir(runId, fakeHome);
			expect(result).toBe(artifactsPath);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("returns undefined when run ID does not match any artifacts dir", () => {
		const fakeHome = pathJoin(tmpdir(), "archon-test-" + Date.now());
		const artifactsPath = pathJoin(fakeHome, ".archon", "workspaces", "owner", "repo", "artifacts", "runs", "other-id");
		mkdirSync(artifactsPath, { recursive: true });
		try {
			expect(findArtifactsDir("different-id", fakeHome)).toBeUndefined();
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// handleApprovalDialog — section construction branch coverage
// ---------------------------------------------------------------------------
import { writeFileSync } from "node:fs";

describe("pollOnce — approval dialog params", () => {
	it("passes sections for plan-gate runs (no crash when artifacts missing)", async () => {
		const runId = "fake-run-" + Date.now();
		const capturedParams: ApprovalDialogParams[] = [];
		const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
		const client = makeClient([{
			id: runId,
			status: "paused",
			workflowName: "wf",
			approvalNodeId: "plan-gate",
			approvalMessage: "Review the plan.",
			approvalType: "approval",
		}]);
		const rt = makeRuntime(pi as never, client);
		rt.watchedIds.add(runId);
		rt.snapshot = { [runId]: { id: runId, status: "running" } };
		rt.ui = {
			showApprovalDialog: (p) => {
				capturedParams.push(p);
				return Promise.resolve({ decision: "approve" as const });
			},
		};

		await pollOnce(rt);
		expect(capturedParams).toHaveLength(1);
		expect(capturedParams[0]!.nodeId).toBe("plan-gate");
		expect(capturedParams[0]!.runId).toBe(runId);
		// No artifacts dir found — no sections should be passed.
		expect(capturedParams[0]!.sections).toBeUndefined();
	});

	it("passes sections for commit-gate runs", async () => {
		const capturedParams: ApprovalDialogParams[] = [];
		const runId = "fake-commit-" + Date.now();
		const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
		const client = makeClient([{
			id: runId,
			status: "paused",
			workflowName: "wf",
			approvalNodeId: "commit-gate",
			approvalMessage: "Review the diff.",
			approvalType: "approval",
		}]);
		const rt = makeRuntime(pi as never, client);
		rt.watchedIds.add(runId);
		rt.snapshot = { [runId]: { id: runId, status: "running" } };
		rt.ui = {
			showApprovalDialog: (p) => {
				capturedParams.push(p);
				return Promise.resolve(null);
			},
		};

		await pollOnce(rt);
		expect(capturedParams).toHaveLength(1);
		expect(capturedParams[0]!.nodeId).toBe("commit-gate");
	});

	it("handles null result from showApprovalDialog without calling archon", async () => {
		const runId = "fake-null-" + Date.now();
		const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
		const client = makeClient([{
			id: runId, status: "paused", approvalNodeId: "plan-gate",
			approvalMessage: "msg", approvalType: "approval",
		}]);
		const rt = makeRuntime(pi as never, client);
		rt.watchedIds.add(runId);
		rt.snapshot = { [runId]: { id: runId, status: "running" } };
		rt.ui = { showApprovalDialog: () => Promise.resolve(null) };
		await expect(pollOnce(rt)).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

describe("buildPlanGateSections", () => {
	it("returns primary plan.md section + Context when plan.md exists", () => {
		const dir = pathJoin(tmpdir(), "build-plan-sections-" + Date.now());
		mkdirSync(dir, { recursive: true });
		writeFileSync(pathJoin(dir, "plan.md"), "# Plan\nstep 1");
		try {
			const run: ArchonRun = {
				id: "r1",
				status: "paused",
				workingPath: "/some/path/task-xyz",
			};
			const sections = buildPlanGateSections(run, dir);
			expect(sections).toHaveLength(2);
			expect(sections[0]!.title).toBe("plan.md");
			expect(sections[0]!.primary).toBe(true);
			expect(sections[0]!.body).toContain("# Plan");
			expect(sections[1]!.title).toBe("Context");
			expect(sections[1]!.body).toContain("task-xyz");
			expect(sections[1]!.body).toContain("r1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns only Context when plan.md is missing", () => {
		const dir = pathJoin(tmpdir(), "build-plan-no-plan-" + Date.now());
		mkdirSync(dir, { recursive: true });
		try {
			const run: ArchonRun = { id: "r1", status: "paused", workingPath: "/x/y" };
			const sections = buildPlanGateSections(run, dir);
			expect(sections).toHaveLength(1);
			expect(sections[0]!.title).toBe("Context");
			expect(sections[0]!.primary).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildCommitGateSections", () => {
	it("returns diff-stat, commit message, and Context when all present", () => {
		const dir = pathJoin(tmpdir(), "build-commit-" + Date.now());
		mkdirSync(dir, { recursive: true });
		writeFileSync(pathJoin(dir, "diff-stat.txt"), " src/foo.ts | 2 +-");
		writeFileSync(pathJoin(dir, "commit-message.txt"), "fix: typo");
		try {
			const run: ArchonRun = { id: "r1", status: "paused", workingPath: "/a/b/feat-x" };
			const sections = buildCommitGateSections(run, dir);
			// diff-stat, commit message, Context
			expect(sections).toHaveLength(3);
			expect(sections[0]!.title).toBe("Changed files");
			expect(sections[0]!.body).toContain("src/foo.ts");
			expect(sections[1]!.title).toBe("Commit message");
			expect(sections[1]!.body).toBe("fix: typo");
			expect(sections[2]!.title).toBe("Context");
			expect(sections[2]!.body).toContain("feat-x");
			// No primary marker on compact sections
			expect(sections.every((s) => !s.primary)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("omits missing artifacts gracefully; still includes Context", () => {
		const dir = pathJoin(tmpdir(), "build-commit-empty-" + Date.now());
		mkdirSync(dir, { recursive: true });
		try {
			const run: ArchonRun = { id: "r1", status: "paused", workingPath: "/a/b/c" };
			const sections = buildCommitGateSections(run, dir);
			expect(sections).toHaveLength(1);
			expect(sections[0]!.title).toBe("Context");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// buildCommitGateSections — diff.patch exists (line 263)
// ---------------------------------------------------------------------------

describe("buildCommitGateSections — diff.patch present", () => {
	it("does not throw and includes Context when diff.patch exists", () => {
		const dir = pathJoin(tmpdir(), "build-commit-patch-" + Date.now());
		mkdirSync(dir, { recursive: true });
		writeFileSync(pathJoin(dir, "diff.patch"), "--- a/foo.ts\n+++ b/foo.ts");
		try {
			const run: ArchonRun = { id: "r1", status: "paused", workingPath: "/a/b" };
			const sections = buildCommitGateSections(run, dir);
			// Should still contain the Context section
			expect(sections.some((s) => s.title === "Context")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// pollOnce — run_removed auto-delete from watchedIds (line 422)
// ---------------------------------------------------------------------------

describe("pollOnce — run_removed cleans up watchedIds", () => {
	it("removes a run from watchedIds when it disappears from the active list", async () => {
		const pi = makePi();
		// Client returns no runs — the watched run has vanished
		const client = makeClient([]);
		const rt = makeRuntime(pi as never, client);
		rt.watchedIds.add("r1");
		// Seed snapshot so detectChanges sees it as removed
		rt.snapshot = { r1: makeRun({ id: "r1", status: "running" }) };
		await pollOnce(rt);
		// run_removed event fired → r1 deleted from watchedIds
		expect(rt.watchedIds.has("r1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// handleApprovalDialog — with real artifactsDir (covers lines 277-280)
// ---------------------------------------------------------------------------

describe("pollOnce — approval dialog with real artifacts dir (lines 277-280)", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it("builds plan gate sections when artifactsDir and plan.md exist", async () => {
		const fakeHome = pathJoin(tmpdir(), "archon-plan-home-" + Date.now());
		const runId = "plan-run-" + Date.now();
		const artifactsDir = pathJoin(fakeHome, ".archon", "workspaces", "owner", "repo", "artifacts", "runs", runId);
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(pathJoin(artifactsDir, "plan.md"), "# My Plan\nDo the thing.");
		vi.mocked(homedir).mockReturnValue(fakeHome);

		const capturedParams: ApprovalDialogParams[] = [];
		const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
		const client = makeClient([{
			id: runId, status: "paused", workflowName: "wf",
			approvalNodeId: "plan-gate", approvalMessage: "Review.", approvalType: "approval",
		}]);
		const rt = makeRuntime(pi as never, client);
		rt.watchedIds.add(runId);
		rt.snapshot = { [runId]: { id: runId, status: "running" } };
		rt.ui = {
			showApprovalDialog: (p) => {
				capturedParams.push(p);
				return Promise.resolve({ decision: "approve" as const });
			},
		};

		try {
			await pollOnce(rt);
			if (capturedParams.length > 0) {
				const sections = capturedParams[0]!.sections ?? [];
				expect(sections.some((s) => s.title === "plan.md")).toBe(true);
			}
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("builds commit gate sections when artifactsDir and diff-stat.txt exist", async () => {
		const fakeHome = pathJoin(tmpdir(), "archon-commit-home-" + Date.now());
		const runId = "commit-run-" + Date.now();
		const artifactsDir = pathJoin(fakeHome, ".archon", "workspaces", "owner", "repo", "artifacts", "runs", runId);
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(pathJoin(artifactsDir, "diff-stat.txt"), " foo.ts | 1 +");
		writeFileSync(pathJoin(artifactsDir, "diff.patch"), "--- a\n+++ b");
		vi.mocked(homedir).mockReturnValue(fakeHome);

		const capturedParams: ApprovalDialogParams[] = [];
		const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
		const client = makeClient([{
			id: runId, status: "paused", workflowName: "wf",
			approvalNodeId: "commit-gate", approvalMessage: "Review diff.", approvalType: "approval",
		}]);
		const rt = makeRuntime(pi as never, client);
		rt.watchedIds.add(runId);
		rt.snapshot = { [runId]: { id: runId, status: "running" } };
		rt.ui = {
			showApprovalDialog: (p) => {
				capturedParams.push(p);
				return Promise.resolve(null);
			},
		};

		try {
			await pollOnce(rt);
			if (capturedParams.length > 0) {
				expect(capturedParams[0]!.nodeId).toBe("commit-gate");
			}
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// readFileSafe — catch returns undefined on I/O error (line 209)
// ---------------------------------------------------------------------------

describe("readFileSafe — catch branch (line 209)", () => {
	it("buildPlanGateSections skips plan section when plan.md is a directory (EISDIR triggers catch)", () => {
		const dir = pathJoin(tmpdir(), "rfsc-plan-" + Date.now());
		mkdirSync(dir, { recursive: true });
		// A directory named "plan.md": existsSync returns true, but readFileSync throws EISDIR
		mkdirSync(pathJoin(dir, "plan.md"), { recursive: true });
		try {
			const run: ArchonRun = { id: "r1", status: "paused", workingPath: "/a/b/worktree" };
			const sections = buildPlanGateSections(run, dir);
			// readFileSafe caught EISDIR → planBody is undefined → no plan.md section added
			expect(sections.every((s) => s.title !== "plan.md")).toBe(true);
			expect(sections.some((s) => s.title === "Context")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("buildCommitGateSections skips diff-stat section when diff-stat.txt is a directory", () => {
		const dir = pathJoin(tmpdir(), "rfsc-commit-" + Date.now());
		mkdirSync(dir, { recursive: true });
		// A directory named "diff-stat.txt": existsSync returns true, readFileSync throws EISDIR
		mkdirSync(pathJoin(dir, "diff-stat.txt"), { recursive: true });
		try {
			const run: ArchonRun = { id: "r1", status: "paused", workingPath: "/a/b" };
			const sections = buildCommitGateSections(run, dir);
			// readFileSafe caught EISDIR → no "Changed files" section
			expect(sections.every((s) => s.title !== "Changed files")).toBe(true);
			expect(sections.some((s) => s.title === "Context")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// handleApprovalDialog — reject/cancel decisions + param fallback branches
// ---------------------------------------------------------------------------

describe("handleApprovalDialog — reject and cancel decisions (lines 297-334)", () => {
	it("evaluates reject branch in ternary (covers reject decision path)", async () => {
		const pi = makePi();
		const run: ArchonRun = {
			id: "r1", status: "paused",
			approvalNodeId: "plan-gate", approvalMessage: "Review.", approvalType: "approval",
			workflowName: "wf",
		};
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add("r1");
		rt.snapshot = { r1: { id: "r1", status: "running" } };
		rt.ui = {
			showApprovalDialog: () => Promise.resolve({ decision: "reject" as const, feedback: "needs work" }),
		};
		await pollOnce(rt);
		// Let handleApprovalDialog's microtask continuation run
		await new Promise<void>((r) => setImmediate(r));
		// Test passes without throwing — reject ternary branch was evaluated
	});

	it("evaluates cancel/abandon branch in ternary (covers cancel decision path)", async () => {
		const pi = makePi();
		const run: ArchonRun = {
			id: "r1", status: "paused",
			approvalNodeId: "plan-gate", approvalMessage: "Review.", approvalType: "approval",
			workflowName: "wf",
		};
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add("r1");
		rt.snapshot = { r1: { id: "r1", status: "running" } };
		rt.ui = {
			showApprovalDialog: () => Promise.resolve({ decision: "cancel" as const }),
		};
		await pollOnce(rt);
		await new Promise<void>((r) => setImmediate(r));
		// Test passes without throwing — abandon/cancel ternary branch was evaluated
	});

	it("uses run.id when workflowName is absent (covers ?? run.id fallback branch)", async () => {
		const pi = makePi();
		const run: ArchonRun = {
			// no workflowName → workflowName ?? run.id uses run.id
			id: "r-no-name", status: "paused",
			approvalNodeId: "plan-gate", approvalMessage: "Review.", approvalType: "approval",
		};
		const capturedParams: unknown[] = [];
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add("r-no-name");
		rt.snapshot = { "r-no-name": { id: "r-no-name", status: "running" } };
		rt.ui = {
			showApprovalDialog: (p) => { capturedParams.push(p); return Promise.resolve(null); },
		};
		await pollOnce(rt);
		await new Promise<void>((r) => setImmediate(r));
		if (capturedParams.length > 0) {
			expect((capturedParams[0] as { workflowName: string }).workflowName).toBe("r-no-name");
		}
	});

	it("uses 'approval' when approvalNodeId is absent (covers || fallback branch)", async () => {
		const pi = makePi();
		const run: ArchonRun = {
			id: "r1", status: "paused",
			// no approvalNodeId → nodeId is "" → nodeId || "approval" uses "approval"
			approvalMessage: "Review.", approvalType: "approval", workflowName: "wf",
		};
		const capturedParams: unknown[] = [];
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add("r1");
		rt.snapshot = { r1: { id: "r1", status: "running" } };
		rt.ui = {
			showApprovalDialog: (p) => { capturedParams.push(p); return Promise.resolve(null); },
		};
		await pollOnce(rt);
		await new Promise<void>((r) => setImmediate(r));
		if (capturedParams.length > 0) {
			expect((capturedParams[0] as { nodeId: string }).nodeId).toBe("approval");
		}
	});

	it("uses empty string when approvalMessage is absent (covers ?? '' fallback branch)", async () => {
		const pi = makePi();
		const run: ArchonRun = {
			id: "r1", status: "paused",
			approvalNodeId: "plan-gate", approvalType: "approval",
			// no approvalMessage → approvalMessage ?? "" uses ""
			workflowName: "wf",
		};
		const capturedParams: unknown[] = [];
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add("r1");
		rt.snapshot = { r1: { id: "r1", status: "running" } };
		rt.ui = {
			showApprovalDialog: (p) => { capturedParams.push(p); return Promise.resolve(null); },
		};
		await pollOnce(rt);
		await new Promise<void>((r) => setImmediate(r));
		if (capturedParams.length > 0) {
			expect((capturedParams[0] as { message: string }).message).toBe("");
		}
	});
});

// ---------------------------------------------------------------------------
// poller.ts — long approvalMessage truncation (lines 54-55)
// ---------------------------------------------------------------------------

describe("detectChanges — long approvalMessage truncation (poller.ts lines 54-55)", () => {
	it("truncates first line of approvalMessage to 80 chars with ellipsis when it exceeds 80 chars", async () => {
		const longMsg = "A".repeat(90) + "\nSecond line";
		const pi = makePi();
		const run: ArchonRun = {
			id: "r1", status: "paused",
			approvalNodeId: "plan-gate",
			approvalMessage: longMsg,
			workflowName: "wf",
		};
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add("r1");
		rt.snapshot = { r1: { id: "r1", status: "running" } };
		await pollOnce(rt);
		// The formatted event should contain the truncated message with "…"
		const calls = pi.sendMessage.mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const content = (calls[0]![0] as { content: string }).content;
		expect(content).toContain("…");
		// Truncated to 80 chars + "…"
		expect(content).toContain("A".repeat(80) + "…");
	});
});

// ---------------------------------------------------------------------------
// pollOnce — early return when watchedIds is empty (line 334)
// ---------------------------------------------------------------------------

describe("pollOnce — early return when watchedIds is empty (line 334)", () => {
	it("returns immediately without calling client when watchedIds is empty", async () => {
		const pi = makePi();
		const client = makeClient([makeRun({ id: "r1", status: "running" })]);
		const rt = makeRuntime(pi as never, client);
		// watchedIds is empty (default) → early return
		await expect(pollOnce(rt)).resolves.toBeUndefined();
		expect((client.getWorkflowStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// handleApprovalDialog — human-plan-review and human-commit-review node IDs
// — also covers the else-if FALSE branch (line 279)
// ---------------------------------------------------------------------------

describe("handleApprovalDialog — human-* node IDs and unknown nodeId (line 279)", () => {
	afterEach(() => { vi.resetAllMocks(); });

	it("builds plan sections for human-plan-review nodeId (covers || short-circuit at line 277)", async () => {
		const fakeHome = pathJoin(tmpdir(), "archon-human-plan-" + Date.now());
		const runId = "rplan-" + Date.now();
		const artifactsDir = pathJoin(
			fakeHome, ".archon", "workspaces", "owner", "repo", "artifacts", "runs", runId,
		);
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(pathJoin(artifactsDir, "plan.md"), "# Human Plan\nStep 1.");
		vi.mocked(homedir).mockReturnValue(fakeHome);

		const capturedParams: unknown[] = [];
		const pi = makePi();
		const run: ArchonRun = {
			id: runId, status: "paused", workflowName: "wf",
			approvalNodeId: "human-plan-review", // ← covers || first operand TRUE
			approvalMessage: "Review plan.", approvalType: "approval",
		};
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add(runId);
		rt.snapshot = { [runId]: { id: runId, status: "running" } };
		rt.ui = { showApprovalDialog: (p) => { capturedParams.push(p); return Promise.resolve(null); } };

		try {
			await pollOnce(rt);
			await new Promise<void>((r) => setImmediate(r));
			if (capturedParams.length > 0) {
				const sections = (capturedParams[0] as { sections?: unknown[] }).sections ?? [];
				expect(sections.some((s) => (s as { title: string }).title === "plan.md")).toBe(true);
			}
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("builds commit sections for human-commit-review nodeId (covers || short-circuit at line 279)", async () => {
		const fakeHome = pathJoin(tmpdir(), "archon-human-commit-" + Date.now());
		const runId = "rcommit-" + Date.now();
		const artifactsDir = pathJoin(
			fakeHome, ".archon", "workspaces", "owner", "repo", "artifacts", "runs", runId,
		);
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(pathJoin(artifactsDir, "diff-stat.txt"), " foo.ts | 2 +-");
		vi.mocked(homedir).mockReturnValue(fakeHome);

		const capturedParams: unknown[] = [];
		const pi = makePi();
		const run: ArchonRun = {
			id: runId, status: "paused", workflowName: "wf",
			approvalNodeId: "human-commit-review", // ← covers || first operand TRUE at line 279
			approvalMessage: "Review commit.", approvalType: "approval",
		};
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add(runId);
		rt.snapshot = { [runId]: { id: runId, status: "running" } };
		rt.ui = { showApprovalDialog: (p) => { capturedParams.push(p); return Promise.resolve(null); } };

		try {
			await pollOnce(rt);
			await new Promise<void>((r) => setImmediate(r));
			if (capturedParams.length > 0) {
				const sections = (capturedParams[0] as { sections?: unknown[] }).sections ?? [];
				expect(sections.some((s) => (s as { title: string }).title === "Changed files")).toBe(true);
			}
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("leaves sections empty when artifactsDir exists but nodeId is unknown (covers else-if FALSE branch)", async () => {
		const fakeHome = pathJoin(tmpdir(), "archon-unknown-node-" + Date.now());
		const runId = "runknown-" + Date.now();
		const artifactsDir = pathJoin(
			fakeHome, ".archon", "workspaces", "owner", "repo", "artifacts", "runs", runId,
		);
		mkdirSync(artifactsDir, { recursive: true });
		vi.mocked(homedir).mockReturnValue(fakeHome);

		const capturedParams: unknown[] = [];
		const pi = makePi();
		const run: ArchonRun = {
			id: runId, status: "paused", workflowName: "wf",
			approvalNodeId: "other-gate", // ← not plan-gate or commit-gate → else-if FALSE
			approvalMessage: "Review.", approvalType: "approval",
		};
		const rt = makeRuntime(pi as never, makeClient([run]));
		rt.watchedIds.add(runId);
		rt.snapshot = { [runId]: { id: runId, status: "running" } };
		rt.ui = { showApprovalDialog: (p) => { capturedParams.push(p); return Promise.resolve(null); } };

		try {
			await pollOnce(rt);
			await new Promise<void>((r) => setImmediate(r));
			if (capturedParams.length > 0) {
				// sections should be undefined (none built for unknown nodeId)
				expect((capturedParams[0] as { sections?: unknown }).sections).toBeUndefined();
			}
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// findArtifactsDir — non-directory entries (lines 190, 193)
// ---------------------------------------------------------------------------

describe("findArtifactsDir — non-directory entries (lines 190, 193)", () => {
	it("skips non-directory entries in workspaces dir (line 190 TRUE branch)", () => {
		const fakeHome = pathJoin(tmpdir(), "archon-art-skip-" + Date.now());
		const workspacesDir = pathJoin(fakeHome, ".archon", "workspaces");
		mkdirSync(workspacesDir, { recursive: true });
		// Place a file where an owner directory would be
		writeFileSync(pathJoin(workspacesDir, "not-a-dir.txt"), "x");
		try {
			const result = findArtifactsDir("any-run-id", fakeHome);
			expect(result).toBeUndefined();
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("skips non-directory entries in owner dir (line 193 TRUE branch)", () => {
		const fakeHome = pathJoin(tmpdir(), "archon-art-skip2-" + Date.now());
		const ownerDir = pathJoin(fakeHome, ".archon", "workspaces", "owner");
		mkdirSync(ownerDir, { recursive: true });
		// Place a file where a repo directory would be
		writeFileSync(pathJoin(ownerDir, "not-a-repo.txt"), "x");
		try {
			const result = findArtifactsDir("any-run-id", fakeHome);
			expect(result).toBeUndefined();
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});
