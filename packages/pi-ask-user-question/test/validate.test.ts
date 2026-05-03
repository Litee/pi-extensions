import { describe, expect, it } from "vitest";

import type { TParams } from "../src/schema.js";
import { validate } from "../src/validate.js";

function q(question: string, options: { label: string; description?: string; preview?: string }[], multiSelect = false): TParams["questions"][number] {
	const out: TParams["questions"][number] = { question, options };
	if (multiSelect) out.multiSelect = true;
	return out;
}

describe("validate()", () => {
	it("accepts a well-formed single-select question", () => {
		const params: TParams = {
			questions: [q("Pick a fruit", [{ label: "Apple" }, { label: "Banana" }])],
		};
		expect(validate(params)).toEqual({ ok: true });
	});

	it("accepts multi-select without previews", () => {
		const params: TParams = {
			questions: [q("Pick fruits", [{ label: "Apple" }, { label: "Banana" }], true)],
		};
		expect(validate(params)).toEqual({ ok: true });
	});

	it("rejects 0 questions", () => {
		const r = validate({ questions: [] });
		expect(r).toMatchObject({ ok: false, error: "questions_out_of_range" });
	});

	it("rejects more than MAX_QUESTIONS", () => {
		const questions = Array.from({ length: 6 }, (_, i) =>
			q(`Q${i + 1}`, [{ label: "A" }, { label: "B" }]),
		);
		const r = validate({ questions });
		expect(r).toMatchObject({ ok: false, error: "questions_out_of_range" });
	});

	it("rejects a non-array `questions` field defensively", () => {
		const r = validate({ questions: "not-an-array" as unknown as TParams["questions"] });
		expect(r).toMatchObject({ ok: false, error: "questions_out_of_range" });
	});

	it("rejects duplicate question text even when options differ", () => {
		const params: TParams = {
			questions: [
				q("Same", [{ label: "A" }, { label: "B" }]),
				q("Same", [{ label: "C" }, { label: "D" }]),
			],
		};
		const r = validate(params);
		expect(r).toMatchObject({ ok: false, error: "duplicate_question" });
	});

	// -- issue #0001 (N5): duplicate-question check is now case-insensitive, matching option-label dedup --
	it("rejects duplicate question text differing only in case (issue #0001)", () => {
		const params: TParams = {
			questions: [
				q("Proceed?", [{ label: "A" }, { label: "B" }]),
				q("PROCEED?", [{ label: "C" }, { label: "D" }]),
			],
		};
		const r = validate(params);
		expect(r).toMatchObject({ ok: false, error: "duplicate_question" });
	});

	it("rejects duplicate question text differing only in surrounding whitespace or case (issue #0001)", () => {
		const params: TParams = {
			questions: [
				q("  hello world  ", [{ label: "A" }, { label: "B" }]),
				q("Hello World", [{ label: "C" }, { label: "D" }]),
			],
		};
		const r = validate(params);
		expect(r).toMatchObject({ ok: false, error: "duplicate_question" });
	});

	it("ignores duplicate empty-string questions in the dedup pass (they fail later as missing_question)", () => {
		const params: TParams = {
			questions: [
				q("   ", [{ label: "A" }, { label: "B" }]),
				q("", [{ label: "C" }, { label: "D" }]),
			],
		};
		const r = validate(params);
		expect(r).toMatchObject({ ok: false, error: "missing_question" });
	});

	it("rejects a question with empty question text", () => {
		const r = validate({ questions: [q("   ", [{ label: "A" }, { label: "B" }])] });
		expect(r).toMatchObject({ ok: false, error: "missing_question" });
	});

	it("rejects a question with a non-string question field", () => {
		const bogus = { question: 42, options: [{ label: "A" }, { label: "B" }] } as unknown as TParams["questions"][number];
		const r = validate({ questions: [bogus] });
		expect(r).toMatchObject({ ok: false, error: "missing_question" });
	});

	it("rejects a question whose options array is too small", () => {
		const r = validate({ questions: [q("Q", [{ label: "A" }])] });
		expect(r).toMatchObject({ ok: false, error: "options_out_of_range" });
	});

	it("rejects a question whose options array is too large", () => {
		const opts = Array.from({ length: 7 }, (_, i) => ({ label: `O${i}` }));
		const r = validate({ questions: [q("Q", opts)] });
		expect(r).toMatchObject({ ok: false, error: "options_out_of_range" });
	});

	it("rejects non-array options field defensively", () => {
		const bogus = { question: "Q", options: "nope" } as unknown as TParams["questions"][number];
		const r = validate({ questions: [bogus] });
		expect(r).toMatchObject({ ok: false, error: "options_out_of_range" });
	});

	it("rejects an option with empty label", () => {
		const r = validate({ questions: [q("Q", [{ label: " " }, { label: "B" }])] });
		expect(r).toMatchObject({ ok: false, error: "missing_label" });
	});

	it("rejects an option with non-string label", () => {
		const bogus = { question: "Q", options: [{ label: 42 as unknown as string }, { label: "B" }] };
		const r = validate({ questions: [bogus as unknown as TParams["questions"][number]] });
		expect(r).toMatchObject({ ok: false, error: "missing_label" });
	});

	it.each([
		["Other"],
		["Type something."],
		["Type something"],
		["chat about this"],
		["Next"],
	])("rejects reserved label %j", (label) => {
		const r = validate({ questions: [q("Q", [{ label }, { label: "Other Label" }])] });
		expect(r).toMatchObject({ ok: false, error: "reserved_label" });
	});

	it("rejects duplicate option labels case-insensitively after trimming", () => {
		const r = validate({
			questions: [q("Q", [{ label: "Apple" }, { label: "  apple " }])],
		});
		expect(r).toMatchObject({ ok: false, error: "duplicate_label" });
	});

	it("rejects preview on a multi-select question", () => {
		const r = validate({
			questions: [q("Q", [{ label: "A", preview: "# hi" }, { label: "B" }], true)],
		});
		expect(r).toMatchObject({ ok: false, error: "preview_on_multiselect" });
	});

	it("allows preview on a single-select question", () => {
		const r = validate({
			questions: [q("Q", [{ label: "A", preview: "# hi" }, { label: "B" }])],
		});
		expect(r).toEqual({ ok: true });
	});

	it("treats empty-string previews as absent on multi-select", () => {
		const r = validate({
			questions: [q("Q", [{ label: "A", preview: "" }, { label: "B" }], true)],
		});
		expect(r).toEqual({ ok: true });
	});

	it("reports the index of the offending question/option in the message", () => {
		const params: TParams = {
			questions: [
				q("OK", [{ label: "A" }, { label: "B" }]),
				q("Bad", [{ label: "Next" }, { label: "B" }]),
			],
		};
		const r = validate(params);
		expect(r).toMatchObject({ ok: false, error: "reserved_label" });
		if (r.ok === false) {
			expect(r.message).toContain("question[1].options[0]");
		}
	});
});
