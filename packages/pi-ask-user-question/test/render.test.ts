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
		const comp = renderResult(toolResult({ answers: [], cancelled: true, error: "boom" }, "boom"), theme);
		expect(firstLine(comp)).toBe("<fg:error>boom</fg>");
	});

	it("falls back to the literal 'error' string when no content is present", () => {
		const theme = makeTheme();
		const comp = renderResult(
			{ content: [], details: { answers: [], cancelled: true, error: "x" } },
			theme,
		);
		expect(firstLine(comp)).toBe("<fg:error>error</fg>");
	});

	it("renders 'Cancelled' in the warning colour when cancelled with no chat", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: true }), theme);
		expect(firstLine(comp)).toBe("<fg:warning>Cancelled</fg>");
	});

	it("appends the chat suffix when present", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: true, chat: "let's talk" }), theme);
		expect(firstLine(comp)).toContain("Cancelled (chat: let's talk)");
	});

	it("ignores empty-string chat value", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: true, chat: "" }), theme);
		expect(firstLine(comp)).toBe("<fg:warning>Cancelled</fg>");
	});

	it("renders the raw content[0] text on success", () => {
		const theme = makeTheme();
		const comp = renderResult(toolResult({ answers: [], cancelled: false }, "hello user"), theme);
		expect(firstLine(comp)).toBe("hello user");
	});

	it("renders empty string when content array has a non-text entry", () => {
		const theme = makeTheme();
		const weird = {
			content: [{ type: "image" as unknown as "text", text: "ignored" }],
			details: { answers: [], cancelled: false },
		};
		const comp = renderResult(weird as Parameters<typeof renderResult>[0], theme);
		expect(firstLine(comp)).toBe("");
	});

	it("treats undefined details like an error", () => {
		const theme = makeTheme();
		const comp = renderResult({ content: [{ type: "text", text: "ouch" }], details: undefined }, theme);
		expect(firstLine(comp)).toBe("<fg:error>ouch</fg>");
	});

	it("treats an empty-string error as 'not an error' (cancellation path)", () => {
		const theme = makeTheme();
		const comp = renderResult(
			{ content: [{ type: "text", text: "x" }], details: { answers: [], cancelled: true, error: "" } },
			theme,
		);
		expect(firstLine(comp)).toBe("<fg:warning>Cancelled</fg>");
	});
});
