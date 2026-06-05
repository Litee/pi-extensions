import { describe, expect, it } from "vitest";

import {
	ARROW_COL_WIDTH,
	PROMPT_INDICATOR_WIDTH,
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

function mkSkill(name: string, tokens: number, inPrompt = false): SkillEntry {
	return { name, description: "", tokens, path: "", inPrompt };
}

// ---------------------------------------------------------------------------
// computeNameColWidth
// ---------------------------------------------------------------------------

describe("computeNameColWidth", () => {
	it("returns width minus arrow, prompt indicator, and badge columns for normal widths", () => {
		expect(computeNameColWidth(80)).toBe(80 - ARROW_COL_WIDTH - PROMPT_INDICATOR_WIDTH - TOKEN_COL_WIDTH);
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
		// "  " + "ab" + 8 spaces + "  " (indicator) + 12-wide badge = 26 chars total
		expect(raw.length).toBe(ARROW_COL_WIDTH + 10 + PROMPT_INDICATOR_WIDTH + 12);
		// Badge is `[5 tok]` padStart(12) → 5 leading spaces.
		expect(raw).toMatch(/ {5}\[5 tok]$/);
	});

	it("renders the token badge via formatTokens (k-suffix for large values)", () => {
		const line = buildRowLine(mkSkill("x", 12345), false, 20, 12, markerTheme);
		// 12345 → "12k"
		expect(line).toContain("[12k tok]");
	});
});

// ---------------------------------------------------------------------------
// buildRowLine — prompt-status indicator
// ---------------------------------------------------------------------------

describe("buildRowLine inPrompt indicator", () => {
	it("shows no indicator text for skills not in the system prompt", () => {
		const raw = buildRowLine(mkSkill("alpha", 10, false), false, 20, 12, markerTheme)
			.replace(/<[^>]+>/g, "");
		// The two indicator chars should be spaces, not ●
		expect(raw).not.toContain("●");
	});

	it("renders ● for skills active in the system prompt", () => {
		const line = buildRowLine(mkSkill("alpha", 10, true), false, 20, 12, markerTheme);
		expect(line).toContain("●");
	});

	it("colours the indicator with 'success' theme colour", () => {
		const line = buildRowLine(mkSkill("alpha", 10, true), false, 20, 12, markerTheme);
		expect(line).toContain("<success>\u25cf </>");
	});

	it("indicator is present between name column and token badge", () => {
		// Strip tags and verify layout order: arrow → name+pad → indicator → badge
		const withIndicator = buildRowLine(mkSkill("ab", 5, true), false, 10, 12, markerTheme)
			.replace(/<[^>]+>/g, "");
		const withoutIndicator = buildRowLine(mkSkill("ab", 5, false), false, 10, 12, markerTheme)
			.replace(/<[^>]+>/g, "");
		// Both must be the same total length
		expect(withIndicator.length).toBe(withoutIndicator.length);
		// The indicator row must contain ● at position ARROW_COL_WIDTH + nameColWidth
		const indicatorStart = ARROW_COL_WIDTH + 10;
		expect(withIndicator[indicatorStart]).toBe("●");
		expect(withoutIndicator[indicatorStart]).toBe(" ");
	});

	it("inPrompt indicator is unaffected by selection state", () => {
		const selectedInPrompt = buildRowLine(mkSkill("alpha", 10, true), true, 20, 12, markerTheme);
		// Selected + inPrompt: both accent arrow and success indicator appear
		expect(selectedInPrompt).toContain("<accent>> </>");
		expect(selectedInPrompt).toContain("<success>\u25cf </>");
	});
});
