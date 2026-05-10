import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ArchonClient } from "../src/archon-client.js";
import { makeRuntime, POLL_INTERVAL_MS } from "../src/runtime.js";
import {
	handleToolAction,
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
	if (overrides.branch !== undefined) run.workingPath = overrides.branch;
	return run;
}

function makeClient(
	runsOrError: ArchonRun[] | Error,
): ArchonClient {
	return {
		getWorkflowStatus: vi.fn(async () => {
			if (runsOrError instanceof Error) throw runsOrError;
			return runsOrError;
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
		// timer started because not paused
		expect(rt.timer).not.toBeNull();
		clearInterval(rt.timer!);
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
		expect(rt.timer).not.toBeNull();
		await handleToolAction(rt, { action: "remove", runId: "r1" }, pi);
		expect(rt.timer).toBeNull();
		vi.useRealTimers();
	});
});

// ---------------------------------------------------------------------------
// pause action
// ---------------------------------------------------------------------------

describe("handleToolAction — pause", () => {
	it("sets rt.paused = true and stops the timer", async () => {
		vi.useFakeTimers();
		const { rt, pi } = makeRt([]);
		rt.paused = false;
		const result = await handleToolAction(rt, { action: "pause" }, pi);
		expect(rt.paused).toBe(true);
		expect(rt.timer).toBeNull();
		expect(result.details.ok).toBe(true);
		expect(result.content[0]!.text).toContain("paused");
		vi.useRealTimers();
	});

	it("persists the pause state via appendEntry", async () => {
		const { rt, pi } = makeRt([]);
		await handleToolAction(rt, { action: "pause" }, pi);
		const calls = pi.appendEntry.mock.calls as Array<[string, unknown]>;
		const runstateCall = calls.find(([type]) =>
			type === "pi-archon-workflow-watcher:runstate",
		);
		expect(runstateCall).toBeDefined();
		expect((runstateCall![1] as { paused: boolean }).paused).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// resume action
// ---------------------------------------------------------------------------

describe("handleToolAction — resume", () => {
	it("sets rt.paused = false and starts the timer", async () => {
		vi.useFakeTimers();
		const { rt, pi } = makeRt([]);
		rt.paused = true;
		rt.watchedIds.add("r1"); // timer only starts when watchedIds is non-empty
		const result = await handleToolAction(rt, { action: "resume" }, pi);
		expect(rt.paused).toBe(false);
		expect(rt.timer).not.toBeNull();
		expect(result.details.ok).toBe(true);
		expect(result.content[0]!.text).toContain("resumed");
		// cleanup
		clearInterval(rt.timer!);
		vi.useRealTimers();
	});

	it("persists the resume state via appendEntry", async () => {
		vi.useFakeTimers();
		const { rt, pi } = makeRt([]);
		rt.paused = true;
		await handleToolAction(rt, { action: "resume" }, pi);
		const calls = pi.appendEntry.mock.calls as Array<[string, unknown]>;
		const runstateCall = calls.find(([type]) =>
			type === "pi-archon-workflow-watcher:runstate",
		);
		expect(runstateCall).toBeDefined();
		expect((runstateCall![1] as { paused: boolean }).paused).toBe(false);
		clearInterval(rt.timer!);
		vi.useRealTimers();
	});

	it("includes current poll interval in the result message", async () => {
		vi.useFakeTimers();
		const { rt, pi } = makeRt([]);
		rt.paused = true;
		const result = await handleToolAction(rt, { action: "resume" }, pi);
		expect(result.content[0]!.text).toContain(
			`${Math.round(POLL_INTERVAL_MS / 1000)}s`,
		);
		clearInterval(rt.timer!);
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
// resetToolRegisteredForTests
// ---------------------------------------------------------------------------

describe("resetToolRegisteredForTests", () => {
	beforeEach(() => resetToolRegisteredForTests());
	afterEach(() => resetToolRegisteredForTests());

	it("is exported and callable without throwing", () => {
		expect(() => resetToolRegisteredForTests()).not.toThrow();
	});
});
