import { describe, expect, it } from "vitest";

import type { BashRenderState, RenderContext, ToolResultLike } from "../src/renderers.js";
import { renderBash, renderFind, renderGrep, renderLs, renderRead } from "../src/renderers.js";

// ---------------------------------------------------------------------------
// Additional branch coverage for `renderers.ts`.
//
// These tests target specific branches that the main `renderers.test.ts`
// suite leaves uncovered: the early "still initialising" returns, the empty-
// output fallbacks on non-text content, and the false arms of the various
// `> N` / `=== 0` threshold guards in the expanded renderers.
// ---------------------------------------------------------------------------

const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const taggedTheme = { fg: (c: string, t: string) => `<${c}>${t}</>`, bold: (t: string) => `*${t}*` };

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

const imageResult: ToolResultLike = { content: [{ type: "image", data: "...", mimeType: "image/png" }] };

describe("renderBash — timer state-machine edge branches", () => {
	it("partial without a startedAt shows plain 'Running' (no duration yet)", () => {
		// executionStarted false so renderBash does NOT initialise startedAt;
		// tickBashTimer then hits the `if (state.startedAt === undefined)` arm.
		const state: BashRenderState = {};
		const { result } = renderBash(
			{ command: "sleep 1" },
			textResult(""),
			plainTheme,
			ctx<BashRenderState>({ state, isPartial: true, executionStarted: false }),
			1000,
		);
		expect(result).toBe("Running");
	});

	it("completion with no startedAt shows line count but no duration suffix", () => {
		// startedAt undefined on completion => duration is undefined, so the
		// `if (duration)` arm is skipped and no `· <duration>` is appended.
		const state: BashRenderState = {};
		const { result } = renderBash(
			{ command: "ls" },
			textResult("a\nb"),
			plainTheme,
			ctx<BashRenderState>({ state, isPartial: false, executionStarted: false }),
			5000,
		);
		expect(result).toContain("2 lines");
		expect(result).not.toContain("· ");
	});

	it("result with non-text content yields empty output (0 lines)", () => {
		// Exercises the `? content.text : ""` fallback in the output extraction
		// when content[0] is not a text block.
		const state: BashRenderState = { startedAt: 0 };
		const { result } = renderBash(
			{ command: "x" },
			imageResult,
			plainTheme,
			ctx<BashRenderState>({ state, isPartial: false }),
			500,
		);
		expect(result).toContain("0 lines");
	});
});

describe("renderRead — expanded threshold false arm", () => {
	it("expanded with <= 15 lines shows them and no 'more lines' suffix", () => {
		const lines = Array.from({ length: 5 }, (_, i) => `L${i}`).join("\n");
		const { result } = renderRead(
			{ path: "x" },
			textResult(lines),
			plainTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("L0");
		expect(result).toContain("L4");
		expect(result).not.toContain("more lines");
	});
});

describe("renderGrep — non-text content + expanded threshold", () => {
	it("non-text content falls back to 'No matches'", () => {
		const { result } = renderGrep({ pattern: "foo" }, imageResult, plainTheme, ctx());
		expect(result).toContain("No matches");
	});

	it("expanded with <= 30 matches shows all and no 'more lines' suffix", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `a:${i}:hit`).join("\n");
		const { result } = renderGrep(
			{ pattern: "hit" },
			textResult(lines),
			plainTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("a:9:hit");
		expect(result).not.toContain("more lines");
	});
});

describe("renderLs — default path, non-text content, empty output", () => {
	it("uses '.' as the default path in the call when path is omitted", () => {
		const { call } = renderLs({}, undefined, plainTheme, ctx());
		expect(call).toContain(".");
	});

	it("non-text content yields empty output", () => {
		const { result } = renderLs({ path: "." }, imageResult, plainTheme, ctx());
		expect(result).toContain("(empty)");
	});

	it("empty output reports '(empty)'", () => {
		const { result } = renderLs({ path: "." }, textResult(""), plainTheme, ctx());
		expect(result).toBe("(empty)");
	});
});

describe("renderFind — non-text content, limit warning, expanded threshold", () => {
	it("non-text content yields no files", () => {
		const { result } = renderFind({ pattern: "*" }, imageResult, plainTheme, ctx());
		expect(result).toContain("No files");
	});

	it("honours the resultLimitReached warning from details", () => {
		const { result } = renderFind(
			{ pattern: "*" },
			{ content: [{ type: "text", text: "a.ts" }], details: { resultLimitReached: true } },
			taggedTheme,
			ctx(),
		);
		expect(result).toContain("<warning> (limit reached)</>");
	});

	it("expanded with <= 30 files shows all and no 'more files' suffix", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `f${i}.ts`).join("\n");
		const { result } = renderFind(
			{ pattern: "*" },
			textResult(lines),
			plainTheme,
			ctx({ expanded: true }),
		);
		expect(result).toContain("f9.ts");
		expect(result).not.toContain("more files");
	});
});
