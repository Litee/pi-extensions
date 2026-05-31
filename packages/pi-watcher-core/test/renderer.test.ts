import { beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { collapsePreview, toolText, createWatcherMessageRenderer } from "../src/renderer.js";

// keyHint() requires initTheme() to have been called once before rendering.
beforeAll(() => { initTheme(undefined); });

describe("toolText", () => {
	it("wraps string as content array", () => {
		expect(toolText("hello")).toEqual([{ type: "text", text: "hello" }]);
	});

	it("preserves empty string", () => {
		expect(toolText("")).toEqual([{ type: "text", text: "" }]);
	});
});

describe("collapsePreview", () => {
	it("returns full text when 1 non-empty line", () => {
		expect(collapsePreview("one line")).toBe("one line");
	});

	it("returns full text when exactly 2 non-empty lines — no ellipsis", () => {
		expect(collapsePreview("line one\nline two")).toBe("line one\nline two");
	});

	it("returns full text when exactly 3 non-empty lines — no ellipsis", () => {
		const result = collapsePreview("line one\nline two\nline three");
		expect(result).toBe("line one\nline two\nline three");
	});

	it("appends ellipsis when more than 3 non-empty lines", () => {
		const result = collapsePreview("line one\nline two\nline three\nline four");
		expect(result).toBe("line one\nline two\n…");
	});

	it("blank lines are not counted toward the 2-line limit", () => {
		// 2 non-empty lines separated by a blank — should NOT append ellipsis.
		expect(collapsePreview("line one\n\nline two")).toBe("line one\nline two");
	});

	it("blank lines between content are not counted — ellipsis when >3 non-empty", () => {
		const result = collapsePreview("line one\n\nline two\n\nline three\n\nline four");
		expect(result).toBe("line one\nline two\n…");
	});

	it("empty string returns empty string", () => {
		expect(collapsePreview("")).toBe("");
	});

	it("leading/trailing blank lines are ignored", () => {
		expect(collapsePreview("\nline one\n\nline two\n")).toBe("line one\nline two");
	});

	it("whitespace-only lines are treated as empty", () => {
		const result = collapsePreview("line one\n   \nline two\nline three");
		expect(result).toBe("line one\nline two\nline three");
	});
});

// ---------------------------------------------------------------------------
// createWatcherMessageRenderer — expandedTextOverride
// ---------------------------------------------------------------------------
// We test only the callback-invocation contract, not the TUI rendering output.
// The TUI components (Box, Text, Markdown) are real classes that run fine in
// Node — we only need to verify *what text* gets passed to Markdown.
// Strategy: mock the pi-tui Markdown constructor to record the first argument.

const markdownCalls: string[] = [];

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const real = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	return {
		...real,
		Markdown: class MockMarkdown extends real.Markdown {
			constructor(text: string, p1?: unknown, p2?: unknown, p3?: unknown) {
				// Call super with explicit args — avoids spread-of-any type errors.
				super(
					text,
					p1 as never,
					p2 as never,
					p3 as never,
				);
				markdownCalls.push(text);
			}
		},
	};
});

// Minimal fake theme that satisfies the renderer contract
const fakeTheme = {
	bg: (_: string, t: string) => t,
	fg: (_: string, t: string) => t,
	bold: (t: string) => t,
};

describe("createWatcherMessageRenderer — expandedTextOverride", () => {
	it("calls expandedTextOverride when expanded=true", () => {
		markdownCalls.length = 0;
		const override = vi.fn().mockReturnValue("OVERRIDE TEXT");
		const renderer = createWatcherMessageRenderer("test-watcher", { expandedTextOverride: override });
		const msg = { content: "original content", details: {} };
		renderer(msg, { expanded: true }, fakeTheme as never);
		expect(override).toHaveBeenCalledOnce();
		expect(override).toHaveBeenCalledWith(msg);
	});

	it("uses override return value as Markdown text in expanded mode", () => {
		markdownCalls.length = 0;
		const override = vi.fn().mockReturnValue("OVERRIDE TEXT");
		const renderer = createWatcherMessageRenderer("test-watcher", { expandedTextOverride: override });
		renderer({ content: "original content" }, { expanded: true }, fakeTheme as never);
		expect(markdownCalls.at(-1)).toBe("OVERRIDE TEXT");
	});

	it("falls through to original content when override returns undefined", () => {
		markdownCalls.length = 0;
		const override = vi.fn().mockReturnValue(undefined);
		const renderer = createWatcherMessageRenderer("test-watcher", { expandedTextOverride: override });
		renderer({ content: "original content" }, { expanded: true }, fakeTheme as never);
		expect(markdownCalls.at(-1)).toBe("original content");
	});

	it("does NOT call expandedTextOverride when expanded=false", () => {
		markdownCalls.length = 0;
		const override = vi.fn().mockReturnValue("OVERRIDE");
		const renderer = createWatcherMessageRenderer("test-watcher", { expandedTextOverride: override });
		renderer({ content: "original content" }, { expanded: false }, fakeTheme as never);
		expect(override).not.toHaveBeenCalled();
	});
});

describe("createWatcherMessageRenderer — extractText + hint paths", () => {
	it("extracts text from array content in expanded mode", () => {
		markdownCalls.length = 0;
		const renderer = createWatcherMessageRenderer("array-watcher");
		const arrayContent = [
			{ type: "text", text: "first line" },
			{ type: "text", text: "second line" },
			null,                  // filtered out (not object)
			{ type: "text" },     // no text property → empty string contribution
		];
		renderer({ content: arrayContent }, { expanded: true }, fakeTheme as never);
		// extractText joins the text values with "\n"
		expect(markdownCalls.at(-1)).toBe("first line\nsecond line\n");
	});

	it("collapsed: appends keyHint when preview ends with ellipsis (>3 non-empty lines)", () => {
		// This exercises the `hint = preview.endsWith("…") ? ... : ""` true-branch.
		const renderer = createWatcherMessageRenderer("hint-watcher");
		// Should not throw; the hint branch appends a keyHint via theme.fg("dim", ...)
		expect(() => {
			renderer(
				{ content: "line1\nline2\nline3\nline4\nline5" },
				{ expanded: false },
				fakeTheme as never,
			);
		}).not.toThrow();
	});

	it("handles non-string non-array content gracefully (extractText returns empty)", () => {
		markdownCalls.length = 0;
		const renderer = createWatcherMessageRenderer("fallback-watcher");
		// content is a plain object — extractText falls through to `return ""`
		renderer({ content: { unexpected: true } }, { expanded: true }, fakeTheme as never);
		expect(markdownCalls.at(-1)).toBe("");
	});
});
