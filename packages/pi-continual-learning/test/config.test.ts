/**
 * Unit tests for the env-var / threshold resolution logic in config.ts.
 *
 * All functions are pure (take env+now+state as explicit args) so every
 * scenario can be exercised without touching process.env at all.
 */

import { describe, expect, it } from "vitest";

import { isTrialActive, resolveThresholds } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_TRIAL = { trialStartedAt: null } as const;

// ---------------------------------------------------------------------------
// resolveThresholds — default path
// ---------------------------------------------------------------------------

describe("resolveThresholds — defaults", () => {
	it("returns built-in defaults when no env vars are set", () => {
		const t = resolveThresholds({}, Date.now(), NO_TRIAL);
		expect(t.minTurns).toBe(10);
		expect(t.minMinutes).toBe(120);
	});

	it("respects PI_CONTINUAL_LEARNING_MIN_TURNS override", () => {
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_MIN_TURNS: "5" },
			Date.now(),
			NO_TRIAL,
		);
		expect(t.minTurns).toBe(5);
	});

	it("respects PI_CONTINUAL_LEARNING_MIN_MINUTES override", () => {
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_MIN_MINUTES: "60" },
			Date.now(),
			NO_TRIAL,
		);
		expect(t.minMinutes).toBe(60);
	});

	it("accepts zero as a valid turn threshold", () => {
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_MIN_TURNS: "0" },
			Date.now(),
			NO_TRIAL,
		);
		expect(t.minTurns).toBe(0);
	});

	it("ignores non-numeric PI_CONTINUAL_LEARNING_MIN_TURNS → falls back to default", () => {
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_MIN_TURNS: "abc" },
			Date.now(),
			NO_TRIAL,
		);
		expect(t.minTurns).toBe(10);
	});

	it("ignores non-numeric PI_CONTINUAL_LEARNING_MIN_MINUTES → falls back to default", () => {
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_MIN_MINUTES: "xyz" },
			Date.now(),
			NO_TRIAL,
		);
		expect(t.minMinutes).toBe(120);
	});

	it("ignores negative PI_CONTINUAL_LEARNING_MIN_TURNS → falls back to default", () => {
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_MIN_TURNS: "-5" },
			Date.now(),
			NO_TRIAL,
		);
		expect(t.minTurns).toBe(10);
	});

	it("ignores negative PI_CONTINUAL_LEARNING_MIN_MINUTES → falls back to default", () => {
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_MIN_MINUTES: "-1" },
			Date.now(),
			NO_TRIAL,
		);
		expect(t.minMinutes).toBe(120);
	});
});

// ---------------------------------------------------------------------------
// resolveThresholds — trial mode
// ---------------------------------------------------------------------------

describe("resolveThresholds — trial mode", () => {
	it("uses trial thresholds when trial is requested and within window", () => {
		const now = Date.now();
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_TRIAL: "1" },
			now,
			{ trialStartedAt: now - 60_000 }, // 1 minute ago → well within 24h window
		);
		expect(t.minTurns).toBe(3);
		expect(t.minMinutes).toBe(15);
	});

	it("uses trial thresholds when trial is 'true' (case-insensitive)", () => {
		const now = Date.now();
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_TRIAL: "TRUE" },
			now,
			{ trialStartedAt: now - 60_000 },
		);
		expect(t.minTurns).toBe(3);
		expect(t.minMinutes).toBe(15);
	});

	it("uses trial thresholds when trialStartedAt is null (just activated)", () => {
		const now = Date.now();
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_TRIAL: "1" },
			now,
			{ trialStartedAt: null },
		);
		expect(t.minTurns).toBe(3);
		expect(t.minMinutes).toBe(15);
	});

	it("falls back to default thresholds when trial window has expired", () => {
		const now = Date.now();
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_TRIAL: "1" },
			now,
			{ trialStartedAt: now - 25 * 3_600_000 }, // 25h ago → expired
		);
		expect(t.minTurns).toBe(10);
		expect(t.minMinutes).toBe(120);
	});

	it("respects PI_CONTINUAL_LEARNING_TRIAL_MIN_TURNS override", () => {
		const now = Date.now();
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_TRIAL: "1", PI_CONTINUAL_LEARNING_TRIAL_MIN_TURNS: "2" },
			now,
			{ trialStartedAt: null },
		);
		expect(t.minTurns).toBe(2);
	});

	it("respects PI_CONTINUAL_LEARNING_TRIAL_MIN_MINUTES override", () => {
		const now = Date.now();
		const t = resolveThresholds(
			{ PI_CONTINUAL_LEARNING_TRIAL: "1", PI_CONTINUAL_LEARNING_TRIAL_MIN_MINUTES: "5" },
			now,
			{ trialStartedAt: null },
		);
		expect(t.minMinutes).toBe(5);
	});

	it("respects PI_CONTINUAL_LEARNING_TRIAL_WINDOW_HOURS override", () => {
		const now = Date.now();
		// Set window to 48h; trialStartedAt 25h ago → still active
		const t = resolveThresholds(
			{
				PI_CONTINUAL_LEARNING_TRIAL: "1",
				PI_CONTINUAL_LEARNING_TRIAL_WINDOW_HOURS: "48",
			},
			now,
			{ trialStartedAt: now - 25 * 3_600_000 },
		);
		expect(t.minTurns).toBe(3); // trial thresholds
	});

	it("ignores bad TRIAL_WINDOW_HOURS (negative) → falls back to default 24h window", () => {
		const now = Date.now();
		// trialStartedAt 25h ago; bad window var → window defaults to 24h → expired
		const t = resolveThresholds(
			{
				PI_CONTINUAL_LEARNING_TRIAL: "1",
				PI_CONTINUAL_LEARNING_TRIAL_WINDOW_HOURS: "-99",
			},
			now,
			{ trialStartedAt: now - 25 * 3_600_000 },
		);
		// Trial expired → default thresholds
		expect(t.minTurns).toBe(10);
	});

	it("does NOT use trial thresholds when trial flag is not set", () => {
		const now = Date.now();
		const t = resolveThresholds({}, now, { trialStartedAt: now - 60_000 });
		expect(t.minTurns).toBe(10);
		expect(t.minMinutes).toBe(120);
	});
});

// ---------------------------------------------------------------------------
// isTrialActive
// ---------------------------------------------------------------------------

describe("isTrialActive", () => {
	it("returns false when trial flag not set", () => {
		expect(isTrialActive({}, Date.now(), { trialStartedAt: null })).toBe(false);
	});

	it("returns true when trial requested and trialStartedAt is null", () => {
		expect(
			isTrialActive({ PI_CONTINUAL_LEARNING_TRIAL: "1" }, Date.now(), { trialStartedAt: null }),
		).toBe(true);
	});

	it("returns true when trial is within window", () => {
		const now = Date.now();
		expect(
			isTrialActive(
				{ PI_CONTINUAL_LEARNING_TRIAL: "1" },
				now,
				{ trialStartedAt: now - 3_600_000 }, // 1h ago
			),
		).toBe(true);
	});

	it("returns false when trial window expired", () => {
		const now = Date.now();
		expect(
			isTrialActive(
				{ PI_CONTINUAL_LEARNING_TRIAL: "1" },
				now,
				{ trialStartedAt: now - 25 * 3_600_000 }, // 25h ago
			),
		).toBe(false);
	});
});
