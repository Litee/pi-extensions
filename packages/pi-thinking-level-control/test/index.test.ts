import { describe, expect, it } from "vitest";

import { nextLevel } from "../src/index.js";

describe("nextLevel", () => {
	it("increases from off to minimal", () => {
		expect(nextLevel("off", 1)).toBe("minimal");
	});

	it("increases from medium to high", () => {
		expect(nextLevel("medium", 1)).toBe("high");
	});

	it("returns null at the top (high, increase)", () => {
		expect(nextLevel("high", 1)).toBe(null);
	});

	it("decreases from high to medium", () => {
		expect(nextLevel("high", -1)).toBe("medium");
	});

	it("decreases from minimal to off", () => {
		expect(nextLevel("minimal", -1)).toBe("off");
	});

	it("returns null at the bottom (off, decrease)", () => {
		expect(nextLevel("off", -1)).toBe(null);
	});

	it("xhigh decrease snaps to high", () => {
		expect(nextLevel("xhigh", -1)).toBe("high");
	});

	it("xhigh increase is a no-op (returns null)", () => {
		expect(nextLevel("xhigh", 1)).toBe(null);
	});

	it("unknown level increase is a no-op", () => {
		expect(nextLevel("unknown", 1)).toBe(null);
	});

	it("unknown level decrease snaps to high", () => {
		expect(nextLevel("unknown", -1)).toBe("high");
	});
});
