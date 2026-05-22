import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createRuntimeServices } from "../src/runtime/session-state.js";
import { DEFAULT_POLICY, type CompactionPolicy } from "../src/policy/types.js";

interface FgCall {
	color: string;
	text: string;
}

interface StatusCall {
	key: string;
	text: string | undefined;
}

function makePolicy(overrides: Partial<CompactionPolicy> = {}): CompactionPolicy {
	return {
		...DEFAULT_POLICY,
		enabled: true,
		ui: { ...DEFAULT_POLICY.ui, showStatus: true, minimalStatus: true },
		trigger: { ...DEFAULT_POLICY.trigger, maxTokens: 0 },
		...overrides,
	};
}

interface FakeCtx {
	statusCalls: StatusCall[];
	fgCalls: FgCall[];
}

function makeCtx(tokens: number, contextWindow: number): {
	ctx: unknown;
	collected: FakeCtx;
} {
	const collected: FakeCtx = { statusCalls: [], fgCalls: [] };
	const ctx = {
		cwd: "/tmp",
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				collected.statusCalls.push({ key, text });
			},
			theme: {
				fg: (color: string, text: string) => {
					collected.fgCalls.push({ color, text });
					return `<${color}>${text}</${color}>`;
				},
			},
		},
		getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
	};
	return { ctx, collected };
}

describe("updateStatus tinting", () => {
	it("colours the entire status line with `muted` when below 80% of the limit", () => {
		const { ctx, collected } = makeCtx(500, 1000);
		const runtime = createRuntimeServices();

		runtime.updateStatus(ctx as never, makePolicy());

		// Single fg call wraps the whole `name: pct` line — prefix included.
		assert.equal(collected.fgCalls.length, 1);
		assert.equal(collected.fgCalls[0]?.color, "muted");
		assert.equal(collected.fgCalls[0]?.text, "compact: 50%");
		assert.equal(collected.statusCalls.length, 1);
		assert.equal(collected.statusCalls[0]?.text, "<muted>compact: 50%</muted>");
	});

	it("colours the entire status line with `warning` at exactly 80%", () => {
		const { ctx, collected } = makeCtx(800, 1000);
		const runtime = createRuntimeServices();

		runtime.updateStatus(ctx as never, makePolicy());

		assert.equal(collected.fgCalls[0]?.color, "warning");
		assert.equal(collected.fgCalls[0]?.text, "compact: 80%");
		assert.equal(collected.statusCalls[0]?.text, "<warning>compact: 80%</warning>");
	});

	it("colours the entire status line with `warning` above 80%", () => {
		const { ctx, collected } = makeCtx(950, 1000);
		const runtime = createRuntimeServices();

		runtime.updateStatus(ctx as never, makePolicy());

		assert.equal(collected.fgCalls[0]?.color, "warning");
		assert.equal(collected.fgCalls[0]?.text, "compact: 95%");
	});

	it("uses `:` (not `·`) as the section separator throughout the line", () => {
		const { ctx, collected } = makeCtx(100, 1000);
		const runtime = createRuntimeServices();

		runtime.updateStatus(
			ctx as never,
			makePolicy({
				ui: { ...DEFAULT_POLICY.ui, showStatus: true, minimalStatus: false, name: "ctx" },
				summaryRetention: { mode: "tokens", value: 40_000 },
			}),
		);

		const text = collected.statusCalls[0]?.text ?? "";
		assert.ok(!text.includes("·"), `dot separator must not appear, got: ${text}`);
		// Verbose format keeps the (tokens/limit) parens; sections are `:`-separated.
		assert.match(text, /^<muted>ctx: keep 40000t: 10\.0% \(100\/1000\)<\/muted>$/);
	});

	it("falls back to plain text when no theme is available", () => {
		const collected: { statusCalls: StatusCall[] } = { statusCalls: [] };
		const ctx = {
			cwd: "/tmp",
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					collected.statusCalls.push({ key, text });
				},
				// No `theme`.
			},
			getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		};
		const runtime = createRuntimeServices();

		runtime.updateStatus(ctx as never, makePolicy());

		assert.equal(collected.statusCalls[0]?.text, "compact: 10%");
	});
});
