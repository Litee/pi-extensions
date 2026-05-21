import { describe, expect, it } from "vitest";

import { DEFAULT_POLL_ERROR_THRESHOLD } from "pi-watcher-core/error-tracker";
import type { S3Watch } from "../src/types.js";
import {
	buildWidgetEntries,
	renderEntryLine,
	watchStyle,
	type WidgetEntry,
	type WidgetTheme,
} from "../src/ui/widgetRows.js";
import { formatHeaderSuffix } from "../src/ui/s3-widget.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const plainTheme: WidgetTheme = { fg: (_c, t) => t };
const taggedTheme: WidgetTheme = { fg: (c, t) => `[${c}]${t}[/]` };

function makeWatch(overrides: Partial<S3Watch> & { watchId: string; bucket: string; key: string }): S3Watch {
	return {
		profile: "p",
		region: undefined,
		target: "exists",
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

function makeEntry(overrides: Partial<WidgetEntry> = {}): WidgetEntry {
	return {
		displayName: "s3://bucket/key",
		target: "exists",
		state: "?",
		timeoutAt: undefined,
		addedAt: 1_000,
		hasErrors: false,
		terminal: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// watchStyle
// ---------------------------------------------------------------------------

describe("watchStyle", () => {
	it("non-terminal with errors → 'error'", () => {
		expect(watchStyle(makeEntry({ terminal: false, hasErrors: true }))).toBe("error");
	});

	it("non-terminal without errors → 'warning'", () => {
		expect(watchStyle(makeEntry({ terminal: false, hasErrors: false }))).toBe("warning");
	});

	it("terminal → 'success' regardless of hasErrors", () => {
		expect(watchStyle(makeEntry({ terminal: true, hasErrors: false }))).toBe("success");
		expect(watchStyle(makeEntry({ terminal: true, hasErrors: true }))).toBe("success");
	});
});

// ---------------------------------------------------------------------------
// buildWidgetEntries
// ---------------------------------------------------------------------------

describe("buildWidgetEntries", () => {
	it("excludes terminal watches", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k1" }),
			b: makeWatch({ watchId: "b", bucket: "b", key: "k2", terminal: true }),
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]!.displayName).toBe("s3://b/k1");
	});

	it("builds displayName as 's3://bucket/key'", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "my-bucket", key: "some/prefix/file.txt" }),
		});
		expect(entries[0]!.displayName).toBe("s3://my-bucket/some/prefix/file.txt");
	});

	it("state is 'present' when baseline.exists=true", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k", baseline: { exists: true } }),
		});
		expect(entries[0]!.state).toBe("present");
	});

	it("state is 'absent' when baseline.exists=false", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k", baseline: { exists: false } }),
		});
		expect(entries[0]!.state).toBe("absent");
	});

	it("state is '?' when baseline is undefined", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k", baseline: undefined }),
		});
		expect(entries[0]!.state).toBe("?");
	});

	it("propagates target, timeoutAt, addedAt", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k", target: "removed", timeoutAt: 99_999, addedAt: 12_345 }),
		});
		expect(entries[0]!.target).toBe("removed");
		expect(entries[0]!.timeoutAt).toBe(99_999);
		expect(entries[0]!.addedAt).toBe(12_345);
	});

	it("hasErrors=true when consecutiveErrors >= threshold", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k", consecutiveErrors: DEFAULT_POLL_ERROR_THRESHOLD }),
		});
		expect(entries[0]!.hasErrors).toBe(true);
	});

	it("hasErrors=false when consecutiveErrors < threshold", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k", consecutiveErrors: DEFAULT_POLL_ERROR_THRESHOLD - 1 }),
		});
		expect(entries[0]!.hasErrors).toBe(false);
	});

	it("terminal field is propagated from watch", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k", terminal: false }),
		});
		expect(entries[0]!.terminal).toBe(false);
	});

	it("returns empty array when watchMap is empty", () => {
		expect(buildWidgetEntries({})).toHaveLength(0);
	});

	it("returns empty array when all watches are terminal", () => {
		expect(buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "k", terminal: true }),
		})).toHaveLength(0);
	});

	it("preserves insertion order for non-terminal watches", () => {
		const entries = buildWidgetEntries({
			a: makeWatch({ watchId: "a", bucket: "b", key: "a" }),
			b: makeWatch({ watchId: "b", bucket: "b", key: "b" }),
			c: makeWatch({ watchId: "c", bucket: "b", key: "c" }),
		});
		expect(entries.map((e) => e.displayName)).toEqual([
			"s3://b/a",
			"s3://b/b",
			"s3://b/c",
		]);
	});
});

// ---------------------------------------------------------------------------
// renderEntryLine
// ---------------------------------------------------------------------------

describe("renderEntryLine", () => {
	it("pads the name column to nameColWidth width", () => {
		const line = renderEntryLine(makeEntry({ displayName: "s3://b/k" }), 20, plainTheme);
		// The name should be padded to 20 chars
		expect(line).toContain("s3://b/k            ");
	});

	it("truncates a long name with ellipsis", () => {
		const longName = "s3://very-long-bucket-name/very/long/key/path/to/object.json";
		const line = renderEntryLine(makeEntry({ displayName: longName }), 10, plainTheme);
		expect(line).toContain("s3://ve...");
	});

	it("smart-compresses middle path segments when name is too long", () => {
		// "s3://my-bucket/2024/01/results/output.json" = 42 chars, nameColWidth=35
		// compress "2024"→"2": 39 > 35
		// compress "01"→"0":   38 > 35
		// compress "results"→"r": 32 <= 35 ✓
		const uri = "s3://my-bucket/2024/01/results/output.json";
		const line = renderEntryLine(makeEntry({ displayName: uri }), 35, plainTheme);
		expect(line).toContain("s3://my-bucket/2/0/r/output.json");
	});

	it("includes the target column padded to COL_TARGET", () => {
		const line = renderEntryLine(makeEntry({ target: "exists" }), 20, plainTheme);
		// "exists   " padded to 9
		expect(line).toContain("exists   ");
	});

	it("renders all three target variants", () => {
		for (const target of ["exists", "updated", "removed"] as const) {
			const line = renderEntryLine(makeEntry({ target }), 20, plainTheme);
			expect(line).toContain(target);
		}
	});

	it("renders state string padded to COL_STATE", () => {
		const line = renderEntryLine(makeEntry({ state: "present" }), 20, plainTheme);
		// "present  " padded to 9
		expect(line).toContain("present  ");
	});

	it("renders '-' for timeLeft when timeoutAt is undefined", () => {
		const line = renderEntryLine(makeEntry({ timeoutAt: undefined }), 20, plainTheme);
		expect(line).toMatch(/-\s*$/);
	});

	it("renders 'expired' when timeoutAt is in the past", () => {
		const now = 10_000;
		const line = renderEntryLine(makeEntry({ timeoutAt: 5_000 }), 20, plainTheme, now);
		expect(line).toContain("expired");
	});

	it("renders time remaining like '5m left' when timeoutAt is in the future", () => {
		const now = 0;
		const fiveMinutesMs = 5 * 60 * 1000;
		const line = renderEntryLine(makeEntry({ timeoutAt: fiveMinutesMs }), 20, plainTheme, now);
		expect(line).toContain("5m left");
	});

	it("renders '1h left' for ~1 hour remaining", () => {
		const now = 0;
		const oneHourMs = 60 * 60 * 1000;
		const line = renderEntryLine(makeEntry({ timeoutAt: oneHourMs }), 20, plainTheme, now);
		expect(line).toContain("1h left");
	});

	it("renders '30s left' for ~30 seconds remaining", () => {
		const now = 0;
		const thirtySecondsMs = 30_000;
		const line = renderEntryLine(makeEntry({ timeoutAt: thirtySecondsMs }), 20, plainTheme, now);
		expect(line).toContain("30s left");
	});

	it("applies 'warning' colour to state for non-terminal, no-error watch", () => {
		const line = renderEntryLine(
			makeEntry({ terminal: false, hasErrors: false, state: "absent" }),
			20,
			taggedTheme,
		);
		expect(line).toContain("[warning]absent");
	});

	it("applies 'error' colour to state for non-terminal, has-error watch", () => {
		const line = renderEntryLine(
			makeEntry({ terminal: false, hasErrors: true, state: "absent" }),
			20,
			taggedTheme,
		);
		expect(line).toContain("[error]absent");
	});

	it("applies 'success' colour to state for terminal watch", () => {
		const line = renderEntryLine(
			makeEntry({ terminal: true, hasErrors: false, state: "present" }),
			20,
			taggedTheme,
		);
		expect(line).toContain("[success]present");
	});

	it("target is NOT coloured", () => {
		const line = renderEntryLine(
			makeEntry({ target: "exists", terminal: false, hasErrors: false }),
			20,
			taggedTheme,
		);
		// target "exists" should appear but not inside a colour tag
		expect(line).not.toMatch(/\[\w+\]exists/);
	});

	it("starts with a leading space", () => {
		const line = renderEntryLine(makeEntry(), 20, plainTheme);
		expect(line.startsWith(" ")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatHeaderSuffix
// ---------------------------------------------------------------------------

describe("formatHeaderSuffix", () => {
	it("counts non-terminal watches only", () => {
		const watches = {
			a: makeWatch({ watchId: "a", bucket: "b", key: "1" }),
			b: makeWatch({ watchId: "b", bucket: "b", key: "2", terminal: true }),
			c: makeWatch({ watchId: "c", bucket: "b", key: "3" }),
		};
		expect(formatHeaderSuffix(watches, 30_000)).toBe(" (2)  poll: 30s");
	});

	it("renders zero when all watches are terminal", () => {
		const watches = {
			a: makeWatch({ watchId: "a", bucket: "b", key: "1", terminal: true }),
		};
		expect(formatHeaderSuffix(watches, 60_000)).toBe(" (0)  poll: 60s");
	});

	it("renders zero when no watches present", () => {
		expect(formatHeaderSuffix({}, 60_000)).toBe(" (0)  poll: 60s");
	});

	it("rounds poll interval to nearest second", () => {
		expect(formatHeaderSuffix({}, 120_000)).toBe(" (0)  poll: 120s");
	});
});
