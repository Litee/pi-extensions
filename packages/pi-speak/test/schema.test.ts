import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import { MAX_TEXT_CHARS, SpeakParams } from "../src/schema.js";

describe("SpeakParams schema", () => {
	describe("valid inputs", () => {
		it("passes with text only", () => {
			expect(Value.Check(SpeakParams, { text: "hello" })).toBe(true);
		});

		it("passes with all optional fields at valid values", () => {
			expect(
				Value.Check(SpeakParams, {
					text: "hello",
					voice: "F3",
					lang: "ko",
					speed: 1.5,
					steps: 16,
					wait: false,
				}),
			).toBe(true);
		});

		it("passes with boundary speed values", () => {
			expect(Value.Check(SpeakParams, { text: "hi", speed: 0.5 })).toBe(true);
			expect(Value.Check(SpeakParams, { text: "hi", speed: 2.0 })).toBe(true);
		});

		it("passes with boundary steps values", () => {
			expect(Value.Check(SpeakParams, { text: "hi", steps: 1 })).toBe(true);
			expect(Value.Check(SpeakParams, { text: "hi", steps: 32 })).toBe(true);
		});

		it("passes with all voice IDs", () => {
			for (const v of ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]) {
				expect(Value.Check(SpeakParams, { text: "hi", voice: v })).toBe(true);
			}
		});
	});

	describe("invalid inputs", () => {
		it("rejects empty text", () => {
			expect(Value.Check(SpeakParams, { text: "" })).toBe(false);
		});

		it("rejects unknown voice ID", () => {
			expect(Value.Check(SpeakParams, { text: "hi", voice: "X9" })).toBe(false);
		});

		it("rejects unknown lang code", () => {
			expect(Value.Check(SpeakParams, { text: "hi", lang: "zz" })).toBe(false);
		});

		it("rejects speed above maximum", () => {
			expect(Value.Check(SpeakParams, { text: "hi", speed: 3 })).toBe(false);
		});

		it("rejects speed below minimum", () => {
			expect(Value.Check(SpeakParams, { text: "hi", speed: 0.1 })).toBe(false);
		});

		it("rejects steps below minimum", () => {
			expect(Value.Check(SpeakParams, { text: "hi", steps: 0 })).toBe(false);
		});

		it("rejects steps above maximum", () => {
			expect(Value.Check(SpeakParams, { text: "hi", steps: 33 })).toBe(false);
		});

		it("rejects text longer than MAX_TEXT_CHARS", () => {
			expect(Value.Check(SpeakParams, { text: "a".repeat(MAX_TEXT_CHARS + 1) })).toBe(false);
		});

		it("rejects missing text", () => {
			expect(Value.Check(SpeakParams, {})).toBe(false);
		});
	});
});
