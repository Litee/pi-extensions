/**
 * Pure-function tests for the scheduler's static helpers. No pi / croner
 * session plumbing — everything here is time-dependent math or string
 * validation, so we fake the clock where it matters and leave the rest
 * straight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CronScheduler, formatISOShort, humanizeCron } from "../src/scheduler.js";

// ---------------------------------------------------------------------------
// validateCronExpression
// ---------------------------------------------------------------------------

describe("CronScheduler.validateCronExpression", () => {
	it.each([
		["0 * * * * *"],
		["*/5 * * * * *"],
		["0 0 9 * * 1-5"],
		["0 0 0 1 * *"],
	])("accepts valid 6-field expression %j", (expr) => {
		const result = CronScheduler.validateCronExpression(expr);
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it.each([
		["* * * * *", 5, "5-field (missing seconds) rejected"],
		["* * * * * * *", 7, "7-field rejected"],
		["", 1, "empty string rejected"],
	])("rejects %j (%i fields)", (expr, count) => {
		const result = CronScheduler.validateCronExpression(expr);
		expect(result.valid).toBe(false);
		expect(result.error).toContain(`got ${count}`);
	});

	it("rejects a syntactically bogus 6-field expression with croner's error", () => {
		const result = CronScheduler.validateCronExpression("zz zz zz zz zz zz");
		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
		// Whatever the upstream message is, it should NOT be the generic
		// field-count message — that would mask the real parse failure.
		expect(result.error).not.toContain("must have 6 fields");
	});
});

// ---------------------------------------------------------------------------
// parseRelativeTime
// ---------------------------------------------------------------------------

describe("CronScheduler.parseRelativeTime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		["+10s", "2030-01-01T00:00:10.000Z"],
		["+5m", "2030-01-01T00:05:00.000Z"],
		["+1h", "2030-01-01T01:00:00.000Z"],
		["+1d", "2030-01-02T00:00:00.000Z"],
	])("resolves %j relative to the current clock", (input, expected) => {
		expect(CronScheduler.parseRelativeTime(input)).toBe(expected);
	});

	it.each([
		["10s", "no plus prefix"],
		["+10", "no unit"],
		["+10x", "unsupported unit"],
		["+-5m", "double sign"],
		["+5.5m", "fractional value"],
		["", "empty"],
	])("rejects malformed input %j (%s)", (input) => {
		expect(CronScheduler.parseRelativeTime(input)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseInterval
// ---------------------------------------------------------------------------

describe("CronScheduler.parseInterval", () => {
	it.each([
		["30s", 30_000],
		["5m", 5 * 60_000],
		["1h", 60 * 60_000],
		["2d", 2 * 24 * 60 * 60_000],
	])("parses %j to %i ms", (input, expected) => {
		expect(CronScheduler.parseInterval(input)).toBe(expected);
	});

	it.each([
		["5min"],
		["+5m"], // `+` is for relative time, not interval
		["5"],
		["five"],
		[""],
	])("rejects %j", (input) => {
		expect(CronScheduler.parseInterval(input)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// validateSchedule (the composite entry point used by tool.add / tool.update)
// ---------------------------------------------------------------------------

describe("CronScheduler.validateSchedule", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves `once` + relative time into an ISO timestamp", () => {
		const result = CronScheduler.validateSchedule("once", "+10s");
		expect(result).toEqual({ ok: true, schedule: "2030-01-01T00:00:10.000Z" });
	});

	it("accepts `once` + ISO timestamp >=5s in the future", () => {
		const result = CronScheduler.validateSchedule("once", "2030-01-01T00:00:10.000Z");
		expect(result).toEqual({ ok: true, schedule: "2030-01-01T00:00:10.000Z" });
	});

	it("rejects `once` with an ISO timestamp in the past", () => {
		const result = CronScheduler.validateSchedule("once", "2020-01-01T00:00:00.000Z");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("in the past");
	});

	it("rejects `once` with an ISO timestamp <5s in the future (nudges toward relative time)", () => {
		const result = CronScheduler.validateSchedule("once", "2030-01-01T00:00:03.000Z");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("too soon");
			// Suggestion must use the right relative-time format to avoid re-confusing callers.
			expect(result.error).toMatch(/\+\d+s/);
		}
	});

	it("rejects `once` with unparseable text", () => {
		const result = CronScheduler.validateSchedule("once", "not a date");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Invalid timestamp");
	});

	it("resolves `interval` and exposes the parsed intervalMs", () => {
		const result = CronScheduler.validateSchedule("interval", "5m");
		expect(result).toEqual({ ok: true, schedule: "5m", intervalMs: 5 * 60_000 });
	});

	it("rejects `interval` with an unparseable duration", () => {
		const result = CronScheduler.validateSchedule("interval", "5 minutes");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Invalid interval/);
	});

	it("accepts `cron` + valid 6-field expression (returns schedule unchanged)", () => {
		const result = CronScheduler.validateSchedule("cron", "0 */5 * * * *");
		expect(result).toEqual({ ok: true, schedule: "0 */5 * * * *" });
	});

	it("rejects `cron` with invalid expression, prefixing the message", () => {
		const result = CronScheduler.validateSchedule("cron", "* * * * *");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/^Invalid cron expression/);
	});
});

// ---------------------------------------------------------------------------
// describeSchedule / humanizeCron / formatISOShort
// ---------------------------------------------------------------------------

describe("CronScheduler.describeSchedule", () => {
	it("prefixes an interval with `every`", () => {
		expect(CronScheduler.describeSchedule("interval", "5m")).toBe("every 5m");
	});

	it("renders a valid ISO timestamp compactly for `once`", () => {
		// describeSchedule → formatISOShort → local time (not UTC). Just
		// assert the shape so the test is deterministic across TZs.
		const rendered = CronScheduler.describeSchedule("once", "2030-02-13T15:30:00.000Z");
		expect(rendered).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
	});

	it("falls back to the raw schedule string when `once` gets unparseable input", () => {
		expect(CronScheduler.describeSchedule("once", "garbage")).toBe("garbage");
	});

	it("routes `cron` through humanizeCron", () => {
		expect(CronScheduler.describeSchedule("cron", "0 * * * * *")).toBe("every minute");
	});
});

describe("humanizeCron", () => {
	it.each([
		["0 * * * * *", "every minute"],
		["0 */15 * * * *", "every 15 min"],
		["0 0 * * * *", "every hour"],
		["0 0 0 * * *", "daily"],
		["0 0 9 * * 1-5", "9am weekdays"],
	])("recognizes canned pattern %j as %j", (expr, humanized) => {
		expect(humanizeCron(expr)).toBe(humanized);
	});

	it("recognizes generic every-N-min pattern not in the table", () => {
		expect(humanizeCron("0 */7 * * * *")).toBe("every 7 min");
	});

	it("recognizes generic every-Nh pattern not in the table", () => {
		expect(humanizeCron("0 0 */4 * * *")).toBe("every 4h");
	});

	it("recognizes generic daily-at-N pattern not in the table", () => {
		expect(humanizeCron("0 0 14 * * *")).toBe("daily at 14:00");
	});

	it("falls back to the raw expression for anything unrecognized (never guesses)", () => {
		// Explicit: the function must NOT invent a description. An unknown
		// expression round-trips exactly as given.
		expect(humanizeCron("1 2 3 4 5 6")).toBe("1 2 3 4 5 6");
	});

	it("trims whitespace before matching", () => {
		expect(humanizeCron("  0 * * * * *  ")).toBe("every minute");
	});
});

describe("formatISOShort", () => {
	it("formats a Date to `Mon D HH:MM`", () => {
		// Construct via local components so the assertion is stable under any TZ.
		const d = new Date(2030, 1, 13, 15, 30, 0); // 13 Feb 2030 15:30 local
		expect(formatISOShort(d)).toBe("Feb 13 15:30");
	});

	it("accepts an ISO string", () => {
		const d = new Date(2030, 11, 1, 9, 5, 0); // 1 Dec 2030 09:05 local
		expect(formatISOShort(d.toISOString())).toBe("Dec 1 09:05");
	});

	it("returns the raw input when it fails to parse", () => {
		expect(formatISOShort("not a date")).toBe("not a date");
	});
});

// ---------------------------------------------------------------------------
// isLoadedFor — session-binding logic used by start(), executeJob(),
// list/cleanup filtering, and the jobs view.
// ---------------------------------------------------------------------------

describe("CronScheduler.isLoadedFor", () => {
	const jobShell = {
		id: "j1",
		name: "n",
		schedule: "0 * * * * *",
		prompt: "p",
		enabled: true,
		type: "cron" as const,
		createdAt: "2030-01-01T00:00:00.000Z",
		runCount: 0,
	};

	it("loads unbound jobs (no `session` field) for every session", () => {
		expect(CronScheduler.isLoadedFor(jobShell, "any-id")).toBe(true);
		expect(CronScheduler.isLoadedFor(jobShell, undefined)).toBe(true);
	});

	it("loads session-bound jobs only for their owning session", () => {
		const bound = { ...jobShell, session: "sess-A" };
		expect(CronScheduler.isLoadedFor(bound, "sess-A")).toBe(true);
		expect(CronScheduler.isLoadedFor(bound, "sess-B")).toBe(false);
		expect(CronScheduler.isLoadedFor(bound, undefined)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// validateCronExpression — non-Error throw path (scheduler.ts line 442)
// ---------------------------------------------------------------------------

describe("CronScheduler.validateCronExpression — non-Error throw", () => {
	// We need to mock croner.Cron to throw a non-Error value.
	// Since scheduler-pure.test.ts imports CronScheduler from scheduler.js,
	// and scheduler.js imports Cron from croner, we mock croner at the module level.
	vi.mock("croner", async (importOriginal) => {
		const actual = await importOriginal<typeof import("croner")>();
		return {
			...actual,
			Cron: class MockCron {
				constructor(expr: string, _fn: () => void) {
					if (expr === "zz zz zz zz zz zz") {
						// Throw a non-Error value to exercise the fallback branch
						throw "not an Error";
					}
					// For valid expressions, use the real Cron
					new actual.Cron(expr, _fn);
				}
				stop() {}
				nextRun() {
					return null;
				}
			},
		};
	});

	// Re-import after mock is set up
	beforeEach(() => {
		// Reset modules to pick up the mock
		vi.resetModules();
	});

	it("falls back to generic message when Cron throws a non-Error value", async () => {
		// Re-import CronScheduler to pick up the mocked croner
		const { CronScheduler: CS } = await import("../src/scheduler.js");
		const result = CS.validateCronExpression("zz zz zz zz zz zz");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("Invalid cron expression");
	});
});
