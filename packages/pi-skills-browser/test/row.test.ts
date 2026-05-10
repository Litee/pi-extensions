import { describe, expect, it } from "vitest";

import {
	ARROW_COL_WIDTH,
	TOKEN_COL_WIDTH,
	buildRowLine,
	computeNameColWidth,
} from "../src/row.js";
import type { SkillEntry } from "../src/helpers.js";
import type { RowTheme } from "../src/row.js";

// Identity theme: no ANSI, wraps `text` with `<fg:color>…</>` so we can
// assert on colour choice without depending on terminal escape sequences.
const markerTheme: RowTheme = {
	fg: (color, text) => `<${color}>${text}</>`,
};

function mkSkill(name: string, tokens: number): SkillEntry {
	return { name, description: "", tokens, path: "" };
}

// ---------------------------------------------------------------------------
// computeNameColWidth
// ---------------------------------------------------------------------------

describe("computeNameColWidth", () => {
	it("returns width minus arrow and badge columns for normal widths", () => {
		expect(computeNameColWidth(80)).toBe(80 - ARROW_COL_WIDTH - TOKEN_COL_WIDTH);
	});

	it("clamps to a minimum of 4 when the terminal is very narrow", () => {
		expect(computeNameColWidth(0)).toBe(4);
		expect(computeNameColWidth(10)).toBe(4);
		// Even when the arithmetic would produce a negative value.
		expect(computeNameColWidth(-100)).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// buildRowLine — truncation
// ---------------------------------------------------------------------------

describe("buildRowLine", () => {
	it("does not truncate when the name fits in the column", () => {
		const line = buildRowLine(mkSkill("short", 100), false, 20, 12, markerTheme);
		expect(line).toContain("short");
		expect(line).not.toContain("…");
	});

	it("truncates overlong names with a trailing ellipsis", () => {
		const line = buildRowLine(
			mkSkill("this-is-a-very-long-skill-name", 42),
			false,
			10,
			12,
			markerTheme,
		);
		// nameColWidth=10 → slice(0, 9) + "…" = "this-is-a…"
		expect(line).toContain("this-is-a…");
		expect(line).not.toContain("this-is-a-v");
	});

	it("produces a usable row at the minimum column width of 4", () => {
		// "foobar" (6 chars) → slice(0, 3) + "…" = "foo…"
		const line = buildRowLine(mkSkill("foobar", 1), false, 4, 12, markerTheme);
		expect(line).toContain("foo…");
	});

	// -----------------------------------------------------------------------
	// Styling / selection
	// -----------------------------------------------------------------------

	it("prefixes unselected rows with two spaces and no accent arrow", () => {
		const line = buildRowLine(mkSkill("alpha", 10), false, 20, 12, markerTheme);
		expect(line.startsWith("  ")).toBe(true);
		expect(line).not.toContain("<accent>> </>");
		// Unselected badges are dim.
		expect(line).toContain("<dim>");
	});

	it("prefixes selected rows with an accent arrow and styles name + badge in accent", () => {
		const line = buildRowLine(mkSkill("alpha", 10), true, 20, 12, markerTheme);
		expect(line).toContain("<accent>> </>");
		expect(line).toContain("<accent>alpha</>");
		// Badge should also be in accent, not dim.
		expect(line).not.toContain("<dim>");
	});

	// -----------------------------------------------------------------------
	// Padding / badge alignment
	// -----------------------------------------------------------------------

	it("pads the name column to nameColWidth so the badge right-aligns", () => {
		// Strip marker tags to measure raw character positions.
		const raw = buildRowLine(mkSkill("ab", 5), false, 10, 12, markerTheme)
			.replace(/<[^>]+>/g, "");
		// "  " + "ab" + 8 spaces + 12-wide badge = 24 chars total
		expect(raw.length).toBe(ARROW_COL_WIDTH + 10 + 12);
		// Badge is `[5 tok]` padStart(12) → 5 leading spaces.
		expect(raw).toMatch(/ {5}\[5 tok]$/);
	});

	it("renders the token badge via formatTokens (k-suffix for large values)", () => {
		const line = buildRowLine(mkSkill("x", 12345), false, 20, 12, markerTheme);
		// 12345 → "12k"
		expect(line).toContain("[12k tok]");
	});
});
