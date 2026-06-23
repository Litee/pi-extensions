import { describe, expect, it } from "vitest";

import type { Result } from "../src/format.js";
import { renderCall, renderResult, type RenderTheme } from "../src/render.js";

/**
 * Wrapper theme that records every styling call so assertions can verify both
 * the text output and the intended colour/style tokens.
 */
function makeTheme(): RenderTheme & { calls: { kind: string; color?: string; text: string }[] } {
	const calls: { kind: string; color?: string; text: string }[] = [];
	return {
		calls,
		fg(color, text) {
			calls.push({ kind: "fg", color, text });
			return `<fg:${color}>${text}</fg>`;
		},
		bold(text) {
			calls.push({ kind: "bold", text });
			return `<b>${text}</b>`;
		},
	};
}

/** Text.render(width) right-pads each line to the requested width; normalise in assertions. */
function firstLine(comp: { render(w: number): string[] }, width = 400): string {
	return (comp.render(width)[0] ?? "").trimEnd();
}

/** Flatten all rendered lines so assertions can ignore wrapping. */
function allText(comp: { render(w: number): string[] }, width = 400): string {
	return comp.render(width).join("\n");
}

describe("renderCall()", () => {
	it("renders the tool title and question count", () => {
		const theme = makeTheme();
		const comp = renderCall({
			questions: [
				{ question: "A", options: [{ label: "x" }, { label: "y" }] },
				{ question: "B", options: [{ label: "x" }, { label: "y" }] },
			],
		}, theme);
		const out = allText(comp);
		expect(out).toContain("ask_user_question");
		expect(out).toContain("2 questions");
		expect(out).toContain("Q1, Q2");
		// Singular is used for count === 1.
		const singular = allText(renderCall({
			questions: [{ question: "A", options: [{ label: "x" }, { label: "y" }] }],
		}, theme));
		expect(singular).toContain("1 question");
		expect(singular).not.toContain("1 questions");
	});

	it("renders 0 questions when args are missing or malformed", () => {
		const theme = makeTheme();
		expect(allText(renderCall(undefined, theme))).toContain("0 questions");
		expect(allText(renderCall({ questions: "nope" } as unknown as Parameters<typeof renderCall>[0], theme))).toContain("0 questions");
	});

	it("uses the toolTitle and muted colours via theme.fg", () => {
		const theme = makeTheme();
		renderCall({ questions: [{ question: "A", options: [{ label: "x" }, { label: "y" }] }] }, theme);
		const colors = theme.calls.filter((c) => c.kind === "fg").map((c) => c.color);
		expect(colors).toContain("toolTitle");
		expect(colors).toContain("muted");
		expect(colors).toContain("dim");
	});
});

describe("renderResult()", () => {
	function toolResult(details: Result | undefined, text = "payload") {
		return {
			content: [{ type: "text" as const, text }],
			details,
		};
	}

	it("renders the error message in the 'error' colour when details.error is set", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: true, error: "boom" }, "boom"), true, theme);
		expect(firstLine(comp)).toBe("<fg:error>boom</fg>");
	});

	it("falls back to the literal 'error' string when no content is present", () => {
		const theme = makeTheme();
		const comp = renderResult(
			{ content: [], details: { answers: [], cancelled: true, error: "x" } },
			true,
			theme,
		);
		expect(firstLine(comp)).toBe("<fg:error>error</fg>");
	});

	it("renders 'Cancelled' in the warning colour when cancelled with no chat", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: true }), true, theme);
		expect(firstLine(comp)).toBe("<fg:warning>Cancelled</fg>");
	});

	it("appends the chat suffix when present", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: true, chat: "let's talk" }), true, theme);
		expect(firstLine(comp)).toContain("Cancelled (chat: let's talk)");
	});

	it("ignores empty-string chat value", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: true, chat: "" }), true, theme);
		expect(firstLine(comp)).toBe("<fg:warning>Cancelled</fg>");
	});

	it("renders the raw content[0] text on success", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: false }, "hello user"), true, theme);
		expect(firstLine(comp)).toBe("hello user");
	});

	it("renders empty string when content array has a non-text entry", () => {
		const theme = makeTheme();
		const weird = {
			content: [{ type: "image" as unknown as "text", text: "ignored" }],
			details: { answers: [], cancelled: false },
		};
		const comp = renderResult(weird, true, theme);
		expect(firstLine(comp)).toBe("");
	});

	it("treats undefined details like an error", () => {
		const theme = makeTheme();
		const comp = renderResult({ content: [{ type: "text", text: "ouch" }], details: undefined }, true, theme);
		expect(firstLine(comp)).toBe("<fg:error>ouch</fg>");
	});

	it("treats an empty-string error as 'not an error' (cancellation path)", () => {
		const theme = makeTheme();
		const comp = renderResult(
			{ content: [{ type: "text", text: "x" }], details: { answers: [], cancelled: true, error: "" } },
			true,
			theme,
		);
		expect(firstLine(comp)).toBe("<fg:warning>Cancelled</fg>");
	});
});

describe("renderResult() — collapse / expand", () => {
	function toolResult(details: Result | undefined, text = "payload") {
		return {
			content: [{ type: "text" as const, text }],
			details,
		};
	}

	it("error collapsed (expanded=false): single line containing ctrl-o hint", () => {
		const theme = makeTheme();
		const comp = renderResult(
			toolResult({ answers: [], cancelled: true, error: "Validation failed: bad input" }, "Validation failed: bad input"),
			false,
			theme,
		);
		const line = firstLine(comp);
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("ctrl-o to expand");
	});

	it("error collapsed (expanded=false): contains the start of the error message", () => {
		const theme = makeTheme();
		const comp = renderResult(
			toolResult({ answers: [], cancelled: true, error: "Validation failed" }, "Validation failed"),
			false,
			theme,
		);
		expect(firstLine(comp)).toContain("Validation failed");
	});

	it("error expanded (expanded=true): shows full error text, no hint", () => {
		const theme = makeTheme();
		const longError = "Validation failed: questions[0].options must have at least 2 entries";
		const comp = renderResult(
			toolResult({ answers: [], cancelled: true, error: longError }, longError),
			true,
			theme,
		);
		const line = firstLine(comp);
		expect(line).toContain(longError);
		expect(line).not.toContain("ctrl-o to expand");
	});

	it("error collapsed (expanded=false): truncates very long first lines to ~80 chars", () => {
		const theme = makeTheme();
		const longMsg = "A".repeat(100);
		const comp = renderResult(
			toolResult({ answers: [], cancelled: true, error: longMsg }, longMsg),
			false,
			theme,
		);
		const line = firstLine(comp);
		expect(line).not.toContain("A".repeat(100));
		expect(line).toContain("ctrl-o to expand");
	});

	it("error collapsed (expanded=false): only first line shown for multi-line errors", () => {
		const theme = makeTheme();
		const multiLine = "Line 1\nLine 2\nLine 3";
		const comp = renderResult(
			toolResult({ answers: [], cancelled: true, error: multiLine }, multiLine),
			false,
			theme,
		);
		const line = firstLine(comp);
		expect(line).toContain("Line 1");
		expect(line).not.toContain("Line 2");
		expect(line).not.toContain("Line 3");
	});
});

describe("renderResult() — harness-injected error (empty details)", () => {
	const BLOB = [
		'Validation failed for tool "ask_user_question":',
		"  - questions.1.question: must have required properties question",
		"",
		"Received arguments:",
		'{ "questions": [ { "options": [{"label":"Yes"},{"label":"No"}] } ] }',
	].join("\n");

	function harnessResult() {
		return {
			content: [{ type: "text" as const, text: BLOB }],
			details: {} as unknown as import("../src/format.js").Result,
		};
	}

	it("collapsed: single line, contains first-line text, styled error", () => {
		const theme = makeTheme();
		const comp = renderResult(harnessResult(), false, theme);
		const line = firstLine(comp);
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("Validation failed for tool");
		expect(line).toContain("<fg:error>");
	});

	it("collapsed: does NOT contain later lines or json dump", () => {
		const theme = makeTheme();
		const comp = renderResult(harnessResult(), false, theme);
		const line = firstLine(comp);
		expect(line).not.toContain("Received arguments");
		expect(line).not.toContain("{");
	});

	it("collapsed: contains ctrl-o to expand hint", () => {
		const theme = makeTheme();
		const comp = renderResult(harnessResult(), false, theme);
		expect(firstLine(comp)).toContain("ctrl-o to expand");
	});

	it("expanded: contains full blob including Received arguments and json brace", () => {
		const theme = makeTheme();
		const comp = renderResult(harnessResult(), true, theme);
		const out = allText(comp);
		expect(out).toContain("Received arguments");
		expect(out).toContain("{");
		expect(out).toContain("Validation failed for tool");
	});

	it("expanded: does NOT contain ctrl-o to expand hint", () => {
		const theme = makeTheme();
		const comp = renderResult(harnessResult(), true, theme);
		expect(allText(comp)).not.toContain("ctrl-o to expand");
	});
});
