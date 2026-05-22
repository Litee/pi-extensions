import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { pickUsageAccent, WARNING_THRESHOLD_PERCENT } from "../src/runtime/status-format.js";

describe("pickUsageAccent", () => {
	it("returns muted when context usage is below the warning threshold", () => {
		assert.equal(pickUsageAccent(0), "muted");
		assert.equal(pickUsageAccent(50), "muted");
		assert.equal(pickUsageAccent(WARNING_THRESHOLD_PERCENT - 0.01), "muted");
	});

	it("returns warning when context usage is at or above the warning threshold", () => {
		assert.equal(pickUsageAccent(WARNING_THRESHOLD_PERCENT), "warning");
		assert.equal(pickUsageAccent(85), "warning");
		assert.equal(pickUsageAccent(99.9), "warning");
		assert.equal(pickUsageAccent(150), "warning");
	});

	it("falls back to muted for non-finite inputs", () => {
		assert.equal(pickUsageAccent(NaN), "muted");
		assert.equal(pickUsageAccent(Number.POSITIVE_INFINITY), "muted");
		assert.equal(pickUsageAccent(Number.NEGATIVE_INFINITY), "muted");
	});

	it("pins the threshold at 80% to match the documented behaviour", () => {
		assert.equal(WARNING_THRESHOLD_PERCENT, 80);
	});
});
