import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ArchonClient } from "../src/archon-client.js";
import { makeRuntime } from "../src/runtime.js";
import {
	handleToolAction,
	registerToolIfNeeded,
	resetToolRegisteredForTests,
} from "../src/tool.js";
import type { ArchonRun, RunSnapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRun(
	overrides: Partial<ArchonRun> & { id: string; status: string },
): ArchonRun {
	const run: ArchonRun = { id: overrides.id, status: overrides.status };
	if (overrides.workflowName !== undefined)
		run.workflowName = overrides.workflowName;
	if (overrides.workingPath !== undefined) run.workingPath = overrides.workingPath;
	return run;
}

function makeClient(
	runsOrError: ArchonRun[] | Error,
): ArchonClient {
	return {
		getWorkflowStatus: vi.fn(() => {
			if (runsOrError instanceof Error) throw runsOrError;
			return Promise.resolve(runsOrError);
		}),
	};
}

function makePi() {
	let activeTools: string[] = [];
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((tools: string[]) => {
			activeTools = tools;
		}),
		registerTool: vi.fn(),
	};
}

function makeRt(runs: ArchonRun[] | Error, snapshot: RunSnapshot = {}) {
	const pi = makePi();
	const client = makeClient(runs);
	const rt = makeRuntime(pi as never, client);
	rt.snapshot = snapshot;
	return { rt, pi, client };
}

// ---------------------------------------------------------------------------
// status action
// ---------------------------------------------------------------------------

describe("handleToolAction — status", () => {
	it("returns 'no runs being watched' when watchedIds is empty", async () => {
		const { rt, pi } = makeRt([]);
		const result = await handleToolAction(rt, { action: "status" }, pi);
		expect(result.details.ok).toBe(true);
		expect(result.details.action).toBe("status");
		expect(result.content[0]!.text).toContain("no runs being watched");
	});

	it("returns formatted run list when runs are watched", async () => {
		const run = makeRun({
			id: "r1",
			status: "running",
			workflowName: "archon-assist",
			workingPath: "/repo/feat-foo",
		});
		const { rt, pi } = makeRt([run], { r1: run });
		rt.watchedIds.add("r1");
		const result = await handleToolAction(rt, { action: "status" }, pi);
		expect(result.details.ok).toBe(true);
		expect(result.content[0]!.text).toContain("archon-assist");
		expect(result.content[0]!.text).toContain("running");
	});

	it("'add' returns error when runId is missing", async () => {
		const { rt, pi } = makeRt([]);
		const result = await handleToolAction(rt, { action: "add" }, pi);
		expect(result.details.ok).toBe(false);
		expect(result.content[0]!.text).toContain("requires a runId");
	});

	it("'add' adds runId to watchedIds and seeds snapshot from client", async () => {
		vi.useFakeTimers();
		const run = makeRun({ id: "r1", status: "running", workflowName: "my-wf" });
		const { rt, pi } = makeRt([run]);
		const result = await handleToolAction(rt, { action: "add", runId: "r1" }, pi);
		expect(result.details.ok).toBe(true);
		expect(result.content[0]!.text).toContain("watching");
		expect(rt.watchedIds.has("r1")).toBe(true);
		expect(rt.snapshot["r1"]).toBeDefined();
		// timer started
		expect(rt.scheduler.isRunning).toBe(true);
		rt.scheduler.stop();
		vi.useRealTimers();
	});

	it("'add' is idempotent — ok when already watching", async () => {
		const { rt, pi } = makeRt([]);
		rt.watchedIds.add("r1");
		const result = await handleToolAction(rt, { action: "add", runId: "r1" }, pi);
		expect(result.details.ok).toBe(true);
		expect(result.content[0]!.text).toContain("already watching");
	});

	it("does not mutate rt.snapshot", async () => {
		const existing = makeRun({ id: "old", status: "paused" });
		const { rt, pi } = makeRt(
			[makeRun({ id: "new", status: "running" })],
			{ old: existing },
		);
		// watchedIds is empty → status returns early without touching snapshot
		await handleToolAction(rt, { action: "status" }, pi);
		expect(Object.keys(rt.snapshot)).toEqual(["old"]);
	});
});

// ---------------------------------------------------------------------------
// remove action
// ---------------------------------------------------------------------------

describe("handleToolAction — remove", () => {
	it("returns error when runId is missing", async () => {
		const { rt, pi } = makeRt([]);
		const result = await handleToolAction(rt, { action: "remove" }, pi);
		expect(result.details.ok).toBe(false);
		expect(result.content[0]!.text).toContain("requires a runId");
	});

	it("returns error when runId is not in watch list", async () => {
		const { rt, pi } = makeRt([]);
		const result = await handleToolAction(rt, { action: "remove", runId: "r1" }, pi);
		expect(result.details.ok).toBe(false);
		expect(result.content[0]!.text).toContain("not in the watch list");
	});

	it("removes runId from watchedIds and snapshot", async () => {
		const run = makeRun({ id: "r1", status: "running" });
		const { rt, pi } = makeRt([], { r1: run });
		rt.watchedIds.add("r1");
		const result = await handleToolAction(rt, { action: "remove", runId: "r1" }, pi);
		expect(result.details.ok).toBe(true);
		expect(rt.watchedIds.has("r1")).toBe(false);
		expect(rt.snapshot["r1"]).toBeUndefined();
	});

	it("stops polling when last run is removed", async () => {
		vi.useFakeTimers();
		const run = makeRun({ id: "r1", status: "running" });
		const { rt, pi } = makeRt([], { r1: run });
		rt.watchedIds.add("r1");
		// Start the timer manually
		const { startPolling } = await import("../src/runtime.js");
		startPolling(rt);
		expect(rt.scheduler.isRunning).toBe(true);
		await handleToolAction(rt, { action: "remove", runId: "r1" }, pi);
		expect(rt.scheduler.isRunning).toBe(false);
		vi.useRealTimers();
	});
});

// ---------------------------------------------------------------------------
// poll action
// ---------------------------------------------------------------------------

describe("handleToolAction — poll", () => {
	it("runs pollOnce and returns the updated snapshot", async () => {
		const run = makeRun({ id: "r1", status: "running", workflowName: "archon-assist" });
		const { rt, pi } = makeRt([run]);
		rt.watchedIds.add("r1");
		const result = await handleToolAction(rt, { action: "poll" }, pi);
		expect(result.details.ok).toBe(true);
		// snapshot was updated by pollOnce
		expect(rt.snapshot["r1"]).toBeDefined();
		expect(result.content[0]!.text).toContain("archon-assist");
	});

	it("sends a chat message with the snapshot after polling", async () => {
		const run = makeRun({ id: "r1", status: "running" });
		const { rt, pi } = makeRt([run]);
		rt.watchedIds.add("r1");
		await handleToolAction(rt, { action: "poll" }, pi);
		// At least one sendMessage call should be the status snapshot (last call)
		expect(pi.sendMessage).toHaveBeenCalled();
		const lastCall = pi.sendMessage.mock.calls.at(-1) as [
			{ customType: string; content: string; display: boolean },
			{ deliverAs: string; triggerTurn: boolean },
		];
		expect(lastCall[0].customType).toBe("pi-archon-workflow-watcher");
		expect(lastCall[1].triggerTurn).toBe(false);
	});

	it("returns 'no runs being watched' when watchedIds is empty", async () => {
		const { rt, pi } = makeRt([]);
		const result = await handleToolAction(rt, { action: "poll" }, pi);
		expect(result.content[0]!.text).toContain("no runs being watched");
	});
});

// ---------------------------------------------------------------------------
// unknown action
// ---------------------------------------------------------------------------

describe("handleToolAction — unknown action", () => {
	it("returns ok=false for an unrecognised action", async () => {
		const { rt, pi } = makeRt([]);
		const result = await handleToolAction(rt, { action: "bogus" }, pi);
		expect(result.details.ok).toBe(false);
		expect(result.content[0]!.text).toContain("unknown action");
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — add: seeding fails gracefully (line 89)
// ---------------------------------------------------------------------------

describe("handleToolAction — add: seeding fails gracefully (line 89)", () => {
	it("still adds runId to watchedIds even when getWorkflowStatus throws during seeding", async () => {
		vi.useFakeTimers();
		try {
			const { rt, pi } = makeRt(new Error("cli unavailable"));
			const result = await handleToolAction(rt, { action: "add", runId: "r1" }, pi);
			// Non-fatal: add still succeeds even though seeding threw
			expect(result.details.ok).toBe(true);
			expect(rt.watchedIds.has("r1")).toBe(true);
			// Snapshot not seeded (getWorkflowStatus threw)
			expect(rt.snapshot["r1"]).toBeUndefined();
			rt.scheduler.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// resetToolRegisteredForTests
// ---------------------------------------------------------------------------

describe("resetToolRegisteredForTests", () => {
	beforeEach(() => resetToolRegisteredForTests());
	afterEach(() => resetToolRegisteredForTests());

	it("is exported and callable without throwing", () => {
		expect(() => resetToolRegisteredForTests()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// registerToolIfNeeded — execute lambda (line 89)
// ---------------------------------------------------------------------------

describe("registerToolIfNeeded — execute lambda (line 89)", () => {
	beforeEach(() => resetToolRegisteredForTests());
	afterEach(() => resetToolRegisteredForTests());

	it("invoke the registered tool execute lambda (covers line 89: return handleToolAction(...))", async () => {
		vi.useFakeTimers();
		try {
			const pi = makePi();
			const { rt } = makeRt([]);
			registerToolIfNeeded(pi as never, rt);

			// Capture the registered tool definition
			const toolDef = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
				execute: (toolCallId: string, params: unknown) => Promise<unknown>;
			};
			// Call the execute lambda — covers line 89
			const result = await toolDef.execute("call-1", { action: "status" });
			expect((result as { details: { action: string } }).details.action).toBe("status");
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — 'add': scheduler already running (line 143 FALSE branch)
// ---------------------------------------------------------------------------

describe("handleToolAction — add: scheduler already running (line 143 FALSE)", () => {
	it("does not restart polling when the scheduler is already running", async () => {
		vi.useFakeTimers();
		try {
			const { rt, pi } = makeRt([
				makeRun({ id: "r1", status: "running" }),
				makeRun({ id: "r2", status: "running" }),
			]);
			// First add: starts polling (scheduler not running → TRUE branch)
			await handleToolAction(rt, { action: "add", runId: "r1" }, pi);
			expect(rt.scheduler.isRunning).toBe(true);
			// Second add: scheduler already running → !rt.scheduler.isRunning is FALSE → no startPolling
			const result = await handleToolAction(rt, { action: "add", runId: "r2" }, pi);
			expect(result.details.ok).toBe(true);
			expect(rt.watchedIds.has("r2")).toBe(true);
			expect(rt.scheduler.isRunning).toBe(true); // still running
			rt.scheduler.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — 'remove': watchedIds not empty after remove (line 163 FALSE)
// ---------------------------------------------------------------------------

describe("handleToolAction — remove: watchedIds not empty after remove (line 163 FALSE)", () => {
	it("does not stop polling when other runs remain after remove", async () => {
		vi.useFakeTimers();
		try {
			const { rt, pi } = makeRt([]);
			rt.watchedIds.add("r1");
			rt.watchedIds.add("r2");
			// Start polling manually
			const { startPolling } = await import("../src/runtime.js");
			startPolling(rt);
			expect(rt.scheduler.isRunning).toBe(true);
			// Remove r1 — r2 still remains → size === 1 > 0 → FALSE branch → no stopPolling
			const result = await handleToolAction(rt, { action: "remove", runId: "r1" }, pi);
			expect(result.details.ok).toBe(true);
			expect(rt.watchedIds.has("r1")).toBe(false);
			expect(rt.watchedIds.has("r2")).toBe(true);
			expect(rt.scheduler.isRunning).toBe(true); // still running
			rt.scheduler.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// registerToolIfNeeded — already registered no-op (line ~73 if TRUE branch)
// ---------------------------------------------------------------------------

describe("registerToolIfNeeded — already registered no-op (if(toolRegistered) TRUE)", () => {
	beforeEach(() => resetToolRegisteredForTests());
	afterEach(() => resetToolRegisteredForTests());

	it("second call is a no-op (covers if(toolRegistered) return TRUE branch)", () => {
		const { rt, pi } = makeRt([]);
		registerToolIfNeeded(pi as never, rt);
		const callsBefore = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.length;
		// Second call: toolRegistered = true → early return (TRUE branch)
		registerToolIfNeeded(pi as never, rt);
		expect((pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
	});
});
