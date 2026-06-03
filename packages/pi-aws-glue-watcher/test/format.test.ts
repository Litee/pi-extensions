import { describe, expect, it } from "vitest";

import { buildChangeChatMessage, buildStartupChatMessage, buildStatusLine, buildWatchEntry } from "../src/format.js";
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
	it("returns idle with muted alias when watches map is empty", () => {
		const r = buildStatusLine({ watches: {}, pollIntervalMs: 120_000 });
		expect(r).toEqual({ text: "☁ Glue: idle", colorAlias: "muted" });
	});

	it("shows 0/N with accent alias when no watches have succeeded (all active)", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa" }),
			bb: makeJobWatch({ watchId: "bb" }),
			cc: makeJobWatch({ watchId: "cc" }),
		};
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000 });
		expect(r).toEqual({ text: "☁ Glue: 0/3", colorAlias: "accent" });
	});

	it("shows M/N with accent alias when some watches have succeeded", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", baseline: { state: "SUCCEEDED", errorMessage: "" } }),
			bb: makeJobWatch({ watchId: "bb" }),
			cc: makeJobWatch({ watchId: "cc" }),
		};
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000 });
		expect(r).toEqual({ text: "☁ Glue: 1/3", colorAlias: "accent" });
	});

	it("shows N/N with accent alias when all watches have succeeded", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", baseline: { state: "SUCCEEDED", errorMessage: "" } }),
			bb: makeJobWatch({ watchId: "bb", baseline: { state: "COMPLETED", errorMessage: "" } }),
			cc: makeJobWatch({ watchId: "cc", baseline: { state: "SUCCEEDED", errorMessage: "" } }),
		};
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000 });
		expect(r).toEqual({ text: "☁ Glue: 3/3", colorAlias: "accent" });
	});

	it("shows accent alias when no errors", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa" }),
			bb: makeJobWatch({ watchId: "bb" }),
			cc: makeJobWatch({ watchId: "cc" }),
		};
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000 });
		expect(r).toEqual({ text: "☁ Glue: 0/3", colorAlias: "accent" });
	});

	it("shows ⚠ prefix and warning alias when hasErrors is true", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa" }),
			bb: makeJobWatch({ watchId: "bb" }),
			cc: makeJobWatch({ watchId: "cc" }),
		};
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000, hasErrors: true });
		expect(r).toEqual({ text: "☁ Glue: ⚠ 0/3", colorAlias: "warning" });
	});

	it("shows ⚠ prefix and warning alias when a watch has FAILED state", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", baseline: { state: "SUCCEEDED", errorMessage: "" } }),
			bb: makeJobWatch({ watchId: "bb", baseline: { state: "FAILED", errorMessage: "oops" } }),
			cc: makeJobWatch({ watchId: "cc" }),
		};
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000 });
		expect(r).toEqual({ text: "☁ Glue: ⚠ 1/3", colorAlias: "warning" });
	});

	it("shows ⚠ prefix and warning alias when hasErrors is true (multiple watches)", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa" }),
			bb: makeJobWatch({ watchId: "bb" }),
		};
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000, hasErrors: true });
		expect(r).toEqual({ text: "☁ Glue: ⚠ 0/2", colorAlias: "warning" });
	});

	it("a watch with undefined baseline does not count toward M", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", baseline: undefined }),
			bb: makeJobWatch({ watchId: "bb", baseline: { state: "SUCCEEDED", errorMessage: "" } }),
		};
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000 });
		expect(r).toEqual({ text: "☁ Glue: 1/2", colorAlias: "accent" });
	});

	it("never includes the ⟳ poll-interval suffix", () => {
		const watches: WatchMap = { aa: makeJobWatch({ watchId: "aa" }) };
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000 });
		expect(r.text).not.toContain("⟳");
		expect(r.text).not.toMatch(/\d+s/);
	});

	it("never includes the ⏸ pause glyph", () => {
		const watches: WatchMap = { aa: makeJobWatch({ watchId: "aa" }) };
		const r = buildStatusLine({ watches, pollIntervalMs: 120_000 });
		expect(r.text).not.toContain("⏸");
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

	it("uses numbered list: primary line is '<N>. <name> — state=<STATE>'", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({
				watchId: "aa",
				name: "etl-job",
				runId: "jr_123",
				baseline: { state: "RUNNING", errorMessage: "" },
			}),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE);
		expect(msg).toContain("1. etl-job — state=RUNNING");
		expect(msg).not.toMatch(/•/);
	});

	it("collapsed (default): sub-fields hidden, expand hint shown", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", name: "etl-job", runId: "jr_123" }),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE);
		expect(msg).not.toContain("· run:");
		expect(msg).not.toContain("· type:");
		expect(msg).toContain("… ctrl+o to expand");
	});

	it("expanded: sub-fields shown, no expand hint", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", name: "etl-job", runId: "jr_123" }),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE, { expanded: true });
		expect(msg).toContain("· run: jr_123");
		expect(msg).toContain("· type: job");
		expect(msg).not.toContain("… ctrl+o to expand");
	});

	it("expanded: terminal watch shows '· terminal' sub-field", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({
				watchId: "aa",
				terminal: true,
				baseline: { state: "SUCCEEDED", errorMessage: "" },
			}),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE, { expanded: true });
		expect(msg).toContain("· terminal");
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

	it("no blank line between header and first entry", () => {
		const watches: WatchMap = { aa: makeJobWatch({ watchId: "aa" }) };
		const msg = buildStartupChatMessage(watches, FIXED_DATE);
		expect(msg).not.toContain("\n\n");
		expect(msg).toMatch(/watching 1 run:\n1\./);
	});
	it("appends ' — poll: Ns' suffix when pollMs is provided (#0009)", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", name: "etl-job", runId: "jr_123" }),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE, { pollMs: 120_000 });
		expect(msg).toContain("watching 1 run \u2014 poll: 120s:");
	});

	it("omits poll suffix when pollMs is undefined or 0", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", name: "etl-job", runId: "jr_123" }),
		};
		const noPoll = buildStartupChatMessage(watches, FIXED_DATE);
		expect(noPoll).not.toContain("poll:");
		const zeroPoll = buildStartupChatMessage(watches, FIXED_DATE, { pollMs: 0 });
		expect(zeroPoll).not.toContain("poll:");
	});

	it("poll suffix is preserved in expanded form", () => {
		const watches: WatchMap = {
			aa: makeJobWatch({ watchId: "aa", name: "etl-job", runId: "jr_123" }),
		};
		const msg = buildStartupChatMessage(watches, FIXED_DATE, { expanded: true, pollMs: 60_000 });
		expect(msg).toContain("watching 1 run \u2014 poll: 60s:");
		expect(msg).toContain("\u00b7 run: jr_123");
	});
});

describe("buildWatchEntry", () => {
	it("returns 1-based numbered summary line", () => {
		const w = makeJobWatch({ watchId: "w", name: "my-job", runId: "jr_abc", baseline: { state: "RUNNING", errorMessage: "" } });
		const { summary } = buildWatchEntry(w, 0);
		expect(summary).toBe("1. my-job — state=RUNNING");
	});

	it("detail block contains · run and · type lines", () => {
		const w = makeJobWatch({ watchId: "w", name: "my-job", runId: "jr_abc" });
		const { detail } = buildWatchEntry(w, 0);
		expect(detail).toContain("   · run: jr_abc");
		expect(detail).toContain("   · type: job");
	});

	it("detail block includes '· terminal' when watch is terminal", () => {
		const w = makeJobWatch({ watchId: "w", name: "n", runId: "jr_x", terminal: true });
		const { detail } = buildWatchEntry(w, 0);
		expect(detail).toContain("   · terminal");
	});
});

describe("buildChangeChatMessage", () => {
	function makeEvent(overrides: Partial<GlueEvent> & { watchId: string; formatted: string }): GlueEvent {
		return {
			type: "job",
			name: "my-job",
			runId: "jr_1",
			eventType: "state_changed",
			previousState: "RUNNING",
			newState: "SUCCEEDED",
			summary: "RUNNING → SUCCEEDED",
			isTerminal: true,
			...overrides,
		};
	}

	it("uses numbered list for events", () => {
		const events: GlueEvent[] = [
			makeEvent({ watchId: "w1", formatted: "my-job: RUNNING → SUCCEEDED ✓" }),
			makeEvent({ watchId: "w2", name: "other-job", formatted: "other-job: STARTING → RUNNING" }),
		];
		const msg = buildChangeChatMessage(events, FIXED_DATE);
		expect(msg).toContain("1. my-job: RUNNING → SUCCEEDED ✓");
		expect(msg).toContain("2. other-job: STARTING → RUNNING");
		expect(msg).not.toMatch(/•/);
	});

	it("no blank line between header and first event", () => {
		const events: GlueEvent[] = [
			makeEvent({ watchId: "w1", formatted: "my-job: SUCCEEDED" }),
		];
		const msg = buildChangeChatMessage(events, FIXED_DATE);
		expect(msg).not.toContain("\n\n");
		expect(msg).toMatch(/change detected\n1\./);
	});
});


