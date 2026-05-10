import { describe, expect, it } from "vitest";

import { detectChanges } from "../src/poller.js";
import type { ArchonRun, RunSnapshot } from "../src/types.js";

function run(overrides: Partial<ArchonRun> & { id: string; status: string }): ArchonRun {
	const base: ArchonRun = {
		id: overrides.id,
		status: overrides.status,
	};
	if (overrides.workflowName !== undefined) base.workflowName = overrides.workflowName;
	if (overrides.branch !== undefined) base.branch = overrides.branch;
	if (overrides.startedAt !== undefined) base.startedAt = overrides.startedAt;
	if (overrides.lastActivityAt !== undefined) base.lastActivityAt = overrides.lastActivityAt;
	return base;
}

describe("detectChanges", () => {
	it("returns no events when both snapshots are empty", () => {
		expect(detectChanges({}, {})).toEqual([]);
	});

	it("returns no events when both snapshots are identical", () => {
		const snap: RunSnapshot = {
			r1: run({ id: "r1", status: "running", workflowName: "wf" }),
		};
		expect(detectChanges(snap, snap)).toEqual([]);
	});

	it("returns no events when status is unchanged", () => {
		const baseline: RunSnapshot = {
			r1: run({ id: "r1", status: "running" }),
		};
		const current: RunSnapshot = {
			r1: run({ id: "r1", status: "running" }),
		};
		expect(detectChanges(baseline, current)).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// New runs
	// -------------------------------------------------------------------------

	it("emits new_run event for a run that appears in current but not baseline", () => {
		const baseline: RunSnapshot = {};
		const current: RunSnapshot = {
			r1: run({ id: "r1", status: "running", workflowName: "my-wf" }),
		};
		const events = detectChanges(baseline, current);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			runId: "r1",
			eventType: "new_run",
			workflowName: "my-wf",
			newStatus: "running",
			previousStatus: "",
			shouldTriggerTurn: false,
			isTerminal: false,
		});
	});

	it("new_run for a terminal status is isTerminal=true, shouldTriggerTurn=false", () => {
		const events = detectChanges(
			{},
			{ r1: run({ id: "r1", status: "completed", workflowName: "wf" }) },
		);
		expect(events[0]).toMatchObject({
			isTerminal: true,
			shouldTriggerTurn: false,
		});
	});

	it("new_run formatted line includes the label and status", () => {
		const events = detectChanges(
			{},
			{ r1: run({ id: "r1", status: "running", workflowName: "deploy", branch: "main" }) },
		);
		expect(events[0]!.formatted).toContain("deploy");
		expect(events[0]!.formatted).toContain("main");
		expect(events[0]!.formatted).toContain("running");
	});

	// -------------------------------------------------------------------------
	// Status changes
	// -------------------------------------------------------------------------

	it("emits status_changed event when a run changes status", () => {
		const baseline: RunSnapshot = {
			r1: run({ id: "r1", status: "running", workflowName: "wf" }),
		};
		const current: RunSnapshot = {
			r1: run({ id: "r1", status: "completed", workflowName: "wf" }),
		};
		const events = detectChanges(baseline, current);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			runId: "r1",
			eventType: "status_changed",
			previousStatus: "running",
			newStatus: "completed",
			isTerminal: true,
			shouldTriggerTurn: true,
		});
	});

	it("status_changed: running → paused has shouldTriggerTurn=true", () => {
		const events = detectChanges(
			{ r1: run({ id: "r1", status: "running" }) },
			{ r1: run({ id: "r1", status: "paused" }) },
		);
		expect(events[0]!.shouldTriggerTurn).toBe(true);
		expect(events[0]!.isTerminal).toBe(false);
	});

	it("status_changed: running → failed is terminal and triggers turn", () => {
		const events = detectChanges(
			{ r1: run({ id: "r1", status: "running" }) },
			{ r1: run({ id: "r1", status: "failed" }) },
		);
		expect(events[0]!.isTerminal).toBe(true);
		expect(events[0]!.shouldTriggerTurn).toBe(true);
	});

	it("status_changed: running → cancelled is terminal and triggers turn", () => {
		const events = detectChanges(
			{ r1: run({ id: "r1", status: "running" }) },
			{ r1: run({ id: "r1", status: "cancelled" }) },
		);
		expect(events[0]!.isTerminal).toBe(true);
		expect(events[0]!.shouldTriggerTurn).toBe(true);
	});

	it("status_changed: running → queued is NOT terminal, NOT trigger", () => {
		const events = detectChanges(
			{ r1: run({ id: "r1", status: "queued" }) },
			{ r1: run({ id: "r1", status: "running" }) },
		);
		expect(events[0]!.isTerminal).toBe(false);
		expect(events[0]!.shouldTriggerTurn).toBe(false);
	});

	it("status_changed completed: formatted line ends with ✓", () => {
		const events = detectChanges(
			{ r1: run({ id: "r1", status: "running" }) },
			{ r1: run({ id: "r1", status: "completed" }) },
		);
		expect(events[0]!.formatted).toContain("✓");
	});

	it("status_changed failed: formatted line ends with ✗", () => {
		const events = detectChanges(
			{ r1: run({ id: "r1", status: "running" }) },
			{ r1: run({ id: "r1", status: "failed" }) },
		);
		expect(events[0]!.formatted).toContain("✗");
	});

	it("status_changed non-terminal: formatted line has arrow but no symbol", () => {
		const events = detectChanges(
			{ r1: run({ id: "r1", status: "running" }) },
			{ r1: run({ id: "r1", status: "paused" }) },
		);
		expect(events[0]!.formatted).toContain("→");
		expect(events[0]!.formatted).not.toContain("✓");
		expect(events[0]!.formatted).not.toContain("✗");
	});

	// -------------------------------------------------------------------------
	// Removed runs
	// -------------------------------------------------------------------------

	it("emits run_removed for a non-terminal run that disappears from current", () => {
		const baseline: RunSnapshot = {
			r1: run({ id: "r1", status: "running", workflowName: "wf" }),
		};
		const current: RunSnapshot = {};
		const events = detectChanges(baseline, current);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			runId: "r1",
			eventType: "run_removed",
			previousStatus: "running",
			newStatus: "",
			isTerminal: true,
			shouldTriggerTurn: true,
		});
	});

	it("does NOT emit run_removed for a completed run that disappears (terminal)", () => {
		const baseline: RunSnapshot = {
			r1: run({ id: "r1", status: "completed" }),
		};
		expect(detectChanges(baseline, {})).toEqual([]);
	});

	it("does NOT emit run_removed for a failed run that disappears (terminal)", () => {
		const baseline: RunSnapshot = {
			r1: run({ id: "r1", status: "failed" }),
		};
		expect(detectChanges(baseline, {})).toEqual([]);
	});

	it("does NOT emit run_removed for a cancelled run that disappears (terminal)", () => {
		const baseline: RunSnapshot = {
			r1: run({ id: "r1", status: "cancelled" }),
		};
		expect(detectChanges(baseline, {})).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// Combined scenarios
	// -------------------------------------------------------------------------

	it("can emit multiple event types in a single call", () => {
		const baseline: RunSnapshot = {
			r1: run({ id: "r1", status: "running" }), // will change status
			r2: run({ id: "r2", status: "running" }), // will disappear
		};
		const current: RunSnapshot = {
			r1: run({ id: "r1", status: "completed" }), // status_changed
			r3: run({ id: "r3", status: "running" }), // new_run
		};
		const events = detectChanges(baseline, current);
		expect(events).toHaveLength(3);
		const types = events.map((e) => e.eventType).sort();
		expect(types).toEqual(["new_run", "run_removed", "status_changed"]);
	});

	it("uses id as fallback label when workflowName is absent", () => {
		const events = detectChanges(
			{},
			{ r1: run({ id: "r1", status: "running" }) }, // no workflowName
		);
		expect(events[0]!.workflowName).toBe("r1");
		expect(events[0]!.formatted).toContain("r1");
	});

	it("includes branch in formatted label when present", () => {
		const events = detectChanges(
			{},
			{ r1: run({ id: "r1", status: "running", workflowName: "wf", branch: "feat/x" }) },
		);
		expect(events[0]!.branch).toBe("feat/x");
		expect(events[0]!.formatted).toContain("feat/x");
	});

	it("branch defaults to empty string when absent", () => {
		const events = detectChanges(
			{},
			{ r1: run({ id: "r1", status: "running" }) },
		);
		expect(events[0]!.branch).toBe("");
	});
});
