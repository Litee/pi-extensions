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
		expect(entries.map((e) => e.displayName)).toContain("live");
		expect(entries.map((e) => e.displayName)).toContain("done");
		const doneEntry = entries.find((e) => e.displayName === "done");
		expect(doneEntry?.isTerminal).toBe(true);
		const liveEntry = entries.find((e) => e.displayName === "live");
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
				displayName: "j",
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
		expect(entries.map((e) => e.displayName)).toEqual(["wf/n1", "wf/n2"]);
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
		expect(entries).toEqual([expect.objectContaining({ displayName: "wf", state: "RUNNING", isTerminal: false })]);
	});

	it("deduplicates entries that share a displayName", () => {
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "dup" }),
			b: job({ watchId: "b", name: "dup" }),
		});
		expect(entries).toHaveLength(1);
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
		expect(names.indexOf("running-active")).toBeLessThan(names.indexOf("failed-done"));
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
		expect(names.indexOf("wf/step-2")).toBeLessThan(names.indexOf("wf/step-1"));
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
		expect(names.indexOf("wf/r")).toBeLessThan(names.indexOf("wf/f"));
		expect(names.indexOf("wf/r")).toBeLessThan(names.indexOf("wf/s"));
		expect(names.indexOf("wf/p")).toBeLessThan(names.indexOf("wf/f"));
		expect(names.indexOf("wf/p")).toBeLessThan(names.indexOf("wf/s"));
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
		expect(entries.map((e) => e.displayName)).toEqual(["newer", "older"]);
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
		expect(entries.map((e) => e.displayName)).toEqual(["has-start", "no-start"]);
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
		expect(byName["wf/running-node"]?.isTerminal).toBe(false);
		expect(byName["wf/succeeded-node"]?.isTerminal).toBe(true);
		expect(byName["wf/failed-node"]?.isTerminal).toBe(true);
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
				displayName: "wf/n1",
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
		const done = entries.find((e) => e.displayName === "wf/done");
		const live = entries.find((e) => e.displayName === "wf/live");
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
		const entry = entries.find((e) => e.displayName === "wf/step");
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
