import { describe, expect, it } from "vitest";
import { buildUntrackedDiff, parseUnifiedDiff } from "../src/diff.js";

// ---------------------------------------------------------------------------
// parseUnifiedDiff
// ---------------------------------------------------------------------------

describe("parseUnifiedDiff — empty / trivial input", () => {
	it("returns [] for empty string", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
	});

	it("returns [] for whitespace-only string", () => {
		expect(parseUnifiedDiff("   \n  \n")).toEqual([]);
	});
});

describe("parseUnifiedDiff — metadata headers are skipped", () => {
	const HEADERS = [
		"diff --git a/foo.ts b/foo.ts",
		"index abc123..def456 100644",
		"--- a/foo.ts",
		"+++ b/foo.ts",
		"Binary files a/x.png and b/x.png differ",
		"new file mode 100644",
		"deleted file mode 100644",
		"old mode 100644",
		"new mode 100755",
		"rename from old-name.ts",
		"rename to new-name.ts",
		"similarity index 90%",
		"copy from src.ts",
		"copy to dst.ts",
	];

	for (const header of HEADERS) {
		it(`skips line starting with "${header.slice(0, 20)}..."`, () => {
			const raw = `${header}\n@@ -1,1 +1,1 @@\n context\n`;
			const result = parseUnifiedDiff(raw);
			// Only the hunk header + context line; no metadata line
			expect(result.some((l) => l.header?.startsWith(header.slice(0, 4)))).toBe(false);
			expect(result.some((l) => l.type === "hunk")).toBe(true);
		});
	}
});

describe("parseUnifiedDiff — hunk header", () => {
	it("parses @@ -1,3 +1,4 @@ optional context", () => {
		const raw = "@@ -10,3 +10,4 @@ function foo() {\n context\n";
		const result = parseUnifiedDiff(raw);
		expect(result[0]).toMatchObject({
			type: "hunk",
			left: null,
			right: null,
			leftNum: null,
			rightNum: null,
			header: "@@ -10,3 +10,4 @@ function foo() {",
		});
	});

	it("initialises line counters from hunk header", () => {
		const raw = "@@ -5,2 +10,2 @@\n context\n";
		const result = parseUnifiedDiff(raw);
		const ctx = result.find((l) => l.type === "context");
		expect(ctx?.leftNum).toBe(5);
		expect(ctx?.rightNum).toBe(10);
	});
});

describe("parseUnifiedDiff — added, removed, context lines", () => {
	const SIMPLE = `@@ -1,3 +1,4 @@\n context line\n-removed line\n+added line\n another context\n`;

	it("added line has left=null, right=content", () => {
		const result = parseUnifiedDiff(SIMPLE);
		const added = result.find((l) => l.type === "added");
		expect(added?.left).toBeNull();
		expect(added?.right).toBe("added line");
	});

	it("removed line has left=content, right=null", () => {
		const result = parseUnifiedDiff(SIMPLE);
		const removed = result.find((l) => l.type === "removed");
		expect(removed?.left).toBe("removed line");
		expect(removed?.right).toBeNull();
	});

	it("context line has same left and right", () => {
		const result = parseUnifiedDiff(SIMPLE);
		const ctx = result.filter((l) => l.type === "context");
		// SIMPLE ends with \n which parses as an extra empty-string context line
		expect(ctx.length).toBeGreaterThanOrEqual(2);
		expect(ctx[0]!.left).toBe("context line");
		expect(ctx[0]!.right).toBe("context line");
	});

	it("increments left line numbers for removed+context, right for added+context", () => {
		const result = parseUnifiedDiff(SIMPLE);
		// hunk: left starts at 1, right starts at 1
		const lines = result.filter((l) => l.type !== "hunk");
		// context(left=1,right=1), removed(left=2,right=null), added(left=null,right=2), context(left=3,right=3)
		expect(lines[0]).toMatchObject({ type: "context", leftNum: 1, rightNum: 1 });
		expect(lines[1]).toMatchObject({ type: "removed", leftNum: 2, rightNum: null });
		expect(lines[2]).toMatchObject({ type: "added", leftNum: null, rightNum: 2 });
		expect(lines[3]).toMatchObject({ type: "context", leftNum: 3, rightNum: 3 });
	});

	it("bare empty line (no space prefix) treated as context with empty text", () => {
		const raw = "@@ -1,1 +1,1 @@\n\n";
		const result = parseUnifiedDiff(raw);
		const ctx = result.find((l) => l.type === "context");
		expect(ctx).toBeDefined();
		expect(ctx?.left).toBe("");
		expect(ctx?.right).toBe("");
	});
});

describe("parseUnifiedDiff — multiple hunks", () => {
	const MULTI = [
		"@@ -1,2 +1,2 @@",
		" first context",
		"-old line",
		"+new line",
		"@@ -10,2 +10,2 @@",
		" second context",
		"-another old",
		"+another new",
	].join("\n");

	it("produces two hunk entries", () => {
		const result = parseUnifiedDiff(MULTI);
		const hunks = result.filter((l) => l.type === "hunk");
		expect(hunks.length).toBe(2);
	});

	it("second hunk resets line counters from its header", () => {
		const result = parseUnifiedDiff(MULTI);
		const secondHunkIdx = result.findIndex((l) => l.type === "hunk" && l.header?.includes("-10,"));
		const ctx2 = result[secondHunkIdx + 1];
		expect(ctx2?.leftNum).toBe(10);
		expect(ctx2?.rightNum).toBe(10);
	});
});

describe("parseUnifiedDiff — full realistic diff", () => {
	it("handles a realistic git diff output correctly", () => {
		const raw = [
			"diff --git a/src/foo.ts b/src/foo.ts",
			"index abc1234..def5678 100644",
			"--- a/src/foo.ts",
			"+++ b/src/foo.ts",
			"@@ -1,4 +1,5 @@",
			" import { foo } from './bar.js';",
			" ",
			"-const x = 1;",
			"+const x = 42;",
			"+const y = 0;",
			" export { x };",
		].join("\n");

		const result = parseUnifiedDiff(raw);
		expect(result.filter((l) => l.type === "hunk").length).toBe(1);
		expect(result.filter((l) => l.type === "removed").length).toBe(1);
		expect(result.filter((l) => l.type === "added").length).toBe(2);
		expect(result.filter((l) => l.type === "context").length).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// buildUntrackedDiff
// ---------------------------------------------------------------------------

describe("buildUntrackedDiff", () => {
	it("returns one 'added' entry per line with rightNum starting at 1", () => {
		const result = buildUntrackedDiff("line one\nline two\nline three");
		expect(result).toHaveLength(3);
		expect(result[0]).toMatchObject({ type: "added", left: null, right: "line one", leftNum: null, rightNum: 1 });
		expect(result[1]).toMatchObject({ type: "added", right: "line two", rightNum: 2 });
		expect(result[2]).toMatchObject({ type: "added", right: "line three", rightNum: 3 });
	});

	it("drops the trailing empty line that split() produces", () => {
		const result = buildUntrackedDiff("a\nb\n");
		expect(result).toHaveLength(2);
	});

	it("handles single-line content", () => {
		const result = buildUntrackedDiff("only one");
		expect(result).toHaveLength(1);
		expect(result[0]!.right).toBe("only one");
		expect(result[0]!.rightNum).toBe(1);
	});

	it("handles empty string → empty array", () => {
		// split("") → [""] → pop last empty → []
		const result = buildUntrackedDiff("");
		expect(result).toHaveLength(0);
	});
});
