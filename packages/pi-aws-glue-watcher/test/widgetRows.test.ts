import { describe, expect, it } from "vitest";

import type { GlueWatch } from "../src/types.js";
import {
	buildWidgetEntries,
	renderEntryLine,
	stateStyle,
	type WidgetTheme,
} from "../src/ui/widgetRows.js";
import { formatHeaderCountsSuffix } from "../src/ui/glue-widget.js";

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
	it("excludes terminal watches", () => {
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "live" }),
			b: job({ watchId: "b", name: "done", terminal: true }),
		});
		expect(entries.map((e) => e.displayName)).toEqual(["live"]);
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
			{
				displayName: "j",
				state: "RUNNING",
				startedOn: "2024-01-01T00:00:00Z",
				numberOfWorkers: 2,
				workerType: "G.2X",
			},
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
		expect(entries).toEqual([{ displayName: "wf", state: "RUNNING" }]);
	});

	it("deduplicates entries that share a displayName", () => {
		const entries = buildWidgetEntries({
			a: job({ watchId: "a", name: "dup" }),
			b: job({ watchId: "b", name: "dup" }),
		});
		expect(entries).toHaveLength(1);
	});

	// -------------------------------------------------------------------------
	// Sorting: priority order + startedOn tiebreak
	// -------------------------------------------------------------------------

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
		expect(entries.map((e) => e.displayName)).toEqual(["wf/step-2", "wf/step-1"]);
	});

	it("orders entries: FAILED > RUNNING = PENDING > SUCCEEDED", () => {
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
		expect(entries.map((e) => e.displayName)).toEqual([
			"wf/f", // FAILED  → error   rank 0
			"wf/r", // RUNNING → active  rank 1
			"wf/p", // PENDING → active  rank 1
			"wf/s", // SUCCEEDED → success rank 2
		]);
	});

	it("within the same priority, sorts by startedOn ascending (longest-running first)", () => {
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
		expect(entries.map((e) => e.displayName)).toEqual(["older", "newer"]);
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
});

// ---------------------------------------------------------------------------
// renderEntryLine
// ---------------------------------------------------------------------------

describe("renderEntryLine", () => {
	it("pads the name column to colName width", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING" },
			10,
			plainTheme,
		);
		// name "j" padded to 10 chars → "j         "
		expect(line).toContain("j         ");
	});

	it("truncates a long name with ellipsis", () => {
		const line = renderEntryLine(
			{ displayName: "very-long-name", state: "RUNNING" },
			8,
			plainTheme,
		);
		expect(line).toContain("very-...");
	});

	it("renders '-' for workers when numberOfWorkers is absent", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING" },
			10,
			plainTheme,
		);
		expect(line).toMatch(/-\s*$/);
	});

	it("renders N×type for workers when present", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "RUNNING", numberOfWorkers: 3, workerType: "G.1X" },
			10,
			plainTheme,
		);
		expect(line).toContain("3×G.1X");
	});

	it("applies the appropriate colour to the state slot", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "SUCCEEDED" },
			10,
			taggedTheme,
		);
		expect(line).toContain("[success]");
	});

	it("leaves unknown states uncoloured", () => {
		const line = renderEntryLine(
			{ displayName: "j", state: "MYSTERY" },
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
			{ displayName: "j", state: "" },
			10,
			plainTheme,
		);
		expect(line).toContain("?");
	});
});

// ---------------------------------------------------------------------------
// formatHeaderCountsSuffix — header "(N)" reflects distinct non-terminal
// watches, not expanded per-node rows. See aws-glue-watcher#0001.
// ---------------------------------------------------------------------------

describe("formatHeaderCountsSuffix", () => {
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
		// 1 workflow + 3 jobs = 4, NOT 3 nodes + 3 jobs = 6.
		expect(formatHeaderCountsSuffix(watches, 120_000)).toBe(" (4)  poll: 120s");
	});

	it("excludes terminal watches from the count", () => {
		const watches: Record<string, GlueWatch> = {
			j1: job({ watchId: "j1", name: "a" }),
			j2: job({ watchId: "j2", name: "b", terminal: true }),
			j3: job({ watchId: "j3", name: "c" }),
		};
		expect(formatHeaderCountsSuffix(watches, 30_000)).toBe(" (2)  poll: 30s");
	});

	it("renders zero when no watches are present", () => {
		expect(formatHeaderCountsSuffix({}, 60_000)).toBe(" (0)  poll: 60s");
	});
});
