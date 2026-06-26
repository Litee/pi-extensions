/**
 * Unit tests for the pure decision logic in decide.ts.
 *
 * Covers: isSuccess for every stopReason, no-assistant-message edge case,
 * last-assistant-wins scan order, buildMarker null/string combos, and the
 * full decideConsolidation truth table.
 */

import { describe, expect, it } from "vitest";

import {
	buildMarker,
	decideConsolidation,
	isSuccess,
	lastAssistantStopReason,
	type MinimalMessage,
} from "../src/decide.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(role: string, stopReason?: MinimalMessage["stopReason"]): MinimalMessage {
	return stopReason !== undefined ? { role, stopReason } : { role };
}

const USER = msg("user");

// ---------------------------------------------------------------------------
// lastAssistantStopReason
// ---------------------------------------------------------------------------

describe("lastAssistantStopReason", () => {
	it("returns null when messages is empty", () => {
		expect(lastAssistantStopReason([])).toBeNull();
	});

	it("returns null when there is no assistant message", () => {
		expect(lastAssistantStopReason([USER])).toBeNull();
	});

	it("returns the stopReason of the last assistant message", () => {
		const messages = [msg("assistant", "error"), USER, msg("assistant", "stop")];
		expect(lastAssistantStopReason(messages)).toBe("stop");
	});

	it("returns null when the last assistant message has no stopReason", () => {
		// An assistant message without stopReason (edge case)
		expect(lastAssistantStopReason([{ role: "assistant" }])).toBeNull();
	});

	it("scans backward — uses last assistant message, not first", () => {
		const messages = [msg("assistant", "aborted"), USER, msg("assistant", "toolUse")];
		expect(lastAssistantStopReason(messages)).toBe("toolUse");
	});

	it("skips undefined slots in sparse arrays (defensive guard)", () => {
		// With noUncheckedIndexedAccess, array access can theoretically be undefined.
		// Verify the defensive `if (!msg) continue` path works correctly.
		const sparse = [msg("assistant", "stop"), undefined as unknown as MinimalMessage];
		// lastAssistantStopReason scans backward; slot 1 is undefined, slot 0 is assistant.
		expect(lastAssistantStopReason(sparse)).toBe("stop");
	});
});


// ---------------------------------------------------------------------------
// isSuccess
// ---------------------------------------------------------------------------

describe("isSuccess", () => {
	it("returns false for empty messages", () => {
		expect(isSuccess([])).toBe(false);
	});

	it("returns false when there is no assistant message", () => {
		expect(isSuccess([USER])).toBe(false);
	});

	it('returns true for stopReason "stop"', () => {
		expect(isSuccess([msg("assistant", "stop")])).toBe(true);
	});

	it('returns true for stopReason "length"', () => {
		expect(isSuccess([msg("assistant", "length")])).toBe(true);
	});

	it('returns true for stopReason "toolUse"', () => {
		expect(isSuccess([msg("assistant", "toolUse")])).toBe(true);
	});

	it('returns false for stopReason "error"', () => {
		expect(isSuccess([msg("assistant", "error")])).toBe(false);
	});

	it('returns false for stopReason "aborted"', () => {
		expect(isSuccess([msg("assistant", "aborted")])).toBe(false);
	});

	it("uses the last assistant message (error first, stop last → success)", () => {
		expect(isSuccess([msg("assistant", "error"), USER, msg("assistant", "stop")])).toBe(true);
	});

	it("uses the last assistant message (stop first, error last → not success)", () => {
		expect(isSuccess([msg("assistant", "stop"), USER, msg("assistant", "error")])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildMarker
// ---------------------------------------------------------------------------

describe("buildMarker", () => {
	it("combines sessionId and leafId with colon", () => {
		expect(buildMarker("sess-abc", "leaf-xyz")).toBe("sess-abc:leaf-xyz");
	});

	it("serialises null leafId as the string 'null'", () => {
		expect(buildMarker("sess-abc", null)).toBe("sess-abc:null");
	});
});

// ---------------------------------------------------------------------------
// decideConsolidation — truth table
// ---------------------------------------------------------------------------

describe("decideConsolidation", () => {
	// Shared baseline: all conditions met.
	const NOW = 5 * 60 * 60 * 1000; // 5 hours after epoch in ms
	const THRESHOLDS = { minTurns: 10, minMinutes: 120 };
	const CURRENT = "sess:leaf-new";

	const base = {
		turnsSinceLastRun: 10, // at threshold
		lastRunAt: NOW - 150 * 60_000, // 150 min ago (> 120)
		processedMarker: "sess:leaf-old",
	};

	it("triggers when all conditions are met", () => {
		const r = decideConsolidation(base, NOW, THRESHOLDS, CURRENT);
		expect(r.trigger).toBe(true);
	});

	it("does NOT trigger when processedMarker equals currentMarker (condition 4)", () => {
		const r = decideConsolidation({ ...base, processedMarker: CURRENT }, NOW, THRESHOLDS, CURRENT);
		expect(r.trigger).toBe(false);
		expect(r.reason).toMatch(/no new content/);
	});

	it("does NOT trigger when turns is below threshold (condition 2)", () => {
		const r = decideConsolidation({ ...base, turnsSinceLastRun: 9 }, NOW, THRESHOLDS, CURRENT);
		expect(r.trigger).toBe(false);
		expect(r.reason).toMatch(/turns below threshold/);
	});

	it("DOES trigger when turns is exactly at threshold", () => {
		const r = decideConsolidation({ ...base, turnsSinceLastRun: 10 }, NOW, THRESHOLDS, CURRENT);
		expect(r.trigger).toBe(true);
	});

	it("does NOT trigger when elapsed time is below threshold (condition 3)", () => {
		// 60 min ago — below 120 min threshold
		const r = decideConsolidation(
			{ ...base, lastRunAt: NOW - 60 * 60_000 },
			NOW,
			THRESHOLDS,
			CURRENT,
		);
		expect(r.trigger).toBe(false);
		expect(r.reason).toMatch(/time below threshold/);
	});

	it("DOES trigger when elapsed time is exactly at threshold", () => {
		// Exactly 120 min ago
		const r = decideConsolidation(
			{ ...base, lastRunAt: NOW - 120 * 60_000 },
			NOW,
			THRESHOLDS,
			CURRENT,
		);
		expect(r.trigger).toBe(true);
	});

	it("treats lastRunAt null as infinity — time condition always satisfied", () => {
		const r = decideConsolidation({ ...base, lastRunAt: null }, NOW, THRESHOLDS, CURRENT);
		expect(r.trigger).toBe(true);
	});

	it("combines conditions: turns OK, time not OK → no trigger", () => {
		const r = decideConsolidation(
			{ ...base, lastRunAt: NOW - 10 * 60_000 }, // only 10 min ago
			NOW,
			THRESHOLDS,
			CURRENT,
		);
		expect(r.trigger).toBe(false);
	});

	it("combines conditions: time OK, turns not OK → no trigger", () => {
		const r = decideConsolidation(
			{ ...base, turnsSinceLastRun: 3 },
			NOW,
			THRESHOLDS,
			CURRENT,
		);
		expect(r.trigger).toBe(false);
	});

	it("processedMarker null is treated as distinct from any currentMarker", () => {
		const r = decideConsolidation({ ...base, processedMarker: null }, NOW, THRESHOLDS, CURRENT);
		expect(r.trigger).toBe(true);
	});
});
