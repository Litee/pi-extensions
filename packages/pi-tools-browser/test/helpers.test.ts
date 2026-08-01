import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { buildSelectorTitle, estimateToolTokens, formatTokens, sourceLabel, truncate } from "../src/helpers.js";

function mkTool(partial: Partial<ToolInfo> & { name: string }): ToolInfo {
	return {
		name: partial.name,
		description: partial.description ?? "",
		parameters: partial.parameters ?? {},
		sourceInfo: partial.sourceInfo ?? {
			source: "builtin",
			path: `<builtin:${partial.name}>`,
			scope: "temporary",
			origin: "top-level",
		},
	} as ToolInfo;
}

describe("truncate", () => {
	it("returns the input unchanged when it fits", () => {
		expect(truncate("short", 10)).toBe("short");
	});

	it("returns the input unchanged when length equals the budget", () => {
		expect(truncate("abcdefghij", 10)).toBe("abcdefghij");
	});

	it("collapses internal whitespace", () => {
		expect(truncate("hello   world   ", 100)).toBe("hello world");
	});

	it("trims leading and trailing whitespace before measuring", () => {
		expect(truncate("  hello  ", 100)).toBe("hello");
	});

	it("cuts at the last word boundary when one exists late in the budget", () => {
		// "the quick brown fox" — slice(0,9)="the quick", space at idx 3 (>4.5), so base="the quick"? Let's walk:
		//   max=10 → budget=9 → slice="the quick" (length 9) → lastSpace=3 → 3 > floor(9/2)=4? No, 3<=4.
		// So base=slice, result="the quic…" (hard cut). Good for verifying "no word boundary late".
		// For late boundary, use a 15-char budget:
		//   max=16 → budget=15 → slice="the quick brown" → lastSpace=9 → 9 > floor(15/2)=7 → base="the quick"
		expect(truncate("the quick brown fox jumps", 16)).toBe("the quick…");
	});

	it("falls back to a hard cut when no late word boundary exists", () => {
		expect(truncate("abcdefghijklmno", 10)).toBe("abcdefghi…");
	});

	it("emits a single ellipsis character, not three dots", () => {
		expect(truncate("abcdefghijklmnop", 5)).toMatch(/…$/);
		expect(truncate("abcdefghijklmnop", 5)).not.toMatch(/\.\.\.$/);
	});

	it("collapses newlines into single spaces before truncating", () => {
		expect(truncate("line one\n\nline two", 100)).toBe("line one line two");
	});

	it("never returns more than `max` visible characters", () => {
		for (const max of [1, 2, 5, 20, 80]) {
			expect(truncate("a".repeat(200), max).length).toBeLessThanOrEqual(max);
		}
	});

	it("clamps budgets below 1 to produce at least the ellipsis", () => {
		// Degenerate but must not throw.
		expect(truncate("abcdef", 1)).toBe("…");
	});

	it("returns empty string when max is 0 or negative (max <= 0 branch)", () => {
		expect(truncate("abcdef", 0)).toBe("");
		expect(truncate("abcdef", -5)).toBe("");
	});
});

describe("formatTokens", () => {
	it("formats small numbers verbatim", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats thousands with one decimal below 10k", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(9949)).toBe("9.9k");
	});

	it("formats ten-thousands and above with no decimals", () => {
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(12345)).toBe("12k");
		expect(formatTokens(123456)).toBe("123k");
	});
});

describe("estimateToolTokens", () => {
	it("counts name + description + JSON parameters as chars/4 (ceil)", () => {
		// name=4, description=8, JSON.stringify({}) length=2 → 14 chars → ceil(14/4)=4
		const tool = mkTool({ name: "read", description: "describe." });
		// name(4) + description(9) + "{}" (2) = 15 → ceil(15/4) = 4
		expect(estimateToolTokens(tool)).toBe(4);
	});

	it("handles missing description gracefully", () => {
		const tool = mkTool({ name: "noop" });
		// name(4) + "{}"(2) = 6 → ceil(6/4) = 2
		expect(estimateToolTokens(tool)).toBe(2);
	});

	it("handles parameters being undefined (?? nullish branch)", () => {
		// mkTool defaults parameters to {}, so force undefined via a raw cast.
		const tool = { name: "x", description: "d", parameters: undefined } as unknown as ToolInfo;
		// name(1) + description(1) + "{}"(2) = 4 → ceil(4/4) = 1
		expect(estimateToolTokens(tool)).toBe(1);
	});

	it("handles non-serializable parameter shapes without throwing", () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic["self"] = cyclic;
		const tool = mkTool({ name: "x", parameters: cyclic });
		expect(() => estimateToolTokens(tool)).not.toThrow();
		expect(estimateToolTokens(tool)).toBeGreaterThan(0);
	});

	it("grows with the size of the parameter schema", () => {
		const small = mkTool({ name: "t", parameters: { a: 1 } });
		const large = mkTool({
			name: "t",
			parameters: { a: 1, b: "x".repeat(100), c: [1, 2, 3, 4, 5] },
		});
		expect(estimateToolTokens(large)).toBeGreaterThan(estimateToolTokens(small));
	});
});

describe("sourceLabel", () => {
	it("collapses the synthetic builtin path to just 'builtin'", () => {
		const tool = mkTool({
			name: "read",
			sourceInfo: {
				source: "builtin",
				path: "<builtin:read>",
				scope: "temporary",
				origin: "top-level",
			},
		});
		expect(sourceLabel(tool)).toBe("builtin");
	});

	it("includes the real path for extension tools", () => {
		const tool = mkTool({
			name: "custom",
			sourceInfo: {
				source: "extension",
				path: "/abs/path/ext.ts",
				scope: "temporary",
				origin: "top-level",
			},
		});
		expect(sourceLabel(tool)).toBe("extension · /abs/path/ext.ts");
	});

	it("falls back to 'unknown' when sourceInfo is missing", () => {
		const tool = { name: "x", description: "", parameters: {} } as ToolInfo;
		expect(sourceLabel(tool)).toBe("unknown");
	});
});

describe("render title truncation – narrow-terminal crash regression", () => {
	// Before the fix, index.ts called theme.bold(title) without truncating to `w`,
	// causing pi to crash with "Rendered line N exceeds terminal width" when the
	// terminal was ~56 cols.  This suite documents the required behaviour:
	// buildSelectorTitle() may produce a string wider than `w`, and callers are
	// expected to pass it through truncate(title, w) before styling.

	it("buildSelectorTitle with realistic counts produces a title wider than 56 chars", () => {
		// Reproduces the exact crash: 19 tools, 13 active, ~3.7k/6.2k tokens → 62 chars.
		const title = buildSelectorTitle(19, 13, 3700, 6200);
		expect(title.length).toBeGreaterThan(56);
	});

	it("truncate(buildSelectorTitle(…), 56) fits within 56 chars", () => {
		const title = buildSelectorTitle(19, 13, 3700, 6200);
		const truncated = truncate(title, 56);
		expect(truncated.length).toBeLessThanOrEqual(56);
	});

	it("truncate(buildSelectorTitle(…), w) fits within w for various narrow widths", () => {
		for (const w of [20, 30, 40, 50, 56, 60]) {
			const title = buildSelectorTitle(19, 13, 3700, 6200);
			expect(truncate(title, w).length).toBeLessThanOrEqual(w);
		}
	});

	it("hint line truncated to narrow width fits", () => {
		const hint = " t to toggle · Enter to view details · Esc to close";
		expect(truncate(hint, 56).length).toBeLessThanOrEqual(56);
	});
});

describe("buildSelectorTitle", () => {
	it("includes both active and total token counts when not all tools are active", () => {
		const title = buildSelectorTitle(12, 5, 1200, 3400);
		expect(title).toBe("Tools (12 total · 5 active · ~1.2k active tokens, 3.4k total)");
	});

	it("collapses to a single token figure when every tool is active", () => {
		const title = buildSelectorTitle(12, 12, 3400, 3400);
		expect(title).toBe("Tools (12 total · 12 active · ~3.4k tokens)");
		expect(title).not.toContain("active tokens,");
	});

	it("includes total tokens when nothing is active (regression for empty-active selection)", () => {
		const title = buildSelectorTitle(12, 0, 0, 3400);
		expect(title).toContain("~0 active tokens");
		expect(title).toContain("3.4k total");
	});

	it("renders small counts without the k suffix", () => {
		expect(buildSelectorTitle(3, 1, 150, 450)).toBe("Tools (3 total · 1 active · ~150 active tokens, 450 total)");
	});

	it("always shows total tokens (the whole point of #n/a)", () => {
		// Covers both branches — total must always appear somewhere in the title,
		// whether as "N total" parenthetical or as the sole token figure.
		const partial = buildSelectorTitle(10, 3, 500, 2000);
		const full = buildSelectorTitle(10, 10, 2000, 2000);
		expect(partial).toMatch(/2000|2\.0k/);
		expect(full).toMatch(/2000|2\.0k/);
	});
});
