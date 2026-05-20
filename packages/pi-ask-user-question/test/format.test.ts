import { describe, expect, it } from "vitest";

import { emptyResult, formatToolResult, type Answer, type Result } from "../src/format.js";
import type { TQuestion } from "../src/schema.js";

const twoQuestions: TQuestion[] = [
	{ question: "Colour?", options: [{ label: "Red" }, { label: "Blue" }] },
	{ question: "Size?", options: [{ label: "S" }, { label: "M" }] },
];

describe("emptyResult()", () => {
	it("produces a bare cancelled result", () => {
		const r = emptyResult(true);
		expect(r).toEqual({ answers: [], cancelled: true });
	});

	it("includes the error string when provided", () => {
		const r = emptyResult(true, "boom");
		expect(r).toEqual({ answers: [], cancelled: true, error: "boom" });
	});

	it("omits the `error` property when no message is given", () => {
		const r = emptyResult(false);
		expect(r).not.toHaveProperty("error");
	});
});

describe("formatToolResult()", () => {
	it("returns the error message verbatim when details.error is set", () => {
		const r: Result = { answers: [], cancelled: true, error: "validation failed" };
		const out = formatToolResult(r, []);
		expect(out.content).toEqual([{ type: "text", text: "validation failed" }]);
		expect(out.details).toBe(r);
	});

	it("ignores an empty-string error and falls back to the normal cancellation path", () => {
		const r: Result = { answers: [], cancelled: true, error: "" };
		const out = formatToolResult(r, twoQuestions);
		expect(out.content[0]?.text).toMatch(/^User cancelled the questionnaire\./);
	});

	it("renders a plain cancellation when no chat string is attached", () => {
		const r: Result = { answers: [], cancelled: true };
		const out = formatToolResult(r, twoQuestions);
		expect(out.content[0]?.text).toBe("User cancelled the questionnaire.");
	});

	it("appends the chat payload when the user abandoned via 'Chat about this'", () => {
		const r: Result = { answers: [], cancelled: true, chat: "let's rethink" };
		const out = formatToolResult(r, twoQuestions);
		expect(out.content[0]?.text).toBe(
			"User cancelled the questionnaire. Chat: let's rethink",
		);
	});

	it("omits the chat suffix when it's an empty string", () => {
		const r: Result = { answers: [], cancelled: true, chat: "" };
		const out = formatToolResult(r, twoQuestions);
		expect(out.content[0]?.text).toBe("User cancelled the questionnaire.");
	});

	it("renders a single-question single-select answer without the summary wrapper", () => {
		const single: Answer = { kind: "single", index: 1, label: "Blue" };
		const r: Result = { answers: [single], cancelled: false };
		const out = formatToolResult(r, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("selected 2. Blue");
	});

	it("appends a note to a single-question single-select answer when present", () => {
		const single: Answer = { kind: "single", index: 0, label: "Red", note: "matches logo" };
		const out = formatToolResult({ answers: [single], cancelled: false }, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("selected 1. Red — note: matches logo");
	});

	it("treats an empty-string note on a single-question single-select as no note", () => {
		const single: Answer = { kind: "single", index: 0, label: "Red", note: "" };
		const out = formatToolResult({ answers: [single], cancelled: false }, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("selected 1. Red");
	});

	it("renders a single-question multi-select answer without the summary wrapper", () => {
		const multi: Answer = {
			kind: "multi",
			indices: [0, 1],
			labels: ["Red", "Blue"],
			notes: { 1: "calmer" },
		};
		const out = formatToolResult({ answers: [multi], cancelled: false }, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("selected [1. Red, 2. Blue — note: calmer]");
	});

	it("uses '?' when a label is missing from a single-question multi-select answer", () => {
		const multi: Answer = {
			kind: "multi",
			indices: [0, 1],
			labels: ["Red"], // labels[1] missing
			notes: {},
		};
		const out = formatToolResult({ answers: [multi], cancelled: false }, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("selected [1. Red, 2. ?]");
	});

	it("ignores empty-string notes on a single-question multi-select answer", () => {
		const multi: Answer = {
			kind: "multi",
			indices: [0],
			labels: ["Red"],
			notes: { 0: "" },
		};
		const out = formatToolResult({ answers: [multi], cancelled: false }, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("selected [1. Red]");
		expect(out.content[0]?.text).not.toContain("note:");
	});

	it("renders a single-question free-text answer without the summary wrapper", () => {
		const text: Answer = { kind: "text", text: "something else" };
		const out = formatToolResult({ answers: [text], cancelled: false }, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("user typed: something else");
	});

	it("renders a single-question chat answer without the summary wrapper", () => {
		const chat: Answer = { kind: "chat", text: "too broad" };
		const out = formatToolResult({ answers: [chat], cancelled: false }, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("user chose 'Chat about this': too broad");
	});

	it("renders a single-question skipped answer without the summary wrapper", () => {
		const out = formatToolResult({ answers: [null], cancelled: false }, [twoQuestions[0]!]);
		expect(out.content[0]?.text).toBe("(no answer)");
	});

	it("keeps the summary wrapper for multi-question results (single-select sample)", () => {
		const answers: Answer[] = [
			{ kind: "single", index: 1, label: "Blue" },
			{ kind: "single", index: 0, label: "S" },
		];
		const out = formatToolResult({ answers, cancelled: false }, twoQuestions);
		expect(out.content[0]?.text).toBe(
			[
				"User has answered your questions:",
				"Q1 (Colour?): selected 2. Blue",
				"Q2 (Size?): selected 1. S",
			].join("\n"),
		);
	});

	it("emits '(no answer)' for null slots (when earlier questions were skipped)", () => {
		const answers: (Answer | null)[] = [null, { kind: "single", index: 0, label: "S" }];
		const out = formatToolResult({ answers, cancelled: false }, twoQuestions);
		const text = out.content[0]?.text ?? "";
		expect(text).toContain("Q1 (Colour?): (no answer)");
		expect(text).toContain("Q2 (Size?): selected 1. S");
	});

	it("tolerates an answers array shorter than the questions array", () => {
		const out = formatToolResult({ answers: [], cancelled: false }, twoQuestions);
		const text = out.content[0]?.text ?? "";
		expect(text).toContain("Q1 (Colour?): (no answer)");
		expect(text).toContain("Q2 (Size?): (no answer)");
	});

	it("defensively handles a missing question entry within a mixed questions list", () => {
		const mixed: TQuestion[] = [
			twoQuestions[0]!,
			// Simulate the second question being undefined in a malformed call.
			undefined as unknown as TQuestion,
		];
		const answers = [
			{ kind: "single", index: 0, label: "Red" } as const,
			{ kind: "single", index: 0, label: "X" } as const,
		];
		const out = formatToolResult({ answers, cancelled: false }, mixed);
		expect(out.content[0]?.text).toContain("Q1 (Colour?): selected 1. Red");
		expect(out.content[0]?.text).toContain("Q2 (): selected 1. X");
	});
});
