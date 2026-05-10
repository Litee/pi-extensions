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
	it("returns current workflow status when no runs are active", async () => {
		const { rt, pi } = makeRt([]);
		const result = await handleToolAction(rt, { action: "status" }, pi);
		expect(result.details.ok).toBe(true);
		expect(result.details.action).toBe("status");
		expect(result.content[0]!.text).toContain("No active workflow runs");
	});

	it("returns formatted run list when runs are active", async () => {
		const run = makeRun({
			id: "r1",
			status: "running",
			workflowName: "archon-assist",
			workingPath: "/repo/feat-foo",
		});
		const { rt, pi } = makeRt([run]);
		const result = await handleToolAction(rt, { action: "status" }, pi);
		expect(result.details.ok).toBe(true);
		expect(result.content[0]!.text).toContain("archon-assist");
		expect(result.content[0]!.text).toContain("running");
	});

	it("returns error when archon CLI fails", async () => {
		const { rt, pi } = makeRt(new Error("archon not found"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await handleToolAction(rt, { action: "status" }, pi);
		warnSpy.mockRestore();
		expect(result.details.ok).toBe(false);
		expect(result.content[0]!.text).toContain("failed to fetch status");
		expect(result.content[0]!.text).toContain("archon not found");
	});

	it("does not mutate rt.snapshot", async () => {
		const existing = makeRun({ id: "old", status: "paused" });
		const { rt, pi } = makeRt(
			[makeRun({ id: "new", status: "running" })],
			{ old: existing },
		);
		await handleToolAction(rt, { action: "status" }, pi);
		// snapshot should be unchanged — status is a read-only fetch
		expect(Object.keys(rt.snapshot)).toEqual(["old"]);
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
		const result = await handleToolAction(rt, { action: "poll" }, pi);
		expect(result.details.ok).toBe(true);
		// snapshot was updated by pollOnce
		expect(rt.snapshot["r1"]).toBeDefined();
		expect(result.content[0]!.text).toContain("archon-assist");
	});

	it("sends a chat message with the snapshot after polling", async () => {
		const run = makeRun({ id: "r1", status: "running" });
		const { rt, pi } = makeRt([run]);
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

	it("returns 'No active workflow runs' when archon has no runs", async () => {
		const { rt, pi } = makeRt([]);
		const result = await handleToolAction(rt, { action: "poll" }, pi);
		expect(result.content[0]!.text).toContain("No active workflow runs");
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
