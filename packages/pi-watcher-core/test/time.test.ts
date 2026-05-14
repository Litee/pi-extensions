import { describe, expect, it } from "vitest";
import { formatShortTime } from "../src/time.js";

describe("formatShortTime", () => {
	it("formats a date as HH:MM with no seconds", () => {
		const d = new Date(2026, 4, 14, 14, 30, 45);
		expect(formatShortTime(d)).toBe("14:30");
	});

	it("zero-pads single-digit hours and minutes", () => {
		const d = new Date(2026, 0, 1, 1, 5, 3);
		expect(formatShortTime(d)).toBe("01:05");
	});

	it("handles midnight boundary (00:00)", () => {
		const d = new Date(2026, 0, 1, 0, 0, 0);
		expect(formatShortTime(d)).toBe("00:00");
	});

	it("handles end-of-day boundary (23:59)", () => {
		const d = new Date(2026, 0, 1, 23, 59, 59);
		expect(formatShortTime(d)).toBe("23:59");
	});

	it("does not include seconds in output", () => {
		const d = new Date(2026, 4, 14, 10, 5, 59);
		expect(formatShortTime(d)).not.toMatch(/:/g.source + "\\d{2}$");
		expect(formatShortTime(d).split(":")).toHaveLength(2);
	});
});
