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
	it("colours the usage tail with `muted` when below 80% of the limit", () => {
		const { ctx, collected } = makeCtx(500, 1000);
		const runtime = createRuntimeServices();

		runtime.updateStatus(ctx as never, makePolicy());

		assert.equal(collected.fgCalls.length, 1);
		assert.equal(collected.fgCalls[0]?.color, "muted");
		assert.equal(collected.fgCalls[0]?.text, "50%");
		assert.equal(collected.statusCalls.length, 1);
		assert.match(collected.statusCalls[0]?.text ?? "", /<muted>50%<\/muted>$/);
	});

	it("colours the usage tail with `warning` at exactly 80%", () => {
		const { ctx, collected } = makeCtx(800, 1000);
		const runtime = createRuntimeServices();

		runtime.updateStatus(ctx as never, makePolicy());

		assert.equal(collected.fgCalls[0]?.color, "warning");
		assert.match(collected.statusCalls[0]?.text ?? "", /<warning>80%<\/warning>$/);
	});

	it("colours the usage tail with `warning` above 80%", () => {
		const { ctx, collected } = makeCtx(950, 1000);
		const runtime = createRuntimeServices();

		runtime.updateStatus(ctx as never, makePolicy());

		assert.equal(collected.fgCalls[0]?.color, "warning");
	});

	it("only tints the usage tail — the prefix stays untinted in the final status text", () => {
		const { ctx, collected } = makeCtx(100, 1000);
		const runtime = createRuntimeServices();

		runtime.updateStatus(ctx as never, makePolicy());

		const text = collected.statusCalls[0]?.text ?? "";
		// Prefix appears verbatim, only the trailing tail is wrapped.
		assert.ok(text.startsWith(makePolicy().ui.name), `expected prefix to be untinted, got: ${text}`);
		assert.equal(collected.fgCalls.length, 1);
	});
});
