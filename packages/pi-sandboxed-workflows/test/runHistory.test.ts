/**
 * Unit tests for RunHistory — in-memory run store for the TUI.
 *
 * Pure logic, no I/O.
 */
import { describe, expect, it } from "vitest";

import { RunHistory } from "../src/runHistory.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeHistory(): RunHistory {
	return new RunHistory();
}

// ── startRun ─────────────────────────────────────────────────────────────────

describe("RunHistory.startRun", () => {
	it("creates a run record with status 'running'", () => {
		const h = makeHistory();
		h.startRun("run-1", "my-workflow");
		const runs = h.getRunsForName("my-workflow");
		expect(runs).toHaveLength(1);
		expect(runs[0]!.runId).toBe("run-1");
		expect(runs[0]!.status).toBe("running");
		expect(runs[0]!.events).toEqual([]);
	});

	it("prepends newest runs so getRunsForName returns newest first", () => {
		const h = makeHistory();
		h.startRun("run-a", "wf", 1000);
		h.startRun("run-b", "wf", 2000);
		h.startRun("run-c", "wf", 3000);
		const runs = h.getRunsForName("wf");
		expect(runs.map((r) => r.runId)).toEqual(["run-c", "run-b", "run-a"]);
	});

	it("returns empty array for an unknown workflow name", () => {
		const h = makeHistory();
		expect(h.getRunsForName("nonexistent")).toEqual([]);
	});

	it("stores startedAt correctly", () => {
		const h = makeHistory();
		const ts = 1_700_000_000_000;
		h.startRun("r", "wf", ts);
		expect(h.getRunsForName("wf")[0]!.startedAt).toBe(ts);
	});
});

// ── appendEvent ──────────────────────────────────────────────────────────────

describe("RunHistory.appendEvent", () => {
	it("appends events to the matching run", () => {
		const h = makeHistory();
		h.startRun("r1", "wf");
		h.appendEvent("r1", { kind: "started", message: "Started wf", ts: 1 });
		h.appendEvent("r1", { kind: "completed", message: "Done", ts: 2 });
		const events = h.getRunsForName("wf")[0]!.events;
		expect(events).toHaveLength(2);
		expect(events[0]!.kind).toBe("started");
		expect(events[1]!.kind).toBe("completed");
	});

	it("no-ops when the runId is not found", () => {
		const h = makeHistory();
		// Should not throw.
		expect(() =>
			h.appendEvent("does-not-exist", { kind: "info", message: "x", ts: 0 }),
		).not.toThrow();
	});

	it("preserves details payload", () => {
		const h = makeHistory();
		h.startRun("r1", "wf");
		h.appendEvent("r1", {
			kind: "started",
			message: "m",
			ts: 0,
			details: { args: "hello" },
		});
		expect(h.getRunsForName("wf")[0]!.events[0]!.details).toEqual({
			args: "hello",
		});
	});
});

// ── finishRun ────────────────────────────────────────────────────────────────

describe("RunHistory.finishRun", () => {
	it("sets status and finishedAt on the matching run", () => {
		const h = makeHistory();
		h.startRun("r1", "wf");
		h.finishRun("r1", "completed", 9999);
		const run = h.getRunsForName("wf")[0]!;
		expect(run.status).toBe("completed");
		expect(run.finishedAt).toBe(9999);
	});

	it("supports error status", () => {
		const h = makeHistory();
		h.startRun("r1", "wf");
		h.finishRun("r1", "error");
		expect(h.getRunsForName("wf")[0]!.status).toBe("error");
	});

	it("supports aborted status", () => {
		const h = makeHistory();
		h.startRun("r1", "wf");
		h.finishRun("r1", "aborted");
		expect(h.getRunsForName("wf")[0]!.status).toBe("aborted");
	});

	it("no-ops when runId is not found", () => {
		const h = makeHistory();
		expect(() => h.finishRun("ghost", "completed")).not.toThrow();
	});
});

// ── bounded capacity ─────────────────────────────────────────────────────────

describe("RunHistory — bounded capacity (MAX_RUNS = 20)", () => {
	it("keeps at most 20 runs per workflow name", () => {
		const h = makeHistory();
		for (let i = 0; i < 21; i++) {
			h.startRun(`run-${String(i)}`, "wf");
		}
		const runs = h.getRunsForName("wf");
		expect(runs).toHaveLength(20);
	});

	it("drops the oldest run when capacity is exceeded", () => {
		const h = makeHistory();
		for (let i = 0; i < 21; i++) {
			h.startRun(`run-${String(i)}`, "wf");
		}
		const ids = h.getRunsForName("wf").map((r) => r.runId);
		// run-0 is the oldest and should have been dropped.
		expect(ids).not.toContain("run-0");
		// run-20 is the newest and must be present.
		expect(ids[0]).toBe("run-20");
	});

	it("retains exactly MAX_RUNS entries after many insertions", () => {
		const h = makeHistory();
		for (let i = 0; i < 50; i++) {
			h.startRun(`r-${String(i)}`, "big");
		}
		expect(h.getRunsForName("big")).toHaveLength(20);
	});

	it("different workflow names have independent capacities", () => {
		const h = makeHistory();
		for (let i = 0; i < 25; i++) {
			h.startRun(`wf1-${String(i)}`, "wf1");
			h.startRun(`wf2-${String(i)}`, "wf2");
		}
		expect(h.getRunsForName("wf1")).toHaveLength(20);
		expect(h.getRunsForName("wf2")).toHaveLength(20);
	});
});

// ── getRunsForName ordering ───────────────────────────────────────────────────

describe("RunHistory.getRunsForName — ordering", () => {
	it("always returns newest first regardless of insertion order", () => {
		const h = makeHistory();
		const ts = [100, 300, 200];
		ts.forEach((t, i) => h.startRun(`r${String(i)}`, "wf", t));
		// Newest (highest ts inserted last) — insertion order is what matters.
		// r0(100) → r1(300) → r2(200); last inserted = r2, so newest-first = [r2, r1, r0].
		const ids = h.getRunsForName("wf").map((r) => r.runId);
		expect(ids).toEqual(["r2", "r1", "r0"]);
	});
});

// ── totalRuns ─────────────────────────────────────────────────────────────────

describe("RunHistory.totalRuns", () => {
	it("counts runs across all workflow names", () => {
		const h = makeHistory();
		h.startRun("a1", "wf-a");
		h.startRun("a2", "wf-a");
		h.startRun("b1", "wf-b");
		expect(h.totalRuns).toBe(3);
	});

	it("is 0 for an empty store", () => {
		expect(makeHistory().totalRuns).toBe(0);
	});
});
