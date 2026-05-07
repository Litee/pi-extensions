import { describe, expect, it } from "vitest";

import { buildChangeChatMessage, buildStartupChatMessage, buildStatusLine } from "../src/format.js";
import type { GlueEvent, GlueWatch, WatchMap } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
	return {
		watchId: "aabbccdd",
		type: "job",
		name: "my-etl-job",
		runId: "jr_abc123",
		profile: "my-profile",
		region: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: { state: "RUNNING", errorMessage: "" },
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

function makeStateChangedEvent(overrides: Partial<GlueEvent> = {}): GlueEvent {
	return {
		watchId: "aabbccdd",
		type: "job",
		name: "my-etl-job",
		runId: "jr_abc123",
		eventType: "state_changed",
		previousState: "STARTING",
		newState: "RUNNING",
		summary: "my-etl-job (jr_abc123): STARTING → RUNNING",
		formatted: "• my-etl-job (jr_abc123): STARTING → RUNNING",
		isTerminal: false,
		...overrides,
	};
}

const FIXED_DATE = new Date("2026-05-06T10:30:00.000Z");

// ---------------------------------------------------------------------------
// buildStatusLine
// ---------------------------------------------------------------------------

describe("buildStatusLine", () => {
	it("returns idle text when watches map is empty", () => {
		const line = buildStatusLine({ watches: {}, paused: false, pollIntervalMs: 120_000 });
		expect(line).toBe("☁ Glue: idle");
	});

	it("returns idle text when all watches are terminal", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", terminal: true }),
		};
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000 });
		expect(line).toBe("☁ Glue: idle");
	});

	it("shows singular 'job' for one active job watch", () => {
		const watches: WatchMap = { aa: makeJobWatch({ watchId: "aa" }) };
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000 });
		expect(line).toBe("☁ Glue: 1 job | ⟳ 120s");
	});

	it("shows plural 'jobs' for two active job watches", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa" }),
			bb: makeJobWatch({ watchId: "bb" }),
		};
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000 });
		expect(line).toBe("☁ Glue: 2 jobs | ⟳ 120s");
	});

	it("shows singular 'workflow' for one active workflow watch", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", type: "workflow", runId: "wr_xyz" }),
		};
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000 });
		expect(line).toBe("☁ Glue: 1 workflow | ⟳ 60s");
	});

	it("shows both job and workflow counts separated by |", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa" }),
			bb: makeJobWatch({ watchId: "bb", type: "workflow", runId: "wr_xyz" }),
		};
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000 });
		expect(line).toBe("☁ Glue: 1 job | 1 workflow | ⟳ 120s");
	});

	it("shows paused indicator instead of poll interval when paused", () => {
		const watches: WatchMap = { aa: makeJobWatch({ watchId: "aa" }) };
		const line = buildStatusLine({ watches, paused: true, pollIntervalMs: 120_000 });
		expect(line).toBe("☁ Glue: 1 job ⏸");
	});

	it("shows plural 'workflows' for two active workflow watches", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", type: "workflow", runId: "wr_aaa" }),
			bb: makeJobWatch({ watchId: "bb", type: "workflow", runId: "wr_bbb" }),
		};
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000 });
		expect(line).toBe("☁ Glue: 2 workflows | ⟳ 120s");
	});

	it("excludes terminal watches from counts but treats non-empty list with all terminal as idle", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", terminal: true }),
			bb: makeJobWatch({ watchId: "bb", terminal: false }),
		};
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000 });
		// Only bb counts
		expect(line).toBe("☁ Glue: 1 job | ⟳ 120s");
	});
});

// ---------------------------------------------------------------------------
// buildChangeChatMessage
// ---------------------------------------------------------------------------

describe("buildChangeChatMessage", () => {
	it("includes event count header with singular 'change' for one event", () => {
		const msg = buildChangeChatMessage([makeStateChangedEvent()], FIXED_DATE);
		expect(msg).toContain("1 change detected");
	});

	it("includes plural 'changes' for multiple events", () => {
		const msg = buildChangeChatMessage(
			[makeStateChangedEvent(), makeStateChangedEvent()],
			FIXED_DATE,
		);
		expect(msg).toContain("2 changes detected");
	});

	it("includes the formatted bullet line from each event", () => {
		const event = makeStateChangedEvent({
			formatted: "• my-etl-job (jr_abc123): STARTING → RUNNING",
		});
		const msg = buildChangeChatMessage([event], FIXED_DATE);
		expect(msg).toContain("• my-etl-job (jr_abc123): STARTING → RUNNING");
	});

	it("includes a compact [HH:mm] timestamp in the header", () => {
		const msg = buildChangeChatMessage([makeStateChangedEvent()], FIXED_DATE);
		expect(msg).toMatch(/^\[\d{2}:\d{2}\]/);
	});

	it("includes node_failure formatted line", () => {
		const nodeEvent = makeStateChangedEvent({
			eventType: "node_failure",
			formatted: "• my-workflow (wr_def456): node 'job-a' → FAILED ✗",
			nodeName: "job-a",
		});
		const msg = buildChangeChatMessage([nodeEvent], FIXED_DATE);
		expect(msg).toContain("node 'job-a' → FAILED ✗");
	});
});

// ---------------------------------------------------------------------------
// buildStartupChatMessage
// ---------------------------------------------------------------------------

describe("buildStartupChatMessage", () => {
	it("returns 'no watches configured' message for empty watch map", () => {
		const msg = buildStartupChatMessage({}, FIXED_DATE);
		expect(msg).toContain("active");
		expect(msg).toContain("no watches configured");
	});

	it("lists each watch with type, name, runId, and state", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({
				watchId: "aa",
				name: "etl-job",
				runId: "jr_123",
				baseline: { state: "RUNNING", errorMessage: "" },
			}),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE);
		expect(msg).toContain("etl-job");
		expect(msg).toContain("jr_123");
		expect(msg).toContain("state=RUNNING");
	});

	it("marks terminal watches with [terminal] suffix", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({
				watchId: "aa",
				terminal: true,
				baseline: { state: "SUCCEEDED", errorMessage: "" },
			}),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE);
		expect(msg).toContain("[terminal]");
	});

	it("shows '?' for state when baseline is undefined", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", baseline: undefined }),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE);
		expect(msg).toContain("state=?");
	});

	it("shows '?' for state when baseline.state is empty", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", baseline: { state: "", errorMessage: "" } }),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE);
		expect(msg).toContain("state=?");
	});

	it("uses plural 'runs' for multiple watches", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa" }),
			bb: makeJobWatch({ watchId: "bb", type: "workflow", runId: "wr_xyz" }),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE);
		expect(msg).toContain("watching 2 runs:");
	});
});

describe("buildStatusLine — hasErrors flag", () => {
	it("shows ⚠ errors part when hasErrors is true", () => {
		const watches: WatchMap = { aa: makeJobWatch({ watchId: "aa" }) };
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000, hasErrors: true });
		expect(line).toContain("⚠ errors");
	});

	it("does not show ⚠ errors part when hasErrors is false", () => {
		const watches: WatchMap = { aa: makeJobWatch({ watchId: "aa" }) };
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000, hasErrors: false });
		expect(line).not.toContain("⚠");
	});

	it("does not show ⚠ errors part when hasErrors is omitted", () => {
		const watches: WatchMap = { aa: makeJobWatch({ watchId: "aa" }) };
		const line = buildStatusLine({ watches, paused: false, pollIntervalMs: 120_000 });
		expect(line).not.toContain("⚠");
	});
});
