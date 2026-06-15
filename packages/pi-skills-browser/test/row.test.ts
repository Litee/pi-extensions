import { describe, expect, it } from "vitest";

import {
	ARROW_COL_WIDTH,
	PROMPT_INDICATOR_WIDTH,
	buildRowLine,
	computeNameColWidth,
	computePathColWidth,
} from "../src/row.js";
import type { SkillEntry } from "../src/helpers.js";
import type { RowTheme } from "../src/row.js";

// Identity theme: no ANSI, wraps `text` with `<fg:color>…</>` so we can
// assert on colour choice without depending on terminal escape sequences.
const markerTheme: RowTheme = {
	fg: (color, text) => `<${color}>${text}</>`,
};

function mkSkill(name: string, tokens: number, inPrompt = false): SkillEntry {
	return { name, description: "", tokens, path: "", pathDisplay: "", inPrompt, scope: "project" };
}

// ---------------------------------------------------------------------------
// computeNameColWidth / computePathColWidth
// ---------------------------------------------------------------------------

describe("computeNameColWidth", () => {
	it("returns a fixed 40 enough for ~38 char names", () => {
		expect(computeNameColWidth(80)).toBe(40);
		expect(computeNameColWidth(40)).toBe(40);
		expect(computeNameColWidth(100)).toBe(40);
	});
});

describe("computePathColWidth", () => {
	it("returns the remaining width after arrow, name, indicator, and badge", () => {
		const nameW = computeNameColWidth(80); // 40
		expect(computePathColWidth(80, nameW)).toBe(80 - 2 - 40 - 2 - 2 - 12); // 39
	});

	it("grows on wider terminals", () => {
		const nameW = computeNameColWidth(120); // 40
		expect(nameW).toBe(40);
		expect(computePathColWidth(120, nameW)).toBe(120 - 2 - 40 - 2 - 2 - 12); // 79
	});
});

// ---------------------------------------------------------------------------
// buildRowLine — truncation
// ---------------------------------------------------------------------------

describe("buildRowLine", () => {
	it("does not truncate when the name fits in the column", () => {
		const line = buildRowLine(
			mkSkill("short", 100),
			false,
			computeNameColWidth(80),
			computePathColWidth(80, computeNameColWidth(80)),
			12,
			markerTheme,
		);
		expect(line).toContain("short");
		expect(line).not.toContain("…");
	});

	it("truncates overlong names with a trailing ellipsis", () => {
		const line = buildRowLine(
			mkSkill("this-is-a-very-long-skill-name", 42),
			false,
			10,
			20,
			12,
			markerTheme,
		);
		// nameColWidth=10 → name is truncated to 9 chars + …
		const raw = line.replace(/<[^>]+>/g, "");
		expect(raw).toContain("this-is-a…");
	});

	it("truncates combined name+path when budget is exceeded", () => {
		const line = buildRowLine(
			mkSkill("name  ~/.pi/agent/skills/very/long/path/to/skill.md", 42),
			false,
			10,
			10,
			12,
			markerTheme,
		);
		// budget=20, combined="name  ~/.pi/agent/skills/very/long/path/to/skill.md" is ~50 chars
		expect(line).toContain("…");
	});

	it("produces a usable row at the minimum column width of 4", () => {
		const line = buildRowLine(
			mkSkill("foobar", 1),
			false,
			4,
			10,
			12,
			markerTheme,
		);
		expect(line).not.toContain("TypeError");
	});

	// -----------------------------------------------------------------------
	// Styling / selection
	// -----------------------------------------------------------------------

	it("prefixes unselected rows with two spaces and no accent arrow", () => {
		const line = buildRowLine(
			mkSkill("alpha", 10),
			false,
			computeNameColWidth(80),
			computePathColWidth(80, computeNameColWidth(80)),
			12,
			markerTheme,
		);
		expect(line.startsWith("  ")).toBe(true);
		expect(line).not.toContain("<accent>> </>");
		// Unselected badges are dim.
		expect(line).toContain("<dim>");
	});

	it("prefixes selected rows with an accent arrow and styles name + badge in accent", () => {
		const line = buildRowLine(
			mkSkill("alpha", 10),
			true,
			computeNameColWidth(80),
			computePathColWidth(80, computeNameColWidth(80)),
			12,
			markerTheme,
		);
		expect(line).toContain("<accent>> </>");
		expect(line).toContain("<accent>alpha");
		// Badge should also be in accent, not dim.
		expect(line).not.toContain("<dim>");
	});

	// -----------------------------------------------------------------------
	// Padding / badge alignment
	// -----------------------------------------------------------------------

	it("pads the name+path column so the badge right-aligns", () => {
		const nameW = computeNameColWidth(80);
		const pathW = computePathColWidth(80, nameW);
		const raw = buildRowLine(mkSkill("ab", 5), false, nameW, pathW, 12, markerTheme)
			.replace(/<[^>]+>/g, "");
		// Total visible = arrow(2) + name+path(nameW+pathW) + indicator(2) + badge(12)
		expect(raw.length).toBe(ARROW_COL_WIDTH + nameW + 2 + pathW + PROMPT_INDICATOR_WIDTH + 12);
	});

	it("renders the token badge via formatTokens (k-suffix for large values)", () => {
		const line = buildRowLine(
			mkSkill("x", 12345),
			false,
			computeNameColWidth(80),
			computePathColWidth(80, computeNameColWidth(80)),
			12,
			markerTheme,
		);
		// 12345 → "12k"
		expect(line).toContain("[12k tok]");
	});
});

// ---------------------------------------------------------------------------
// buildRowLine — prompt-status indicator
// ---------------------------------------------------------------------------

describe("buildRowLine inPrompt indicator", () => {
	it("shows no indicator text for skills not in the system prompt", () => {
		const nameW = computeNameColWidth(80);
		const pathW = computePathColWidth(80, nameW);
		const raw = buildRowLine(mkSkill("alpha", 10, false), false, nameW, pathW, 12, markerTheme)
			.replace(/<[^>]+>/g, "");
		expect(raw).not.toContain("●");
	});

	it("renders ● for skills active in the system prompt", () => {
		const nameW = computeNameColWidth(80);
		const pathW = computePathColWidth(80, nameW);
		const line = buildRowLine(mkSkill("alpha", 10, true), false, nameW, pathW, 12, markerTheme);
		expect(line).toContain("●");
	});

	it("colours the indicator with 'success' theme colour", () => {
		const nameW = computeNameColWidth(80);
		const pathW = computePathColWidth(80, nameW);
		const line = buildRowLine(mkSkill("alpha", 10, true), false, nameW, pathW, 12, markerTheme);
		expect(line).toContain("<success>\u25cf </>");
	});

	it("indicator is present after name+path column", () => {
		const nameW = computeNameColWidth(80);
		const pathW = computePathColWidth(80, nameW);
		const withIndicator = buildRowLine(mkSkill("ab", 5, true), false, nameW, pathW, 12, markerTheme)
			.replace(/<[^>]+>/g, "");
		const withoutIndicator = buildRowLine(mkSkill("ab", 5, false), false, nameW, pathW, 12, markerTheme)
			.replace(/<[^>]+>/g, "");
		// Both must be the same total length
		expect(withIndicator.length).toBe(withoutIndicator.length);
		// The indicator starts at ARROW_COL_WIDTH + nameW + pathW
		const indicatorStart = ARROW_COL_WIDTH + nameW + 2 + pathW;
		expect(withIndicator[indicatorStart]).toBe("●");
		expect(withoutIndicator[indicatorStart]).toBe(" ");
	});

	it("inPrompt indicator is unaffected by selection state", () => {
		const nameW = computeNameColWidth(80);
		const pathW = computePathColWidth(80, nameW);
		const selectedInPrompt = buildRowLine(mkSkill("alpha", 10, true), true, nameW, pathW, 12, markerTheme);
		expect(selectedInPrompt).toContain("<accent>> </>");
		expect(selectedInPrompt).toContain("<success>\u25cf </>");
	});
});
