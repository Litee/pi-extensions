import { describe, expect, it } from "vitest";
import { collapsePreview, toolText } from "../src/renderer.js";

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
