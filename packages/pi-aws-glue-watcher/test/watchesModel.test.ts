import { describe, expect, it } from "vitest";

import type { GlueWatch } from "../src/types.js";
import {
	buildRows,
	formatRowLine,
	stateColor,
	truncate,
	type RowTheme,
} from "../src/ui/watchesModel.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const plainTheme: RowTheme = { fg: (_c, t) => t };
const taggedTheme: RowTheme = { fg: (c, t) => `[${c}]${t}[/]` };

function job(overrides: Partial<GlueWatch> & { watchId: string; name: string }): GlueWatch {
	return {
		type: "job",
		runId: "jr_x",
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
		runId: "wr_x",
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
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
	it("returns the input unchanged when it fits", () => {
		expect(truncate("abc", 5)).toBe("abc");
		expect(truncate("abcde", 5)).toBe("abcde");
	});

	it("truncates with an ellipsis when too long", () => {
		expect(truncate("abcdef", 5)).toBe("ab...");
	});
});

// ---------------------------------------------------------------------------
// stateColor
// ---------------------------------------------------------------------------

describe("stateColor", () => {
	it.each([
		["RUNNING", "warning"],
		["STARTING", "warning"],
		["SUCCEEDED", "success"],
		["COMPLETED", "success"],
		["FAILED", "error"],
		["ERROR", "error"],
		["TIMEOUT", "error"],
		["STOPPED", "error"],
		["", "dim"],
		["PENDING", "dim"],
	])("routes %s through the %s colour", (state, expected) => {
		expect(stateColor(taggedTheme, state, "X")).toBe(`[${expected}]X[/]`);
	});
});

// ---------------------------------------------------------------------------
// buildRows — sort / expand / dedup
// ---------------------------------------------------------------------------

describe("buildRows", () => {
	it("returns an empty array for an empty map", () => {
		expect(buildRows({})).toEqual([]);
	});

	it("puts non-terminal watches before terminal ones", () => {
		const rows = buildRows({
			a: job({ watchId: "a", name: "done", terminal: true, addedAt: 10 }),
			b: job({ watchId: "b", name: "live", terminal: false, addedAt: 1 }),
		});
		expect(rows.map((r) => r.displayName)).toEqual(["live", "done"]);
	});

	it("sorts non-terminal by addedAt descending (newest first)", () => {
		const rows = buildRows({
			a: job({ watchId: "a", name: "old", addedAt: 1 }),
			b: job({ watchId: "b", name: "new", addedAt: 100 }),
			c: job({ watchId: "c", name: "mid", addedAt: 50 }),
		});
		expect(rows.map((r) => r.displayName)).toEqual(["new", "mid", "old"]);
	});

	it("expands a workflow watch into one row per unique node", () => {
		const rows = buildRows({
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
						{ name: "n1", state: "RUNNING" },
						{ name: "n2", state: "STARTING" },
					],
				},
			}),
		});
		expect(rows.map((r) => r.displayName)).toEqual(["wf/n1", "wf/n2"]);
	});

	it("skips workflow nodes with empty state, dedups by name", () => {
		const rows = buildRows({
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
					nodes: [
						{ name: "n1", state: "" },
						{ name: "n1", state: "RUNNING" },
						{ name: "n2", state: "RUNNING" },
					],
				},
			}),
		});
		expect(rows.map((r) => r.displayName)).toEqual(["wf/n1", "wf/n2"]);
	});

	it("emits a single fallback row when a workflow has no graph nodes yet", () => {
		const rows = buildRows({
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
		expect(rows).toHaveLength(1);
		expect(rows[0]!.displayName).toBe("wf");
		expect(rows[0]!.state).toBe("RUNNING");
	});

	it("deduplicates rows sharing the same displayName across watches", () => {
		const rows = buildRows({
			a: job({ watchId: "a", name: "dup", addedAt: 2 }),
			b: job({ watchId: "b", name: "dup", addedAt: 1 }),
		});
		expect(rows).toHaveLength(1);
		// The newer (a, addedAt=2) wins because it comes first after sort.
		expect(rows[0]!.watchId).toBe("a");
	});

	it("copies optional fields through for job watches", () => {
		const rows = buildRows({
			a: job({
				watchId: "a",
				name: "j",
				baseline: {
					state: "RUNNING",
					errorMessage: "",
					startedOn: "2024-01-01T00:00:00Z",
					numberOfWorkers: 4,
					workerType: "G.1X",
				},
			}),
		});
		expect(rows[0]).toMatchObject({
			startedOn: "2024-01-01T00:00:00Z",
			numberOfWorkers: 4,
			workerType: "G.1X",
		});
	});

	it("carries an empty baseline state through as the empty string", () => {
		const rows = buildRows({
			a: job({ watchId: "a", name: "j", baseline: undefined }),
		});
		expect(rows[0]!.state).toBe("");
	});
});

// ---------------------------------------------------------------------------
// formatRowLine
// ---------------------------------------------------------------------------

describe("formatRowLine", () => {
	it("prefixes a selected row with a ▶ arrow", () => {
		const row = buildRows({
			a: job({ watchId: "a", name: "j" }),
		})[0]!;
		const line = formatRowLine(row, true, 20, plainTheme);
		expect(line).toContain("▶");
	});

	it("does not show the arrow when not selected", () => {
		const row = buildRows({
			a: job({ watchId: "a", name: "j" }),
		})[0]!;
		const line = formatRowLine(row, false, 20, plainTheme);
		expect(line).not.toContain("▶");
	});

	it("pads the state column to fixed width", () => {
		const row = buildRows({
			a: job({ watchId: "a", name: "j" }),
		})[0]!;
		const line = formatRowLine(row, false, 20, plainTheme);
		// "RUNNING" (7 chars) + 5 spaces = 12 chars for the state slot
		expect(line).toContain("RUNNING     ");
	});

	it("renders a dash for the workers column when numberOfWorkers is absent", () => {
		const row = buildRows({
			a: job({ watchId: "a", name: "j" }),
		})[0]!;
		const line = formatRowLine(row, false, 20, plainTheme);
		expect(line).toContain("- ");
	});

	it("renders N×type for the workers column when present", () => {
		const row = buildRows({
			a: job({
				watchId: "a",
				name: "j",
				baseline: { state: "RUNNING", errorMessage: "", numberOfWorkers: 4, workerType: "G.1X" },
			}),
		})[0]!;
		const line = formatRowLine(row, false, 20, plainTheme);
		expect(line).toContain("4×G.1X");
	});

	it("fades terminal rows via the dim colour", () => {
		const row = buildRows({
			a: job({ watchId: "a", name: "j", terminal: true }),
		})[0]!;
		const line = formatRowLine(row, false, 20, taggedTheme);
		// The whole row should be wrapped in a dim tag.
		expect(line.startsWith("[dim]")).toBe(true);
		expect(line.endsWith("[/]")).toBe(true);
	});

	it("truncates the name with an ellipsis when it exceeds colName", () => {
		const row = buildRows({
			a: job({ watchId: "a", name: "very-long-job-name" }),
		})[0]!;
		const line = formatRowLine(row, false, 10, plainTheme);
		expect(line).toContain("very-lo...");
	});
});

// ---------------------------------------------------------------------------
// timeoutMinutes in DisplayRow (#0014)
// ---------------------------------------------------------------------------

describe("buildRows — timeoutMinutes (#0014)", () => {
	it("carries timeoutMinutes from job baseline into DisplayRow", () => {
		const w = job({ watchId: "a", name: "j", baseline: { state: "RUNNING", errorMessage: "", timeoutMinutes: 30 } });
		const rows = buildRows({ a: w });
		expect(rows[0]?.timeoutMinutes).toBe(30);
	});

	it("omits timeoutMinutes from DisplayRow when baseline has none", () => {
		const w = job({ watchId: "a", name: "j", baseline: { state: "RUNNING", errorMessage: "" } });
		const rows = buildRows({ a: w });
		expect(rows[0]?.timeoutMinutes).toBeUndefined();
	});
});
