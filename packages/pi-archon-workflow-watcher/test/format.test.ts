import { describe, expect, it } from "vitest";

import {
	buildChangeChatMessage,
	buildStartupChatMessage,
	buildStatusLine,
} from "../src/format.js";
import type { ArchonEvent, RunSnapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date("2024-06-15T10:00:00.000Z");

function makeEvent(overrides: Partial<ArchonEvent> = {}): ArchonEvent {
	return {
		runId: "r1",
		eventType: "status_changed",
		workflowName: "my-wf",
		workingPath: "/repo/main",
		previousStatus: "running",
		newStatus: "completed",
		summary: "my-wf (main): running → completed",
		formatted: "• my-wf (main): running → completed ✓",
		isTerminal: true,
		shouldTriggerTurn: true,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildChangeChatMessage
// ---------------------------------------------------------------------------

describe("buildChangeChatMessage", () => {
	it("includes the ISO timestamp header", () => {
		const msg = buildChangeChatMessage([makeEvent()], FIXED_DATE);
		expect(msg).toContain("archon-workflow-watcher");
		expect(msg).toContain("2024-06-15T10:00:00.000Z");
	});

	it("reports '1 change' (singular) for a single event", () => {
		const msg = buildChangeChatMessage([makeEvent()], FIXED_DATE);
		expect(msg).toContain("1 change");
		expect(msg).not.toContain("1 changes");
	});

	it("reports plural form for multiple events", () => {
		const events = [makeEvent(), makeEvent({ runId: "r2" })];
		const msg = buildChangeChatMessage(events, FIXED_DATE);
		expect(msg).toContain("2 changes");
	});

	it("includes each event's formatted line", () => {
		const e1 = makeEvent({ formatted: "• wf-a: running → completed ✓" });
		const e2 = makeEvent({
			runId: "r2",
			formatted: "• wf-b: running → failed ✗",
		});
		const msg = buildChangeChatMessage([e1, e2], FIXED_DATE);
		expect(msg).toContain("• wf-a: running → completed ✓");
		expect(msg).toContain("• wf-b: running → failed ✗");
	});
});

// ---------------------------------------------------------------------------
// buildStartupChatMessage
// ---------------------------------------------------------------------------

describe("buildStartupChatMessage", () => {
	it("includes the ISO timestamp header", () => {
		const msg = buildStartupChatMessage({}, FIXED_DATE);
		expect(msg).toContain("2024-06-15T10:00:00.000Z");
	});

	it("says 'No active workflow runs' for an empty snapshot", () => {
		const msg = buildStartupChatMessage({}, FIXED_DATE);
		expect(msg).toContain("No active workflow runs");
	});

	it("lists the run count and each run's name and status", () => {
		const snapshot: RunSnapshot = {
			r1: {
				id: "r1",
				status: "running",
				workflowName: "deploy",
				workingPath: "/repo/main",
			},
			r2: {
				id: "r2",
				status: "paused",
				workflowName: "test-suite",
			},
		};
		const msg = buildStartupChatMessage(snapshot, FIXED_DATE);
		expect(msg).toContain("2 active workflow run");
		expect(msg).toContain("deploy");
		expect(msg).toContain("running");
		expect(msg).toContain("test-suite");
		expect(msg).toContain("paused");
	});

	it("includes workingPath basename in the run label when present", () => {
		const snapshot: RunSnapshot = {
			r1: { id: "r1", status: "running", workflowName: "wf", workingPath: "/repo/feat-x" },
		};
		const msg = buildStartupChatMessage(snapshot, FIXED_DATE);
		expect(msg).toContain("feat-x");
	});

	it("uses run id as label when workflowName is absent", () => {
		const snapshot: RunSnapshot = {
			r1: { id: "r1", status: "running" },
		};
		const msg = buildStartupChatMessage(snapshot, FIXED_DATE);
		expect(msg).toContain("r1");
	});
});

// ---------------------------------------------------------------------------
// buildStatusLine
// ---------------------------------------------------------------------------

describe("buildStatusLine", () => {
	it("shows 'active' mode when not paused", () => {
		const line = buildStatusLine({ paused: false, runCount: 3, activeCount: 2 });
		expect(line).toContain("active");
		expect(line).not.toContain("paused");
	});

	it("shows 'paused' mode when paused", () => {
		const line = buildStatusLine({ paused: true, runCount: 3, activeCount: 2 });
		expect(line).toContain("paused");
		expect(line).not.toContain("active");
	});

	it("includes activeCount as 'running' and runCount as 'total'", () => {
		const line = buildStatusLine({ paused: false, runCount: 5, activeCount: 3 });
		expect(line).toContain("3 running");
		expect(line).toContain("5 total");
	});

	it("works for zero counts", () => {
		const line = buildStatusLine({ paused: false, runCount: 0, activeCount: 0 });
		expect(line).toContain("0 running");
		expect(line).toContain("0 total");
	});

	it("starts with 'archon-watcher:'", () => {
		const line = buildStatusLine({ paused: false, runCount: 1, activeCount: 1 });
		expect(line).toMatch(/^archon-watcher:/);
	});
});
