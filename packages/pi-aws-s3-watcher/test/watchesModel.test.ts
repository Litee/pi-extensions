import { describe, expect, it } from "vitest";

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";
import type { S3Watch } from "../src/types.js";
import {
	buildRows,
	formatRowLine,
	formatTimeLeft,
	rowStyle,
	type RowTheme,
} from "../src/ui/watchesModel.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const plainTheme: RowTheme = { fg: (_c, t) => t };
const taggedTheme: RowTheme = { fg: (c, t) => `[${c}]${t}[/]` };

function watch(
	overrides: Partial<S3Watch> & { watchId: string; bucket: string; key: string },
): S3Watch {
	return {
		profile: "p",
		region: undefined,
		target: "exists",
		timeoutAt: undefined,
		addedAt: 1,
		lastPolledAt: undefined,
		baseline: { exists: true },
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// rowStyle
// ---------------------------------------------------------------------------

describe("rowStyle", () => {
	it("terminal → success regardless of errors", () => {
		expect(rowStyle({ isTerminal: true, hasErrors: false })).toBe("success");
		expect(rowStyle({ isTerminal: true, hasErrors: true })).toBe("success");
	});

	it("non-terminal + errors → error", () => {
		expect(rowStyle({ isTerminal: false, hasErrors: true })).toBe("error");
	});

	it("non-terminal + no errors → warning", () => {
		expect(rowStyle({ isTerminal: false, hasErrors: false })).toBe("warning");
	});
});

// ---------------------------------------------------------------------------
// formatTimeLeft
// ---------------------------------------------------------------------------

describe("formatTimeLeft", () => {
	it("returns '-' when undefined", () => {
		expect(formatTimeLeft(undefined, 0)).toBe("-");
	});

	it("returns 'expired' when in the past", () => {
		expect(formatTimeLeft(5, 100)).toBe("expired");
	});

	it("returns Ns left for sub-minute futures", () => {
		expect(formatTimeLeft(30_000, 0)).toBe("30s left");
	});

	it("returns Nm left for sub-hour futures", () => {
		expect(formatTimeLeft(5 * 60_000, 0)).toBe("5m left");
	});

	it("returns Nh left for hour-plus futures", () => {
		expect(formatTimeLeft(60 * 60_000, 0)).toBe("1h left");
	});
});

// ---------------------------------------------------------------------------
// buildRows — sort / dedup / state
// ---------------------------------------------------------------------------

describe("buildRows", () => {
	it("returns an empty array for an empty map", () => {
		expect(buildRows({})).toEqual([]);
	});

	it("builds displayName as 's3://bucket/key'", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", bucket: "buck", key: "some/key.txt" }),
		});
		expect(rows[0]!.displayName).toBe("s3://buck/some/key.txt");
	});

	it("puts non-terminal watches before terminal ones", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", bucket: "b", key: "done", terminal: true, addedAt: 10 }),
			b: watch({ watchId: "b", bucket: "b", key: "live", terminal: false, addedAt: 1 }),
		});
		expect(rows.map((r) => r.key)).toEqual(["live", "done"]);
	});

	it("sorts non-terminal by addedAt descending (newest first)", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", bucket: "b", key: "old", addedAt: 1 }),
			b: watch({ watchId: "b", bucket: "b", key: "new", addedAt: 100 }),
			c: watch({ watchId: "c", bucket: "b", key: "mid", addedAt: 50 }),
		});
		expect(rows.map((r) => r.key)).toEqual(["new", "mid", "old"]);
	});

	it("derives state 'present' / 'absent' / '?' from baseline", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", bucket: "b", key: "p", baseline: { exists: true } }),
			b: watch({ watchId: "b", bucket: "b", key: "q", baseline: { exists: false } }),
			c: watch({ watchId: "c", bucket: "b", key: "r", baseline: undefined }),
		});
		const byKey = Object.fromEntries(rows.map((r) => [r.key, r.state]));
		expect(byKey).toEqual({ p: "present", q: "absent", r: "?" });
	});

	it("flags hasErrors when consecutiveErrors >= threshold", () => {
		const rows = buildRows({
			a: watch({
				watchId: "a",
				bucket: "b",
				key: "k",
				consecutiveErrors: DEFAULT_POLL_ERROR_THRESHOLD,
			}),
			b: watch({
				watchId: "b",
				bucket: "b",
				key: "k2",
				consecutiveErrors: DEFAULT_POLL_ERROR_THRESHOLD - 1,
			}),
		});
		expect(rows.find((r) => r.key === "k")?.hasErrors).toBe(true);
		expect(rows.find((r) => r.key === "k2")?.hasErrors).toBe(false);
	});

	it("deduplicates rows sharing the same displayName", () => {
		const rows = buildRows({
			a: watch({ watchId: "a", bucket: "b", key: "dup", addedAt: 2 }),
			b: watch({ watchId: "b", bucket: "b", key: "dup", addedAt: 1 }),
		});
		expect(rows).toHaveLength(1);
		// First one after sort wins (a, addedAt=2).
		expect(rows[0]!.watchId).toBe("a");
	});

	it("propagates target, profile, region, timeoutAt, lastPolledAt", () => {
		const rows = buildRows({
			a: watch({
				watchId: "a",
				bucket: "b",
				key: "k",
				target: "removed",
				profile: "alt",
				region: "us-west-2",
				timeoutAt: 9_999,
				lastPolledAt: 12_345,
			}),
		});
		expect(rows[0]).toMatchObject({
			target: "removed",
			profile: "alt",
			region: "us-west-2",
			timeoutAt: 9_999,
			lastPolledAt: 12_345,
		});
	});
});

// ---------------------------------------------------------------------------
// formatRowLine
// ---------------------------------------------------------------------------

describe("formatRowLine", () => {
	it("prefixes a selected row with a ▶ arrow", () => {
		const row = buildRows({ a: watch({ watchId: "a", bucket: "b", key: "k" }) })[0]!;
		expect(formatRowLine(row, true, 30, plainTheme)).toContain("▶");
	});

	it("does not show the arrow when not selected", () => {
		const row = buildRows({ a: watch({ watchId: "a", bucket: "b", key: "k" }) })[0]!;
		expect(formatRowLine(row, false, 30, plainTheme)).not.toContain("▶");
	});

	it("pads target column to fixed width", () => {
		const row = buildRows({ a: watch({ watchId: "a", bucket: "b", key: "k", target: "exists" }) })[0]!;
		const line = formatRowLine(row, false, 30, plainTheme);
		expect(line).toContain("exists   "); // padded to COL_TARGET=9
	});

	it("renders the state string padded to COL_STATE", () => {
		const row = buildRows({
			a: watch({ watchId: "a", bucket: "b", key: "k", baseline: { exists: true } }),
		})[0]!;
		const line = formatRowLine(row, false, 30, plainTheme);
		expect(line).toContain("present  "); // padded to COL_STATE=9
	});

	it("colours non-terminal no-error state via 'warning'", () => {
		const row = buildRows({
			a: watch({ watchId: "a", bucket: "b", key: "k", baseline: { exists: false } }),
		})[0]!;
		const line = formatRowLine(row, false, 30, taggedTheme);
		expect(line).toContain("[warning]absent");
	});

	it("colours non-terminal error state via 'error'", () => {
		const row = buildRows({
			a: watch({
				watchId: "a",
				bucket: "b",
				key: "k",
				baseline: { exists: false },
				consecutiveErrors: DEFAULT_POLL_ERROR_THRESHOLD,
			}),
		})[0]!;
		const line = formatRowLine(row, false, 30, taggedTheme);
		expect(line).toContain("[error]absent");
	});

	it("fades terminal rows entirely via the dim colour", () => {
		const row = buildRows({
			a: watch({
				watchId: "a",
				bucket: "b",
				key: "k",
				terminal: true,
				baseline: { exists: true },
			}),
		})[0]!;
		const line = formatRowLine(row, false, 30, taggedTheme);
		expect(line.startsWith("[dim]")).toBe(true);
		expect(line.endsWith("[/]")).toBe(true);
	});

	it("renders 'expired' when timeoutAt is in the past", () => {
		const row = buildRows({
			a: watch({ watchId: "a", bucket: "b", key: "k", timeoutAt: 5 }),
		})[0]!;
		const line = formatRowLine(row, false, 30, plainTheme, 100);
		expect(line).toContain("expired");
	});

	it("renders 'Ns left' for future timeoutAt", () => {
		const row = buildRows({
			a: watch({ watchId: "a", bucket: "b", key: "k", timeoutAt: 30_000 }),
		})[0]!;
		const line = formatRowLine(row, false, 30, plainTheme, 0);
		expect(line).toContain("30s left");
	});

	it("smart-compresses long S3 URIs", () => {
		const row = buildRows({
			a: watch({
				watchId: "a",
				bucket: "my-bucket",
				key: "2024/01/results/output.json",
			}),
		})[0]!;
		// Full URI is 42 chars; with colName=35 the middle segments compress.
		const line = formatRowLine(row, false, 35, plainTheme);
		expect(line).toContain("s3://my-bucket/2/0/r/output.json");
	});
});
