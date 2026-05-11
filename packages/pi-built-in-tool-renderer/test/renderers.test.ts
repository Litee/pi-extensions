import { describe, expect, it } from "vitest";

import type { BashRenderState, RenderContext, ThemeLike, ToolResultLike } from "../src/renderers.js";
import {
	renderBash,
	renderEdit,
	renderFind,
	renderGrep,
	renderLs,
	renderRead,
	renderWrite,
} from "../src/renderers.js";

// ---------------------------------------------------------------------------
// Shared stubs. The renderers only read `.fg` / `.bold` off the theme and
// only the fields on `RenderContext` we list here off the context. We use
// plain objects so test failures point at missing fields directly.
// ---------------------------------------------------------------------------

/** Passes text through untouched so assertions can look at the raw string. */
const plainTheme: ThemeLike = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** Tags the output with its colour so assertions can lock colour routing. */
const taggedTheme: ThemeLike = {
	fg: (color, text) => `<${color}>${text}</>`,
	bold: (text) => `*${text}*`,
};

function ctx<S = unknown>(overrides: Partial<RenderContext<S>> = {}): RenderContext<S> {
	return {
		state: (overrides.state ?? {}) as S,
		expanded: false,
		isPartial: false,
		isError: false,
		executionStarted: false,
		invalidate: () => {},
		...overrides,
	};
}

function textResult(text: string, details?: unknown): ToolResultLike {
	return { content: [{ type: "text", text }], details };
}

// ---------------------------------------------------------------------------
// renderRead
// ---------------------------------------------------------------------------

describe("renderRead", () => {
	it("call includes the path", () => {
		const { call } = renderRead({ path: "/tmp/foo" }, undefined, plainTheme, ctx());
		expect(call).toContain("read ");
		expect(call).toContain("/tmp/foo");
	});

	it("call shows offset+limit hint when either is set", () => {
		const { call } = renderRead({ path: "x", offset: 10, limit: 5 }, undefined, plainTheme, ctx());
		expect(call).toContain("offset=10");
		expect(call).toContain("limit=5");
	});

	it("result reports line count and truncation warning", () => {
		const details = { truncation: { truncated: true, totalLines: 999 } };
		const { result } = renderRead(
			{ path: "x" },
			textResult("a\nb\nc", details),
			taggedTheme,
			ctx(),
		);
		expect(result).toContain("<success>3 lines</>");
		expect(result).toContain("<warning> (truncated from 999)</>");
	});

	it("result in expanded mode shows up to 15 lines and a 'more lines' suffix", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
		const { result } = renderRead(
			{ path: "x" },
			textResult(lines.join("\n")),
			plainTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("L0");
		expect(result).toContain("L14");
		expect(result).not.toContain("L15");
		expect(result).toContain("... 5 more lines");
	});

	it("result on partial is a 'Reading...' warning", () => {
		const { result } = renderRead({ path: "x" }, textResult(""), taggedTheme, ctx({ isPartial: true }));
		expect(result).toBe("<warning>Reading...</>");
	});

	it("result labels image content distinctly", () => {
		const { result } = renderRead(
			{ path: "x" },
			{ content: [{ type: "image", data: "...", mimeType: "image/png" }] },
			taggedTheme,
			ctx(),
		);
		expect(result).toBe("<success>Image loaded</>");
	});
});

// ---------------------------------------------------------------------------
// renderBash
// ---------------------------------------------------------------------------

describe("renderBash", () => {
	it("call crops long commands in collapsed mode", () => {
		const cmd = "x".repeat(200);
		const { call } = renderBash({ command: cmd }, undefined, plainTheme, ctx());
		expect(call).toContain(`${"x".repeat(77)}...`);
		expect(call).not.toContain("x".repeat(78));
	});

	it("call shows the full command in expanded mode", () => {
		const cmd = "x".repeat(200);
		const { call } = renderBash({ command: cmd }, undefined, plainTheme, ctx({ expanded: true }));
		expect(call).toContain(cmd);
		expect(call).not.toContain("...");
	});

	it("call appends the timeout hint when set", () => {
		const { call } = renderBash({ command: "ls", timeout: 30 }, undefined, taggedTheme, ctx());
		expect(call).toContain("<muted> (timeout: 30s)</>");
	});

	it("initialises startedAt from `now` on first exec tick", () => {
		const state: BashRenderState = {};
		renderBash(
			{ command: "ls" },
			undefined,
			plainTheme,
			ctx<BashRenderState>({ state, executionStarted: true }),
			/*now*/ 5000,
		);
		expect(state.startedAt).toBe(5000);
		expect(state.endedAt).toBeUndefined();
	});

	it("result shows 'Running · duration' while partial", () => {
		const state: BashRenderState = { startedAt: 1000 };
		const { result } = renderBash(
			{ command: "ls" },
			textResult(""),
			taggedTheme,
			ctx<BashRenderState>({ state, isPartial: true }),
			/*now*/ 3500,
		);
		expect(result).toBe("<muted>Running · 2.5s</>");
	});

	it("result on completion shows line count and duration in muted", () => {
		const state: BashRenderState = { startedAt: 1000 };
		const { result } = renderBash(
			{ command: "ls" },
			textResult("a\nb\nc"),
			taggedTheme,
			ctx<BashRenderState>({ state, isPartial: false }),
			/*now*/ 4000,
		);
		expect(result).toContain("<muted>3 lines</>");
		expect(result).toContain("<muted> · 3.0s</>");
		// Endpoint was frozen by tickBashTimer.
		expect(state.endedAt).toBe(4000);
	});

	it("result on error uses describeBashFailure and adds a truncation warning when details demand", () => {
		const state: BashRenderState = { startedAt: 0 };
		const { result } = renderBash(
			{ command: "false" },
			textResult(
				"boom\nCommand exited with code 137",
				{ truncation: { truncated: true } },
			),
			taggedTheme,
			ctx<BashRenderState>({ state, isError: true }),
			/*now*/ 500,
		);
		expect(result).toContain("<warning>exit 137</>");
		expect(result).toContain("<warning> [truncated]</>");
	});
});

// ---------------------------------------------------------------------------
// renderEdit
// ---------------------------------------------------------------------------

describe("renderEdit", () => {
	it("counts diff additions/removals while ignoring +++/--- headers", () => {
		const diff = [
			"--- a/file.ts",
			"+++ b/file.ts",
			"@@ -1 +1 @@",
			"-old",
			"-another old",
			"+new",
			" context",
		].join("\n");
		const { result } = renderEdit(
			{ path: "file.ts" },
			{ content: [], details: { diff } },
			taggedTheme,
			ctx(),
		);
		expect(result).toContain("<success>+1</>");
		expect(result).toContain("<error>-2</>");
	});

	it("shows 'Applied' when no diff is present", () => {
		const { result } = renderEdit(
			{ path: "file.ts" },
			{ content: [], details: {} },
			taggedTheme,
			ctx(),
		);
		expect(result).toBe("<success>Applied</>");
	});

	it("surfaces first error line from content", () => {
		const { result } = renderEdit(
			{ path: "file.ts" },
			textResult("Error: bad thing\ntraceback..."),
			taggedTheme,
			ctx(),
		);
		expect(result).toBe("<error>Error: bad thing</>");
	});

	it("expanded mode truncates diffs past 30 lines with a count suffix", () => {
		const diffLines = ["--- a", "+++ b", ...Array.from({ length: 40 }, (_, i) => `+line${i}`)];
		const diff = diffLines.join("\n");
		const { result } = renderEdit(
			{ path: "file.ts" },
			{ content: [], details: { diff } },
			plainTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("line0");
		// 30 diff lines shown, plus the +++/--- headers count toward the slice.
		expect(result).toContain(`... ${diffLines.length - 30} more diff lines`);
	});
});

// ---------------------------------------------------------------------------
// renderWrite
// ---------------------------------------------------------------------------

describe("renderWrite", () => {
	it("call shows a line count", () => {
		const { call } = renderWrite(
			{ path: "x", content: "a\nb\nc\n" },
			undefined,
			taggedTheme,
			ctx(),
		);
		expect(call).toContain("<dim> (4 lines)</>");
	});

	it("result is 'Written' on success and 'Error…' on failure", () => {
		const ok = renderWrite({ path: "x", content: "" }, textResult("ok"), taggedTheme, ctx()).result;
		const fail = renderWrite(
			{ path: "x", content: "" },
			textResult("Error: EACCES\n..."),
			taggedTheme,
			ctx(),
		).result;
		expect(ok).toBe("<success>Written</>");
		expect(fail).toBe("<error>Error: EACCES</>");
	});
});

// ---------------------------------------------------------------------------
// renderGrep / renderLs / renderFind share the same shape — smoke each.
// ---------------------------------------------------------------------------

describe("renderGrep", () => {
	it("renders match count and handles empty-sentinel as 0", () => {
		const hit = renderGrep(
			{ pattern: "foo" },
			textResult("a:1:foo\nb:2:foo"),
			taggedTheme,
			ctx(),
		).result;
		const miss = renderGrep(
			{ pattern: "foo" },
			textResult("No matches found"),
			taggedTheme,
			ctx(),
		).result;
		expect(hit).toContain("<success>2 matches</>");
		expect(miss).toContain("<muted>No matches</>");
	});

	it("appends limit/truncation warnings from details", () => {
		const { result } = renderGrep(
			{ pattern: "foo" },
			{
				content: [{ type: "text", text: "a:1:foo" }],
				details: {
					matchLimitReached: true,
					truncation: { truncated: true },
					linesTruncated: true,
				},
			},
			taggedTheme,
			ctx(),
		);
		expect(result).toContain("<warning> (limit reached)</>");
		expect(result).toContain("<warning> [truncated]</>");
		expect(result).toContain("<warning> [lines truncated]</>");
	});

	it("expanded mode shows the matching lines and a 'more lines' suffix", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `a:${i}:hit`);
		const { result } = renderGrep(
			{ pattern: "hit" },
			textResult(lines.join("\n")),
			plainTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("a:0:hit");
		expect(result).toContain("... 10 more lines");
	});
});

describe("renderLs", () => {
	it("renders entry count and pluralises correctly", () => {
		const one = renderLs({ path: "." }, textResult("a"), plainTheme, ctx()).result;
		const many = renderLs({ path: "." }, textResult("a\nb\nc"), plainTheme, ctx()).result;
		expect(one).toContain("1 entry");
		expect(many).toContain("3 entries");
	});

	it("honours the truncation warning from details", () => {
		const { result } = renderLs(
			{ path: "." },
			{
				content: [{ type: "text", text: "a\nb" }],
				details: { entryLimitReached: true, truncation: { truncated: true } },
			},
			taggedTheme,
			ctx(),
		);
		expect(result).toContain("<warning> (limit reached)</>");
		expect(result).toContain("<warning> [truncated]</>");
	});
});

describe("renderFind", () => {
	it("renders file count and handles empty-sentinel", () => {
		const hit = renderFind(
			{ pattern: "*.ts" },
			textResult("a.ts\nb.ts"),
			plainTheme,
			ctx(),
		).result;
		const miss = renderFind(
			{ pattern: "*.ts" },
			textResult("No files found matching pattern"),
			plainTheme,
			ctx(),
		).result;
		expect(hit).toContain("2 files");
		expect(miss).toContain("No files");
	});

	it("expanded mode shows files plus a 'more files' suffix past 30", () => {
		const lines = Array.from({ length: 35 }, (_, i) => `f${i}.ts`);
		const { result } = renderFind(
			{ pattern: "*" },
			textResult(lines.join("\n")),
			plainTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("f0.ts");
		expect(result).toContain("... 5 more files");
	});

	it("honours details.truncation.truncated warning", () => {
		const { result } = renderFind(
			{ pattern: "*" },
			{
				content: [{ type: "text", text: "a.ts" }],
				details: { truncation: { truncated: true } },
			},
			taggedTheme,
			ctx(),
		);
		expect(result).toContain("<warning> [truncated]</>");
	});
});
