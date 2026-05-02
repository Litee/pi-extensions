import { describe, expect, it } from "vitest";

import { buildRows } from "../src/rows.js";
import type { TQuestion } from "../src/schema.js";

describe("buildRows()", () => {
	it("appends a 'Type something.' sentinel for single-select with no previews", () => {
		const q: TQuestion = {
			question: "Pick",
			options: [{ label: "A" }, { label: "B" }],
		};
		const rows = buildRows(q);
		expect(rows.map((r) => r.kind)).toEqual(["option", "option", "text", "chat"]);
		expect(rows[2]).toMatchObject({ kind: "text", label: "Type something." });
		expect(rows[3]).toMatchObject({ kind: "chat", label: "Chat about this" });
	});

	it("suppresses 'Type something.' when any option has a preview (side-by-side layout)", () => {
		const q: TQuestion = {
			question: "Pick",
			options: [{ label: "A", preview: "# md" }, { label: "B" }],
		};
		const rows = buildRows(q);
		expect(rows.map((r) => r.kind)).toEqual(["option", "option", "chat"]);
		expect(rows[0]?.preview).toBe("# md");
		expect(rows[1]?.preview).toBeUndefined();
	});

	it("treats empty-string preview as absent", () => {
		const q: TQuestion = {
			question: "Pick",
			options: [{ label: "A", preview: "" }, { label: "B" }],
		};
		const rows = buildRows(q);
		// No preview → text sentinel should still be appended.
		expect(rows.map((r) => r.kind)).toEqual(["option", "option", "text", "chat"]);
	});

	it("appends a 'Next' sentinel (not 'Type something.') on multi-select", () => {
		const q: TQuestion = {
			question: "Pick many",
			multiSelect: true,
			options: [{ label: "A" }, { label: "B" }, { label: "C" }],
		};
		const rows = buildRows(q);
		expect(rows.map((r) => r.kind)).toEqual(["option", "option", "option", "next", "chat"]);
		expect(rows.at(-2)).toMatchObject({ kind: "next", label: "Next" });
		expect(rows.at(-1)).toMatchObject({ kind: "chat", label: "Chat about this" });
	});

	it("preserves author option order and attaches the original index", () => {
		const q: TQuestion = {
			question: "Pick",
			options: [
				{ label: "Zero", description: "first" },
				{ label: "One" },
				{ label: "Two", description: "third" },
			],
		};
		const rows = buildRows(q);
		expect(rows[0]).toMatchObject({ kind: "option", label: "Zero", optionIndex: 0, description: "first" });
		expect(rows[1]).toMatchObject({ kind: "option", label: "One", optionIndex: 1 });
		expect(rows[2]).toMatchObject({ kind: "option", label: "Two", optionIndex: 2, description: "third" });
		// The trailing sentinels should not carry an optionIndex.
		expect(rows[3]?.optionIndex).toBeUndefined();
	});

	it("does not carry a description field when the option has none", () => {
		const q: TQuestion = {
			question: "Pick",
			options: [{ label: "A" }, { label: "B" }],
		};
		const rows = buildRows(q);
		expect(rows[0]).not.toHaveProperty("description");
	});
});
