import { describe, expect, it } from "vitest";

import { compressPath, formatTokens, renderBar, renderRow, renderSimpleRow } from "../src/render.js";

// ────────────────────────────────────────────────────────────────────────────
// renderBar
// ────────────────────────────────────────────────────────────────────────────

describe("renderBar", () => {
	it("returns all empty blocks when value is 0", () => {
		const result = renderBar(0, 0, 20);
		expect(result).toBe("░".repeat(20));
		expect(result).toHaveLength(20);
	});

	it("returns all full blocks when value equals max", () => {
		const result = renderBar(100, 100, 20);
		expect(result).toBe("█".repeat(20));
		expect(result).toHaveLength(20);
	});

	it("returns 10 full + 10 empty for 50% fill", () => {
		const result = renderBar(50, 100, 20);
		expect(result).toBe("█".repeat(10) + "░".repeat(10));
		expect(result).toHaveLength(20);
	});

	it("returns at least 1 full block when value > 0", () => {
		const result = renderBar(1, 100, 20);
		expect(result[0]).toBe("█");
		expect(result).toHaveLength(20);
	});

	it("always produces exactly `width` characters", () => {
		for (const width of [1, 5, 10, 20, 40]) {
			expect(renderBar(33, 100, width)).toHaveLength(width);
		}
	});

	it("returns empty string for width 0", () => {
		expect(renderBar(50, 100, 0)).toBe("");
	});

	it("returns all empty blocks when max is 0", () => {
		const result = renderBar(50, 0, 20);
		expect(result).toBe("░".repeat(20));
	});
});

// ────────────────────────────────────────────────────────────────────────────
// formatTokens
// ────────────────────────────────────────────────────────────────────────────

describe("formatTokens", () => {
	it("returns '0' for 0", () => {
		expect(formatTokens(0)).toBe("0");
	});

	it("returns '999' for 999", () => {
		expect(formatTokens(999)).toBe("999");
	});

	it("returns '1.0k' for 1000", () => {
		expect(formatTokens(1000)).toBe("1.0k");
	});

	it("returns '12.3k' for 12345", () => {
		expect(formatTokens(12345)).toBe("12.3k");
	});

	it("formats small numbers verbatim (no 'k' suffix)", () => {
		expect(formatTokens(42)).toBe("42");
	});

	it("formats thousands below 100k with one decimal", () => {
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(9949)).toBe("9.9k");
		expect(formatTokens(10000)).toBe("10.0k");
	});

	it("formats 100k and above with no decimals", () => {
		expect(formatTokens(100000)).toBe("100k");
		expect(formatTokens(200000)).toBe("200k");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// renderRow
// ────────────────────────────────────────────────────────────────────────────

describe("renderRow", () => {
	it("output contains the label", () => {
		const row = renderRow("my label", 500, 1000, 20, 21);
		expect(row).toContain("my label");
	});

	it("output contains bar characters (full and/or empty blocks)", () => {
		const row = renderRow("label", 500, 1000, 20, 21);
		expect(row).toMatch(/[█░]/);
	});

	it("output contains a percent string", () => {
		const row = renderRow("label", 50, 100, 20, 21);
		expect(row).toContain("50%");
	});

	it("output contains a token count with ~ prefix", () => {
		const row = renderRow("label", 4000, 10000, 20, 21);
		expect(row).toContain("~");
		expect(row).toContain("4.0k");
	});

	it("renders 0% and all empty bar when tokens is 0", () => {
		const row = renderRow("empty", 0, 1000, 20, 21);
		expect(row).toContain("0%");
		expect(row).toContain("░".repeat(20));
	});

	it("renders 100% and all full bar when tokens equals parent", () => {
		const row = renderRow("full", 1000, 1000, 20, 21);
		expect(row).toContain("100%");
		expect(row).toContain("█".repeat(20));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// renderSimpleRow
// ─────────────────────────────────────────────────────────────────────────────

describe("renderSimpleRow", () => {
	it("output contains the label", () => {
		const row = renderSimpleRow("my label", 4000, 34);
		expect(row).toContain("my label");
	});

	it("output contains the token count with ~ prefix", () => {
		const row = renderSimpleRow("label", 4000, 34);
		expect(row).toContain("~4.0k");
	});

	it("has no bar characters", () => {
		const row = renderSimpleRow("label", 500, 34);
		expect(row).not.toMatch(/[█░]/);
	});

	it("has no percentage", () => {
		const row = renderSimpleRow("label", 500, 34);
		expect(row).not.toMatch(/\d+%/);
	});

	it("truncates a label longer than labelWidth from the left", () => {
		const longLabel = "/very/long/path/to/some/agents/file.md";
		const row = renderSimpleRow(longLabel, 100, 20);
		expect(row).toContain("…");
		expect(row.split("  ~")[0]).toHaveLength(20);
	});

	it("does not truncate a label that fits within labelWidth", () => {
		const row = renderSimpleRow("short", 100, 20);
		expect(row).not.toContain("…");
		expect(row).toContain("short");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// compressPath
// ─────────────────────────────────────────────────────────────────────────────

describe("compressPath", () => {
	it("returns the path unchanged when it already fits", () => {
		expect(compressPath("/short/path.md", 40)).toBe("/short/path.md");
	});

	it("replaces the home directory with ~", () => {
		// Arrange — path is longer than maxLen but fits after ~ substitution
		const home = "/Users/alice";
		const path = `${home}/.pi/agent/subdir/AGENTS.md`; // 38 chars, maxLen=30

		// Act
		const result = compressPath(path, 30, home);

		// Assert
		expect(result).toBe("~/.pi/agent/subdir/AGENTS.md");
		expect(result.length).toBeLessThanOrEqual(30);
	});

	it("returns ~ path unchanged when it fits after substitution", () => {
		const home = "/Users/alice";
		const path = `${home}/.pi/agent/subdir/AGENTS.md`; // too long at 30, fits as ~
		const result = compressPath(path, 30, home);
		expect(result.startsWith("~")).toBe(true);
		expect(result).not.toContain("…");
	});

	it("falls back to last-two-segments when home substitution is still too long", () => {
		// Arrange — a path that remains too long even after ~ substitution
		const path = "/Users/alice/very/deep/nested/directory/structure/file.md";

		// Act
		const result = compressPath(path, 30, "/Users/alice");

		// Assert
		expect(result).toContain("…");
		expect(result).toContain("structure/file.md");
		expect(result.length).toBeLessThanOrEqual(30);
	});

	it("falls back to last-one-segment when two segments are still too long", () => {
		// Arrange — a path with very long segment names
		const path = "/Users/alice/averylongparentdirectoryname/averylongfilename.md";

		// Act
		const result = compressPath(path, 25, "/Users/alice");

		// Assert
		expect(result).toContain("…");
		expect(result).toContain("averylongfilename.md");
		expect(result.length).toBeLessThanOrEqual(25);
	});

	it("hard left-truncates as a last resort when even the filename is too long", () => {
		// Arrange — filename itself exceeds maxLen
		const path = "/a/verylongfilenamethatiswaytoobigtofit.md";

		// Act
		const result = compressPath(path, 10);

		// Assert — last resort: left-truncated
		expect(result).toHaveLength(10);
		expect(result.startsWith("…")).toBe(true);
	});

	it("works without a homeDir argument", () => {
		const path = "/some/path/to/file.md";
		const result = compressPath(path, 15);
		expect(result.length).toBeLessThanOrEqual(15);
	});

	it("does not modify a path that already fits without homeDir", () => {
		expect(compressPath("/short.md", 20)).toBe("/short.md");
	});
});
