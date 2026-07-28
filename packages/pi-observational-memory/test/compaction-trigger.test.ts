import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import type { Runtime } from "../src/runtime.js";
import { compactionEntry, textCustomMessage, type TestEntry } from "./fixtures/session.js";

function captureHandler(args: { compactAfterTokens?: number; passive?: boolean; compactInFlight?: boolean } = {}) {
	let handler: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: typeof handler) => {
			expect(name).toBe("agent_end");
			handler = cb;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			compactAfterTokens: args.compactAfterTokens ?? 3,
			passive: args.passive ?? false,
		},
		compactInFlight: args.compactInFlight ?? false,
		observerPromise: new Promise(() => {}),
		reflectDropPromise: new Promise(() => {}),
	};
	registerCompactionTrigger(pi as unknown as ExtensionAPI, runtime as unknown as Runtime);
	if (!handler) throw new Error("agent_end handler was not registered");
	return { handler, runtime };
}

function agentEnd(errorMessage?: string) {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: "hello" },
			errorMessage
				? { role: "assistant", content: [], stopReason: "error", errorMessage }
				: { role: "assistant", content: "done", stopReason: "end_turn" },
		],
	};
}

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}) {
	let branchIndex = 0;
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		sessionManager: { getBranch },
		hasUI: true,
		ui: { notify: vi.fn() },
		isIdle: vi.fn(() => true),
		compact: vi.fn(),
		...overrides,
	};
}

const dueBranch = [textCustomMessage("raw-1", "aaaaaaaaaaaa")]; // 3 tokens
const belowBranch = [textCustomMessage("raw-1", "aaaa")]; // 1 token

describe("V3 compaction trigger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does nothing below compactAfterTokens", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([belowBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact when compactAfterTokens is reached", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 tokens); triggering compaction",
			"info",
		);
	});

	it("skips passive mode", async () => {
		const { handler, runtime } = captureHandler({ passive: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { handler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips retryable assistant errors", async () => {
		const { handler, runtime } = captureHandler();
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd("fetch failed: connection lost"), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("does not await observer or reflect/drop promises before compacting", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("defers compaction if context is no longer idle", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent became busy before compaction",
			"info",
		);
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "bbbbbbbb"),
		];
		const ctx = fakeCtx([branch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("handles compact() throwing synchronously", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], {
			compact: vi.fn(() => { throw new Error("compaction failed"); }),
		});

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compact threw: compaction failed",
			"error",
		);
	});

	it("handles compact onComplete callback", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);
		let onCompleteCb: (() => void) | undefined;
		ctx.compact.mockImplementation((opts: { onComplete?: () => void }) => {
			onCompleteCb = opts.onComplete;
		});

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(true);
		expect(onCompleteCb).toBeDefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 tokens); triggering compaction",
			"info",
		);

		onCompleteCb!();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Observational memory: compaction complete", "info");
	});

	it("handles compact onError callback with generic error", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);
		let onErrorCb: ((error: { message: string }) => void) | undefined;
		ctx.compact.mockImplementation((opts: { onError?: (error: { message: string }) => void }) => {
			onErrorCb = opts.onError;
		});

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		onErrorCb!({ message: "compaction error" });
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Observational memory: compaction error", "error");
	});

	it("skips onError notification for compaction cancelled", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);
		let onErrorCb: ((error: { message: string }) => void) | undefined;
		ctx.compact.mockImplementation((opts: { onError?: (error: { message: string }) => void }) => {
			onErrorCb = opts.onError;
		});

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		onErrorCb!({ message: "Compaction cancelled" });
		expect(runtime.compactInFlight).toBe(false);
		// Should not notify for cancelled compaction
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("Compaction cancelled"),
			"error",
		);
	});

	it("handles no UI when hasUI is false", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { hasUI: false, ui: undefined });

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});
});
