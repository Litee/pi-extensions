import { describe, expect, it } from "vitest";

import { nextLevel } from "../src/index.js";

const SHORT = ["off", "minimal", "low", "medium", "high"] as const;
const LONG = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

describe("nextLevel", () => {
	it("increases from off to minimal", () => {
		expect(nextLevel(SHORT, "off", 1)).toBe("minimal");
	});

	it("increases from medium to high", () => {
		expect(nextLevel(SHORT, "medium", 1)).toBe("high");
	});

	it("returns null at the top (high, increase) on short ladder", () => {
		expect(nextLevel(SHORT, "high", 1)).toBe(null);
	});

	it("decreases from high to medium", () => {
		expect(nextLevel(SHORT, "high", -1)).toBe("medium");
	});

	it("decreases from minimal to off", () => {
		expect(nextLevel(SHORT, "minimal", -1)).toBe("off");
	});

	it("returns null at the bottom (off, decrease)", () => {
		expect(nextLevel(SHORT, "off", -1)).toBe(null);
	});

	it("xhigh decrease snaps to high on short ladder (off-ladder case)", () => {
		expect(nextLevel(SHORT, "xhigh", -1)).toBe("high");
	});

	it("xhigh increase is a no-op on short ladder (off-ladder case)", () => {
		expect(nextLevel(SHORT, "xhigh", 1)).toBe(null);
	});

	it("unknown level increase is a no-op", () => {
		expect(nextLevel(SHORT, "unknown", 1)).toBe(null);
	});

	it("unknown level decrease snaps to top of ladder", () => {
		expect(nextLevel(SHORT, "unknown", -1)).toBe("high");
	});

	// Opus-style long ladder (includes xhigh)
	it("increases from high to xhigh on long ladder", () => {
		expect(nextLevel(LONG, "high", 1)).toBe("xhigh");
	});

	it("returns null at xhigh (top) on long ladder", () => {
		expect(nextLevel(LONG, "xhigh", 1)).toBe(null);
	});

	it("decreases from xhigh to high on long ladder", () => {
		expect(nextLevel(LONG, "xhigh", -1)).toBe("high");
	});
});
