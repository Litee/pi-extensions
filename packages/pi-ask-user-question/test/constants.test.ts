import { describe, expect, it } from "vitest";

import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, MIN_QUESTIONS, RESERVED_LABEL_RE } from "../src/constants.js";

describe("constants", () => {
	it("exposes the documented invocation limits", () => {
		expect(MIN_QUESTIONS).toBe(1);
		expect(MAX_QUESTIONS).toBe(5);
		expect(MIN_OPTIONS).toBe(2);
		expect(MAX_OPTIONS).toBe(6);
		expect(MIN_QUESTIONS).toBeLessThan(MAX_QUESTIONS);
		expect(MIN_OPTIONS).toBeLessThan(MAX_OPTIONS);
	});

	describe("RESERVED_LABEL_RE", () => {
		it.each([
			["Other", true],
			["other", true],
			["OTHER", true],
			["Type something", true],
			["Type something.", true],
			["TYPE SOMETHING.", true],
			["Chat about this", true],
			["chat about this", true],
			["Next", true],
			["NEXT", true],
		])("treats %j as reserved: %s", (label, reserved) => {
			expect(RESERVED_LABEL_RE.test(label)).toBe(reserved);
		});

		it.each([
			["Yes"],
			["No"],
			["Cancel"],
			["Type something else"],
			["Other option"],
			["Next step"],
			["Chat"],
			["about this"],
			[""],
			[" "],
		])("does not flag non-reserved label %j", (label) => {
			expect(RESERVED_LABEL_RE.test(label)).toBe(false);
		});
	});
});
