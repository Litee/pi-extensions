import { describe, expect, it } from "vitest";

import type { GlueWatch } from "../src/types.js";
import {
	buildWidgetEntries,
	renderEntryLine,
	stateStyle,
	type WidgetTheme,
} from "../src/ui/widgetRows.js";
import { formatElapsed, formatHeaderCountsSuffix } from "../src/ui/glue-widget.js";

const plainTheme: WidgetTheme = { fg: (_c, t) => t };
const taggedTheme: WidgetTheme = { fg: (c, t) => `[${c}]${t}[/]` };

function job(overrides: Partial<GlueWatch> & { watchId: string; name: string }): GlueWatch {
	return {
		type: "job",
		runId: "jr",
		profile: "p",
		region: undefined,
		addedAt: 1,
		lastPolledAt: undefined,
		baseline: { state: "RUNNING", errorMessage: "" },
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

function workflow(
	overrides: Partial<GlueWatch> & { watchId: string; name: string },
): GlueWatch {
	return {
		type: "workflow",
		runId: "wr",
		profile: "p",
		region: undefined,
		addedAt: 1,
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// stateStyle
// ---------------------------------------------------------------------------

describe("stateStyle", () => {
	it.each([
		["RUNNING", "warning"],
		["STARTING", "warning"],
		["SUCCEEDED", "success"],
		["COMPLETED", "success"],
		["FAILED", "error"],
		["ERROR", "error"],
		["TIMEOUT", "error"],
		["STOPPED", "error"],
		["", "none"],
		["PENDING", "none"],
	])("classifies %s as %s", (state, expected) => {
		expect(stateStyle(state)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// buildWidgetEntries
// ---------------------------------------------------------------------------

describe("buildWidgetEntries", () => {
	it("includes terminal watches with isTerminal=true", () => {
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "live" }),
			b: job({ watchId: "b", name: "done", terminal: true }),
		});
		expect(entries.map((e) => e.displayName)).toContain("live [jr]");
		expect(entries.map((e) => e.displayName)).toContain("done [jr]");
		const doneEntry = entries.find((e) => e.displayName === "done [jr]");
		expect(doneEntry?.isTerminal).toBe(true);
		const liveEntry = entries.find((e) => e.displayName === "live [jr]");
		expect(liveEntry?.isTerminal).toBe(false);
	});

	it("emits a single entry per job watch", () => {
		const entries = buildWidgetEntries({
			a: job({
				watchId: "a",
				name: "j",
				baseline: {
					state: "RUNNING",
					errorMessage: "",
					startedOn: "2024-01-01T00:00:00Z",
					numberOfWorkers: 2,
					workerType: "G.2X",
				},
			}),
		});
		expect(entries).toEqual([
			expect.objectContaining({
				displayName: "j [jr]",
				state: "RUNNING",
				startedOn: "2024-01-01T00:00:00Z",
				numberOfWorkers: 2,
				workerType: "G.2X",
				isTerminal: false,
			}),
		]);
	});

	it("expands workflow nodes with non-empty state and dedupes by node name", () => {
		const entries = buildWidgetEntries({
			w: workflow({
				watchId: "w",
				name: "wf",
				baseline: {
					state: "RUNNING",
					totalActions: 2,
					succeededActions: 0,
					failedActions: 0,
					runningActions: 2,
					reportedFailedNodes: [],
					nodes: [
						{ name: "n1", state: "" },
						{ name: "n1", state: "RUNNING" },
						{ name: "n2", state: "STARTING" },
					],
				},
			}),
		});
		expect(entries.map((e) => e.displayName)).toEqual(["wf [wr]/n1", "wf [wr]/n2"]);
	});

	it("emits a fallback entry for a workflow with no graph nodes", () => {
		const entries = buildWidgetEntries({
			w: workflow({
				watchId: "w",
				name: "wf",
				baseline: {
					state: "RUNNING",
					totalActions: 0,
					succeededActions: 0,
					failedActions: 0,
					runningActions: 0,
					reportedFailedNodes: [],
				},
			}),
		});
		expect(entries).toEqual([expect.objectContaining({ displayName: "wf [wr]", state: "RUNNING", isTerminal: false })]);
	});

	it("deduplicates entries that share a displayName", () => {
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "dup" }),
			b: job({ watchId: "b", name: "dup" }),
		});
		expect(entries).toHaveLength(1);
	});

	it("falls back to bare watch.name when runId is empty string", () => {
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "my-job", runId: "" }),
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]!.displayName).toBe("my-job");
	});

	it("does NOT deduplicate job watches with the same name but different runIds", () => {
		// Regression: re-running the same job produced two watches that were
		// silently collapsed into one because displayName was just watch.name.
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "my-job", runId: "jr_aaaaaa01" }),
			b: job({ watchId: "b", name: "my-job", runId: "jr_bbbbbb02" }),
		});
		expect(entries).toHaveLength(2);
		const names = entries.map((e) => e.displayName);
		expect(names).toContain("my-job [aa01]");
		expect(names).toContain("my-job [bb02]");
	});

	it("does NOT deduplicate workflow watches with the same name but different runIds (node entries)", () => {
		const nodes = [
			{ name: "step-1", state: "SUCCEEDED" },
			{ name: "step-2", state: "RUNNING" },
		];
		const entries = buildWidgetEntries({
			a: workflow({ watchId: "a", name: "my-wf", runId: "wr_aaaaaa01", baseline: { state: "RUNNING", totalActions: 2, succeededActions: 1, failedActions: 0, runningActions: 1, reportedFailedNodes: [], nodes } }),
			b: workflow({ watchId: "b", name: "my-wf", runId: "wr_bbbbbb02", baseline: { state: "RUNNING", totalActions: 2, succeededActions: 0, failedActions: 0, runningActions: 2, reportedFailedNodes: [], nodes } }),
		});
		expect(entries).toHaveLength(4); // 2 runs × 2 nodes
		const names = entries.map((e) => e.displayName);
		expect(names).toContain("my-wf [aa01]/step-1");
		expect(names).toContain("my-wf [bb02]/step-1");
	});

	it("does NOT deduplicate workflow fallback entries with the same name but different runIds", () => {
		const baseline = { state: "RUNNING", totalActions: 0, succeededActions: 0, failedActions: 0, runningActions: 0, reportedFailedNodes: [] };
		const entries = buildWidgetEntries({
			a: workflow({ watchId: "a", name: "my-wf", runId: "wr_aaaaaa01", baseline }),
			b: workflow({ watchId: "b", name: "my-wf", runId: "wr_bbbbbb02", baseline }),
		});
		expect(entries).toHaveLength(2);
		const names = entries.map((e) => e.displayName);
		expect(names).toContain("my-wf [aa01]");
		expect(names).toContain("my-wf [bb02]");
	});

	// -------------------------------------------------------------------------
	// Sorting: terminal entries always after non-terminal
	// -------------------------------------------------------------------------

	it("terminal entries sort after non-terminal even when terminal state has priority 0 (FAILED)", () => {
		// A terminal FAILED job should come AFTER a non-terminal RUNNING job.
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "running-active", terminal: false, baseline: { state: "RUNNING", errorMessage: "" } }),
			b: job({ watchId: "b", name: "failed-done", terminal: true, baseline: { state: "FAILED", errorMessage: "" } }),
		});
		const names = entries.map((e) => e.displayName);
		expect(names.indexOf("running-active [jr]")).toBeLessThan(names.indexOf("failed-done [jr]"));
	});

	it("sorts workflow nodes so RUNNING appears before SUCCEEDED", () => {
		const entries = buildWidgetEntries({
			w: workflow({
				watchId: "w",
				name: "wf",
				baseline: {
					state: "RUNNING",
					totalActions: 2,
					succeededActions: 1,
					failedActions: 0,
					runningActions: 1,
					reportedFailedNodes: [],
					nodes: [
						{ name: "step-1", state: "SUCCEEDED" },
						{ name: "step-2", state: "RUNNING" },
					],
				},
			}),
		});
		const names = entries.map((e) => e.displayName);
		// RUNNING (non-terminal) before SUCCEEDED (terminal)
		expect(names.indexOf("wf [wr]/step-2")).toBeLessThan(names.indexOf("wf [wr]/step-1"));
	});

	it("orders entries: non-terminal (RUNNING/PENDING) before terminal (FAILED/SUCCEEDED)", () => {
		const entries = buildWidgetEntries({
			w: workflow({
				watchId: "w",
				name: "wf",
				baseline: {
					state: "RUNNING",
					totalActions: 4,
					succeededActions: 1,
					failedActions: 1,
					runningActions: 1,
					reportedFailedNodes: [],
					nodes: [
						{ name: "s", state: "SUCCEEDED" },
						{ name: "f", state: "FAILED" },
						{ name: "r", state: "RUNNING" },
						{ name: "p", state: "PENDING" },
					],
				},
			}),
		});
		const names = entries.map((e) => e.displayName);
		// Non-terminal first (RUNNING=warning rank1, PENDING=none rank1), then terminal (FAILED, SUCCEEDED)
		expect(names.indexOf("wf [wr]/r")).toBeLessThan(names.indexOf("wf [wr]/f"));
		expect(names.indexOf("wf [wr]/r")).toBeLessThan(names.indexOf("wf [wr]/s"));
		expect(names.indexOf("wf [wr]/p")).toBeLessThan(names.indexOf("wf [wr]/f"));
		expect(names.indexOf("wf [wr]/p")).toBeLessThan(names.indexOf("wf [wr]/s"));
	});

	it("within the same priority, sorts by startedOn descending (newest first)", () => {
		const entries = buildWidgetEntries({
			a: job({
				watchId: "a",
				name: "newer",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: "2024-01-01T02:00:00Z" },
			}),
			b: job({
				watchId: "b",
				name: "older",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: "2024-01-01T01:00:00Z" },
			}),
		});
		expect(entries.map((e) => e.displayName)).toEqual(["newer [jr]", "older [jr]"]);
	});

	it("within the same priority, entries without startedOn trail those with startedOn", () => {
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "no-start", baseline: { state: "RUNNING", errorMessage: "" } }),
			b: job({
				watchId: "b",
				name: "has-start",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: "2024-01-01T01:00:00Z" },
			}),
		});
		expect(entries.map((e) => e.displayName)).toEqual(["has-start [jr]", "no-start [jr]"]);
	});

	// -------------------------------------------------------------------------
	// isTerminal derivation for workflow nodes
	// -------------------------------------------------------------------------

	it("marks workflow node entries as isTerminal=true when node state is success or error", () => {
		const entries = buildWidgetEntries({
			w: workflow({
				watchId: "w",
				name: "wf",
				baseline: {
					state: "RUNNING",
					totalActions: 3,
					succeededActions: 1,
					failedActions: 1,
					runningActions: 1,
					reportedFailedNodes: [],
					nodes: [
						{ name: "running-node", state: "RUNNING" },
						{ name: "succeeded-node", state: "SUCCEEDED" },
						{ name: "failed-node", state: "FAILED" },
					],
				},
			}),
		});
		const byName = Object.fromEntries(entries.map((e) => [e.displayName, e]));
		expect(byName["wf [wr]/running-node"]?.isTerminal).toBe(false);
		expect(byName["wf [wr]/succeeded-node"]?.isTerminal).toBe(true);
		expect(byName["wf [wr]/failed-node"]?.isTerminal).toBe(true);
	});

	it("workflow fallback entry (no nodes) uses watch.terminal for isTerminal", () => {
		const entries = buildWidgetEntries({
			w: workflow({
				watchId: "w",
				name: "wf",
				terminal: true,
				baseline: {
					state: "SUCCEEDED",
					totalActions: 0,
					succeededActions: 0,
					failedActions: 0,
					runningActions: 0,
					reportedFailedNodes: [],
				},
			}),
		});
		expect(entries[0]?.isTerminal).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// renderEntryLine
// ---------------------------------------------------------------------------

describe("renderEntryLine", () => {
	it("pads the name column to colName width", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING", isTerminal: false },
			10,
			plainTheme,
		);
		// name "j" padded to 10 chars → "j         "
		expect(line).toContain("j         ");
	});

	it("truncates a long name with ellipsis", () => {
		const line = renderEntryLine(
			{ displayName: "very-long-name", state: "RUNNING", isTerminal: false },
			8,
			plainTheme,
		);
		expect(line).toContain("very-...");
	});

	it("renders '-' for workers when numberOfWorkers is absent", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING", isTerminal: false },
			10,
			plainTheme,
		);
		expect(line).toMatch(/-\s*$/);
	});

	it("renders N×type for workers when present", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING", numberOfWorkers: 3, workerType: "G.1X", isTerminal: false },
			10,
			plainTheme,
		);
		expect(line).toContain("3×G.1X");
	});

	it("applies the appropriate colour to the state slot", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "SUCCEEDED", isTerminal: false },
			10,
			taggedTheme,
		);
		expect(line).toContain("[success]");
	});

	it("leaves unknown states uncoloured", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "MYSTERY", isTerminal: false },
			10,
			taggedTheme,
		);
		// 'MYSTERY' is classified as "none" — the state slot is not wrapped.
		expect(line).toContain("MYSTERY");
		expect(line).not.toContain("[warning]MYSTERY");
		expect(line).not.toContain("[success]MYSTERY");
		expect(line).not.toContain("[error]MYSTERY");
	});

	it("renders '?' when state is empty", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "", isTerminal: false },
			10,
			plainTheme,
		);
		expect(line).toContain("?");
	});

	it("wraps the entire line in [dim]...[/] when isTerminal is true", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "SUCCEEDED", isTerminal: true },
			10,
			taggedTheme,
		);
		expect(line).toMatch(/^\[dim\].+\[\/\]$/);
	});

	it("does NOT wrap line in dim when isTerminal is false", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING", isTerminal: false },
			10,
			taggedTheme,
		);
		expect(line).not.toMatch(/^\[dim\]/);
	});
});

// ---------------------------------------------------------------------------
// formatElapsed — frozen elapsed for terminal runs (completedOn provided)
// ---------------------------------------------------------------------------

describe("formatElapsed", () => {
	it("returns '-' when startedOn is undefined", () => {
		expect(formatElapsed(undefined)).toBe("-");
	});

	it("returns the frozen run duration when completedOn is provided", () => {
		// 1h 30m apart — must NOT depend on Date.now().
		const started = "2024-01-01T00:00:00Z";
		const completed = "2024-01-01T01:30:00Z";
		expect(formatElapsed(started, completed)).toBe("1h30m");
	});

	it("freezes elapsed time at completedOn even after wall-clock advances", () => {
		// Without the freeze, Date.now() - startedOn would balloon as the
		// permanent panel ticked through 30s refreshes.
		const started = "2000-01-01T00:00:00Z";
		const completed = "2000-01-01T00:00:45Z";
		expect(formatElapsed(started, completed)).toBe("45s");
	});

	it("falls back to live elapsed when completedOn is undefined", () => {
		// Sanity: ongoing runs still tick from now.
		const now = Date.now();
		const tenSecondsAgo = new Date(now - 10_000).toISOString();
		expect(formatElapsed(tenSecondsAgo)).toMatch(/^\d+s$/);
	});
});

// ---------------------------------------------------------------------------
// renderEntryLine — terminal-state rows freeze elapsed time at completedOn
// ---------------------------------------------------------------------------

describe("renderEntryLine + completedOn", () => {
	it("renders frozen elapsed for terminal nodes (completedOn set)", () => {
		const line = renderEntryLine(
			{
				displayName: "wf [wr]/n1",
				state: "SUCCEEDED",
				startedOn: "2000-01-01T00:00:00Z",
				completedOn: "2000-01-01T00:02:00Z",
				isTerminal: true,
			},
			20,
			plainTheme,
		);
		// Should show "2m" — frozen duration — not minutes-since-2000.
		expect(line).toContain("2m");
		expect(line).not.toMatch(/\b\d+h/);
	});
});

// ---------------------------------------------------------------------------
// buildWidgetEntries — completedOn flows from baseline into widget entries
// ---------------------------------------------------------------------------

describe("buildWidgetEntries + completedOn", () => {
	it("propagates completedOn from a job baseline", () => {
		const entries = buildWidgetEntries({
			a: job({
				watchId: "a",
				name: "j",
				baseline: {
					state: "RUNNING",
					errorMessage: "",
					startedOn: "2024-01-01T00:00:00Z",
					completedOn: "2024-01-01T00:05:00Z",
				},
			}),
		});
		expect(entries[0]?.completedOn).toBe("2024-01-01T00:05:00Z");
	});

	it("propagates completedOn from each workflow node", () => {
		const entries = buildWidgetEntries({
			w: workflow({
				watchId: "w",
				name: "wf",
				baseline: {
					state: "RUNNING",
					totalActions: 2,
					succeededActions: 1,
					failedActions: 0,
					runningActions: 1,
					reportedFailedNodes: [],
					nodes: [
						{
							name: "done",
							state: "SUCCEEDED",
							startedOn: "2024-01-01T00:00:00Z",
							completedOn: "2024-01-01T00:01:30Z",
						},
						{ name: "live", state: "RUNNING", startedOn: "2024-01-01T00:00:30Z" },
					],
				},
			}),
		});
		const done = entries.find((e) => e.displayName === "wf [wr]/done");
		const live = entries.find((e) => e.displayName === "wf [wr]/live");
		expect(done?.completedOn).toBe("2024-01-01T00:01:30Z");
		expect(live?.completedOn).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// formatHeaderCountsSuffix — header "(M/N)" reflects M succeeded / N total
// ---------------------------------------------------------------------------

describe("formatHeaderCountsSuffix", () => {
	it("returns ' (0/0)' when no watches are present", () => {
		expect(formatHeaderCountsSuffix({}, 60_000)).toBe(" (0/0)");
	});

	it("returns ' (0/N)' when all watches are active (none succeeded)", () => {
		const watches: Record<string, GlueWatch> = {
			j1: job({ watchId: "j1", name: "a" }),
			j2: job({ watchId: "j2", name: "b" }),
			j3: job({ watchId: "j3", name: "c" }),
		};
		expect(formatHeaderCountsSuffix(watches, 120_000)).toBe(" (0/3)");
	});

	it("returns ' (M/N)' when some watches have succeeded", () => {
		const watches: Record<string, GlueWatch> = {
			j1: job({ watchId: "j1", name: "a", baseline: { state: "SUCCEEDED", errorMessage: "" } }),
			j2: job({ watchId: "j2", name: "b" }),
			j3: job({ watchId: "j3", name: "c", baseline: { state: "COMPLETED", errorMessage: "" } }),
		};
		expect(formatHeaderCountsSuffix(watches, 120_000)).toBe(" (2/3)");
	});

	it("counts each workflow as 1 even when its graph expands into many nodes", () => {
		const watches: Record<string, GlueWatch> = {
			wf: {
				watchId: "wf",
				type: "workflow",
				name: "my-wf",
				runId: "wr_1",
				profile: "p",
				region: undefined,
				addedAt: 1,
				lastPolledAt: undefined,
				baseline: {
					state: "RUNNING",
					errorMessage: "",
					nodes: [
						{ name: "step-1", state: "SUCCEEDED" },
						{ name: "step-2", state: "RUNNING" },
						{ name: "step-3", state: "RUNNING" },
					],
				},
				terminal: false,
				consecutiveErrors: 0,
			},
			j1: job({ watchId: "j1", name: "job-a" }),
			j2: job({ watchId: "j2", name: "job-b" }),
			j3: job({ watchId: "j3", name: "job-c" }),
		};
		// workflow not succeeded + 3 RUNNING jobs → M=0, N=4
		expect(formatHeaderCountsSuffix(watches, 120_000)).toBe(" (0/4)");
	});

	it("includes terminal watches in N count", () => {
		const watches: Record<string, GlueWatch> = {
			j1: job({ watchId: "j1", name: "a" }),
			j2: job({ watchId: "j2", name: "b", terminal: true, baseline: { state: "SUCCEEDED", errorMessage: "" } }),
			j3: job({ watchId: "j3", name: "c" }),
		};
		// 1 succeeded (j2), 3 total → " (1/3)"
		expect(formatHeaderCountsSuffix(watches, 30_000)).toBe(" (1/3)");
	});

	it("appends \" ⚠\" when a watch has a FAILED state", () => {
		const watches: Record<string, GlueWatch> = {
			j1: job({ watchId: "j1", name: "a", baseline: { state: "SUCCEEDED", errorMessage: "" } }),
			j2: job({ watchId: "j2", name: "b", baseline: { state: "FAILED", errorMessage: "oops" } }),
			j3: job({ watchId: "j3", name: "c" }),
		};
		expect(formatHeaderCountsSuffix(watches, 120_000)).toBe(" (1/3) ⚠");
	});

	it("appends \" ⚠\" when hasErrors flag is true", () => {
		const watches: Record<string, GlueWatch> = {
			j1: job({ watchId: "j1", name: "a" }),
			j2: job({ watchId: "j2", name: "b" }),
		};
		expect(formatHeaderCountsSuffix(watches, 120_000, { hasErrors: true })).toBe(" (0/2) ⚠");
	});
});

// ---------------------------------------------------------------------------
// Additional coverage: workflow node optional fields and sort edge cases
// ---------------------------------------------------------------------------
describe("buildWidgetEntries — workflow node optional fields", () => {
	it("propagates numberOfWorkers and workerType from workflow nodes", () => {
		const entries = buildWidgetEntries({
			w: workflow({
				watchId: "w",
				name: "wf",
				baseline: {
					state: "RUNNING",
					totalActions: 1,
					succeededActions: 0,
					failedActions: 0,
					runningActions: 1,
					reportedFailedNodes: [],
					nodes: [{
						name: "step",
						state: "RUNNING",
						numberOfWorkers: 5,
						workerType: "G.2X",
					}],
				},
			}),
		});
		const entry = entries.find((e) => e.displayName === "wf [wr]/step");
		expect(entry?.numberOfWorkers).toBe(5);
		expect(entry?.workerType).toBe("G.2X");
	});
});

describe("buildWidgetEntries — sort edge cases", () => {
	it("returns stable order when two entries have equal startedOn", () => {
		const same = "2024-01-01T00:00:00Z";
		const entries = buildWidgetEntries({
			a: job({
				watchId: "a",
				name: "j-a",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: same },
			}),
			b: job({
				watchId: "b",
				name: "j-b",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: same },
			}),
		});
		// Both have same priority and same startedOn → stable, just 2 entries
		expect(entries).toHaveLength(2);
	});

	it("places terminal entries after non-terminal when mixed", () => {
		const entries = buildWidgetEntries({
			t: job({ watchId: "t", name: "terminal", terminal: true, baseline: { state: "SUCCEEDED", errorMessage: "" } }),
			a: job({ watchId: "a", name: "active" }),
		});
		expect(entries[0]?.isTerminal).toBe(false);
		expect(entries[1]?.isTerminal).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: renderEntryLine — workerType ?? "?" and pollIntervalMs branch
// ---------------------------------------------------------------------------

describe("renderEntryLine — uncovered branches", () => {
	it("renders N×? when numberOfWorkers is set but workerType is absent (hits ?? '?' branch)", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING", numberOfWorkers: 5, isTerminal: false },
			10,
			plainTheme,
		);
		expect(line).toContain("5×?");
	});

	it("renders the poll interval in seconds when pollIntervalMs is defined (truthy branch)", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING", isTerminal: false, pollIntervalMs: 60_000 },
			10,
			plainTheme,
		);
		// 60 000 ms → 60 s
		expect(line).toContain("60s");
	});

	it("renders '-' for interval when pollIntervalMs is undefined (falsy branch)", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING", isTerminal: false },
			10,
			plainTheme,
		);
		// No pollIntervalMs → intervalSec === undefined → rendered as "-"
		expect(line).toContain("-");
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: sort comparator — force compare(older, newer) to hit return 1
// ---------------------------------------------------------------------------

describe("buildWidgetEntries — sort comparator return-1 and return-1/0 via multi-entry ordering", () => {
	it("correctly sorts three RUNNING entries: newest first, forcing all startedOn comparison paths", () => {
		// With three entries in OLDEST→MIDDLE→NEWEST insertion order, the sort
		// comparator must compare (oldest, newest) → oldest.startedOn < newest.startedOn
		// → return 1 (hits the inner ternary's '1' branch on line 164).
		const entries = buildWidgetEntries({
			a: job({
				watchId: "a",
				name: "oldest",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: "2024-01-01T01:00:00Z" },
			}),
			b: job({
				watchId: "b",
				name: "middle",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: "2024-01-01T02:00:00Z" },
			}),
			c: job({
				watchId: "c",
				name: "newest",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: "2024-01-01T03:00:00Z" },
			}),
		});
		const names = entries.map((e) => e.displayName);
		// Sorted descending by startedOn: newest first
		expect(names.indexOf("newest [jr]")).toBeLessThan(names.indexOf("middle [jr]"));
		expect(names.indexOf("middle [jr]")).toBeLessThan(names.indexOf("oldest [jr]"));
	});

	it("places entry-without-startedOn after entries-with-startedOn when b has startedOn but a does not (line 166)", () => {
		// Entries: [no-start, with-start]. Compare(no-start, with-start):
		//   a.startedOn && b.startedOn → false (a has none)
		//   if (a.startedOn) → false
		//   if (b.startedOn) → true → return 1  (hits line 166 truthy branch)
		const entries = buildWidgetEntries({
			x: job({ watchId: "x", name: "no-start", baseline: { state: "RUNNING", errorMessage: "" } }),
			y: job({
				watchId: "y",
				name: "with-start",
				baseline: { state: "RUNNING", errorMessage: "", startedOn: "2024-01-01T00:00:00Z" },
			}),
		});
		const names = entries.map((e) => e.displayName);
		expect(names.indexOf("with-start [jr]")).toBeLessThan(names.indexOf("no-start [jr]"));
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: workflow fallback with undefined baseline (lines 135-138)
// ---------------------------------------------------------------------------

describe("buildWidgetEntries — workflow fallback with undefined baseline", () => {
	it("produces a fallback entry with empty state when workflow has no baseline (b?.state ?? '' false branch)", () => {
		// `watch.baseline` is undefined → `b` is undefined → `b?.state ?? ""` returns ""
		// and `b?.state ?? ""` on line 138 also returns "".
		// This covers the false-side of the `??` on lines 135 and 138.
		const entries = buildWidgetEntries({
			w: workflow({ watchId: "w", name: "no-baseline-wf" }),
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]?.state).toBe("");
		expect(entries[0]?.isTerminal).toBe(false);
	});

	it("uses bare watch.name (no runId suffix) in fallback when runId is empty (cond-expr false on line 137)", () => {
		// `watch.runId` is empty string → falsy → displayName = watch.name (not `${name} [${runId.slice(-4)}]`)
		const entries = buildWidgetEntries({
			w: workflow({ watchId: "w", name: "bare-name", runId: "" }),
		});
		expect(entries[0]?.displayName).toBe("bare-name");
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: sort comparator line 166 FALSE branch
// — both a and b lack startedOn → `if (b.startedOn)` is false → falls through to return 0
// ---------------------------------------------------------------------------

describe("buildWidgetEntries — sort comparator: both entries lack startedOn", () => {
	it("returns stable 2-element result when neither entry has startedOn (false branch of line 166)", () => {
		// When both a and b have no startedOn:
		//   a.startedOn && b.startedOn → false (line 164)
		//   if (a.startedOn) → false (line 165)
		//   if (b.startedOn) → false (line 166, FALSE branch)
		//   → return 0
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "no-start-a", baseline: { state: "RUNNING", errorMessage: "" } }),
			b: job({ watchId: "b", name: "no-start-b", baseline: { state: "RUNNING", errorMessage: "" } }),
		});
		// Both have no startedOn and same state: sort is stable, just 2 entries
		expect(entries).toHaveLength(2);
	});
});
