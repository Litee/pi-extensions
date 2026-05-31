import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { BashRenderState, RenderContext, ThemeLike, ToolResultLike } from "../src/renderers.js";
import {
	renderBash,
	renderBashCallLines,
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
	it("call returns the full styled command (no pre-clipping)", () => {
		const cmd = "x".repeat(200);
		const { call } = renderBash({ command: cmd }, undefined, plainTheme, ctx());
		expect(call).toContain(cmd);
		expect(call).not.toContain("...");
	});

	it("call no longer carries the timeout hint", () => {
		const { call } = renderBash({ command: "ls", timeout: 30 }, undefined, taggedTheme, ctx());
		expect(call).not.toContain("timeout");
	});

	it("result surfaces the timeout next to the duration", () => {
		const state: BashRenderState = { startedAt: 1000 };
		const { result } = renderBash(
			{ command: "ls", timeout: 30 },
			textResult("a"),
			taggedTheme,
			ctx<BashRenderState>({ state, isPartial: false }),
			/*now*/ 2000,
		);
		expect(result).toContain("<muted> · 1.0s</>");
		expect(result).toContain("<muted> · timeout 30s</>");
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

	it("result shows the timeout next to the running label while partial", () => {
		const state: BashRenderState = { startedAt: 1000 };
		const { result } = renderBash(
			{ command: "sleep 30", timeout: 30 },
			textResult(""),
			taggedTheme,
			ctx<BashRenderState>({ state, isPartial: true }),
			/*now*/ 3500,
		);
		expect(result).toContain("<muted>Running · 2.5s</>");
		expect(result).toContain("<muted> · timeout 30s</>");
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
// renderBashCallLines (width-aware: collapsed=clip, expanded=wrap)
// ---------------------------------------------------------------------------

describe("renderBashCallLines", () => {
	it("collapsed: clips a long command to pane width with no ellipsis", () => {
		const cmd = "x".repeat(200);
		const lines = renderBashCallLines(cmd, plainTheme, /*expanded*/ false, /*width*/ 40);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("...");
		// `truncateToWidth` always appends a SGR reset — measure visible width.
		expect(visibleWidth(lines[0]!)).toBe(40);
	});

	it("collapsed: leaves a short command intact when the pane is wide", () => {
		const lines = renderBashCallLines("ls -la", plainTheme, false, 200);
		expect(lines).toEqual(["$ ls -la"]);
	});

	it("collapsed: keeps only the first physical line of a multi-line command", () => {
		const cmd = "first line\nsecond line\nthird line";
		const lines = renderBashCallLines(cmd, plainTheme, false, 200);
		expect(lines).toEqual(["$ first line"]);
	});

	it("expanded: wraps the full command across multiple lines", () => {
		const cmd = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
		const lines = renderBashCallLines(cmd, plainTheme, /*expanded*/ true, /*width*/ 20);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		const joined = lines.join(" ");
		for (const word of cmd.split(" ")) expect(joined).toContain(word);
	});

	it("expanded: preserves embedded newlines from heredocs", () => {
		const cmd = "cat <<EOF\nhello\nEOF";
		const lines = renderBashCallLines(cmd, plainTheme, true, 80);
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(lines.some((l) => l.includes("hello"))).toBe(true);
	});

	it("width=0 is handled defensively", () => {
		expect(renderBashCallLines("ls", plainTheme, false, 0)).toEqual([""]);
	});

	it("undefined command (streamed args, command not yet present) does not throw", () => {
		// Regression: pi calls renderCall while tool args are still streaming, so
		// `bashArgs.command` can be undefined for a few frames before the JSON
		// field arrives.
		expect(() => renderBashCallLines(undefined, plainTheme, false, 80)).not.toThrow();
		expect(() => renderBashCallLines(undefined, plainTheme, true, 80)).not.toThrow();
		const lines = renderBashCallLines(undefined, plainTheme, false, 80);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(80);
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

// ---------------------------------------------------------------------------
// Additional branch coverage for uncovered paths
// ---------------------------------------------------------------------------

describe("renderBash — expanded output mode", () => {
	it("expanded mode shows output lines", () => {
		const state: BashRenderState = { startedAt: 0 };
		const output = Array.from({ length: 15 }, (_, i) => `line${i}`).join("\n");
		const { result } = renderBash(
			{ command: "ls" },
			textResult(output),
			plainTheme,
			ctx<BashRenderState>({ state, expanded: true }),
			500,
		);
		expect(result).toContain("line0");
		expect(result).toContain("line14");
	});

	it("expanded mode shows '... more output' when > 20 lines", () => {
		const state: BashRenderState = { startedAt: 0 };
		const output = Array.from({ length: 25 }, (_, i) => `line${i}`).join("\n");
		const { result } = renderBash(
			{ command: "ls" },
			textResult(output),
			plainTheme,
			ctx<BashRenderState>({ state, expanded: true }),
			500,
		);
		expect(result).toContain("... more output");
	});

	it("non-error result with 0 output lines shows '0 lines'", () => {
		const state: BashRenderState = { startedAt: 0 };
		const { result } = renderBash(
			{ command: "true" },
			textResult(""),
			plainTheme,
			ctx<BashRenderState>({ state }),
			500,
		);
		expect(result).toContain("0 lines");
	});
});

describe("renderEdit — context lines in diff", () => {
	it("expanded diff shows context lines (non-+/-) in dim style", () => {
		const diffLines = ["--- a", "+++ b", "+new line", "-old line", " context line"];
		const { result } = renderEdit(
			{ path: "file.ts" },
			{ content: [], details: { diff: diffLines.join("\n") } },
			taggedTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("context line");
	});
});

describe("renderGrep — singular match", () => {
	it("uses singular 'match' when exactly 1 result", () => {
		const { result } = renderGrep(
			{ pattern: "foo" },
			textResult("a:1:foo"),
			plainTheme,
			ctx(),
		);
		expect(result).toContain("1 match");
		expect(result).not.toContain("1 matches");
	});
});

describe("renderLs — expanded mode with directory entries", () => {
	it("expanded mode styles directory entries (ending in /) differently from files", () => {
		const entries = ["src/\nREADME.md"];
		const { result } = renderLs(
			{ path: "." },
			textResult(entries.join("\n")),
			taggedTheme,
			ctx({ expanded: true }),
		);
		// Directory gets accent styling
		expect(result).toBeDefined();
	});

	it("expanded mode shows '... more entries' when > 30 entries", () => {
		const entries = Array.from({ length: 35 }, (_, i) => `file${i}.ts`).join("\n");
		const { result } = renderLs(
			{ path: "." },
			textResult(entries),
			plainTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("... 5 more entries");
	});
});

describe("renderFind — single file result", () => {
	it("uses singular 'file' when exactly 1 result", () => {
		const { result } = renderFind(
			{ pattern: "*.ts" },
			textResult("a.ts"),
			plainTheme,
			ctx(),
		);
		expect(result).toContain("1 file");
		expect(result).not.toContain("1 files");
	});
});

// ---------------------------------------------------------------------------
// Additional renderers coverage - call line branches
// ---------------------------------------------------------------------------

describe("renderGrep — call line branches", () => {
  it("includes path in call when provided", () => {
    const { call } = renderGrep({ pattern: "foo", path: "/src" }, undefined, plainTheme, ctx());
    expect(call).toContain("/src");
  });

  it("includes glob in call when provided", () => {
    const { call } = renderGrep({ pattern: "foo", glob: "*.ts" }, undefined, taggedTheme, ctx());
    expect(call).toContain("*.ts");
  });

  it("includes ignore-case flag in call", () => {
    const { call } = renderGrep({ pattern: "foo", ignoreCase: true }, undefined, taggedTheme, ctx());
    expect(call).toContain("(i)");
  });

  it("returns empty result string when result is undefined", () => {
    const { result } = renderGrep({ pattern: "foo" }, undefined, plainTheme, ctx());
    expect(result).toBe("");
  });

  it("renders grep partial (Searching...)", () => {
    const { result } = renderGrep({ pattern: "foo" }, textResult(""), taggedTheme, ctx({ isPartial: true }));
    expect(result).toContain("Searching");
  });
});

describe("renderRead — partial and undefined result", () => {
  it("returns empty result string when result is undefined", () => {
    const { result } = renderRead({ path: "/tmp/foo" }, undefined, plainTheme, ctx());
    expect(result).toBe("");
  });
});

describe("renderEdit — partial and undefined result", () => {
  it("returns partial Editing... message", () => {
    const { result } = renderEdit({ path: "x" }, textResult("ok"), taggedTheme, ctx({ isPartial: true }));
    expect(result).toContain("Editing");
  });

  it("returns empty result when result is undefined", () => {
    const { result } = renderEdit({ path: "x" }, undefined, plainTheme, ctx());
    expect(result).toBe("");
  });

  it("renders 'Applied' when no diff in details", () => {
    const { result } = renderEdit({ path: "x" }, { content: [], details: {} }, taggedTheme, ctx());
    expect(result).toContain("Applied");
  });
});

describe("renderWrite — partial, undefined, and error", () => {
  it("returns empty result when result is undefined", () => {
    const { result } = renderWrite({ path: "x", content: "hello" }, undefined, plainTheme, ctx());
    expect(result).toBe("");
  });

  it("renders partial Writing... message", () => {
    const { result } = renderWrite({ path: "x", content: "" }, textResult("ok"), taggedTheme, ctx({ isPartial: true }));
    expect(result).toContain("Writing");
  });
});

describe("renderLs — partial and undefined result", () => {
  it("returns empty result when result is undefined", () => {
    const { result } = renderLs({ path: "." }, undefined, plainTheme, ctx());
    expect(result).toBe("");
  });
  it("renders partial Listing... message", () => {
    const { result } = renderLs({ path: "." }, textResult(""), taggedTheme, ctx({ isPartial: true }));
    expect(result).toContain("Listing");
  });
});

describe("renderFind — partial and undefined result", () => {
  it("returns empty result when result is undefined", () => {
    const { result } = renderFind({ pattern: "*.ts" }, undefined, plainTheme, ctx());
    expect(result).toBe("");
  });

  it("renders partial Searching... message", () => {
    const { result } = renderFind({ pattern: "*" }, textResult(""), taggedTheme, ctx({ isPartial: true }));
    expect(result).toContain("Searching");
  });
});

describe("renderBash — partial and undefined result", () => {
  it("returns empty result when result is undefined", () => {
    const { result } = renderBash({ command: "echo hi" }, undefined, plainTheme, ctx());
    expect(result).toBe("");
  });
});

// Additional renderRead coverage
describe("renderRead — additional branches", () => {
  it("call shows limit-only hint when limit is set but offset is not", () => {
    const { call } = renderRead({ path: "x", limit: 5 }, undefined, plainTheme, ctx());
    expect(call).toContain("limit=5");
    expect(call).not.toContain("offset=");
  });

  it("call shows offset-only hint when offset is set but limit is not", () => {
    const { call } = renderRead({ path: "x", offset: 10 }, undefined, plainTheme, ctx());
    expect(call).toContain("offset=10");
    expect(call).not.toContain("limit=");
  });

  it("result returns 'No content' when content type is neither text nor image", () => {
    const { result } = renderRead(
      { path: "x" },
      { content: [{ type: "toolCall", name: "x" }] },
      taggedTheme,
      ctx(),
    );
    expect(result).toContain("No content");
  });
});

// renderBash - error with zero output lines
describe("renderBash — error with zero lines", () => {
  it("error result with empty output shows no line count suffix", () => {
    const state: BashRenderState = { startedAt: 0 };
    const { result } = renderBash(
      { command: "false" },
      textResult(""),
      taggedTheme,
      ctx<BashRenderState>({ state, isError: true }),
      500,
    );
    // describeBashFailure is shown but no "· N lines" suffix for 0 lines
    expect(result).not.toContain("· 0 lines");
  });
});
