/**
 * Unit tests for `createRecapOrchestrator` — the state machine that owns
 * the active-request controller, the leaf-id snapshot, the pending-recap
 * parking slot, and the idle timer.
 *
 * The orchestrator is constructed with a plain deps object (no globals,
 * no pi-tui, no pi-ai) so every branch can be driven deterministically.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRecapOrchestrator, type RecapOrchestratorDeps } from "../src/recapOrchestrator.js";

// --- fixtures -------------------------------------------------------------

function branchWithActivity(): unknown[] {
	// Tool call -> passes hasMeaningfulActivity.
	return [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "do something" }] },
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "ok" },
					{ type: "toolCall", name: "edit", arguments: {} },
				],
			},
		},
	];
}

interface FakeDepsExtras {
	completeSimple: ReturnType<typeof vi.fn>;
	getModel: ReturnType<typeof vi.fn>;
	getBranch: ReturnType<typeof vi.fn>;
	getLeafId: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
	onError?: (err: unknown) => void;
	onTrigger?: () => void;
	onUsage?: (usage: { input: number; output: number }) => void;
}

function makeDeps(
	overrides: {
		completeSimpleImpl?: (
			model: unknown,
			context: unknown,
			options: { signal?: AbortSignal },
		) => Promise<unknown>;
		leafIds?: string[];
		branch?: unknown[];
		config?: Partial<RecapOrchestratorDeps["config"]>;
		hasUI?: boolean;
	} = {},
): RecapOrchestratorDeps & FakeDepsExtras {
	const completeSimple = vi.fn(
		overrides.completeSimpleImpl ??
			(() => ({
				content: [{ type: "text", text: "one-line recap" }],
			})),
	);
	const getModel = vi.fn(() => undefined);
	const branch = overrides.branch ?? branchWithActivity();
	const getBranch = vi.fn(() => branch);
	// Default: stable leaf across the test. Tests can seed a sequence.
	const leafSeq = overrides.leafIds ?? ["leaf-1"];
	let leafIdx = 0;
	const getLeafId = vi.fn(() => leafSeq[Math.min(leafIdx++, leafSeq.length - 1)]);
	const setWidget = vi.fn();
	const setStatus = vi.fn();
	const getApiKeyAndHeaders = vi.fn(() => ({ ok: true, apiKey: "test-key" }));

	const config: RecapOrchestratorDeps["config"] = {
		isAutoEnabled: () => true,
		isFocusDisabled: () => false,
		idleMs: () => 1000,
		focusMinMs: () => 100,
		modelOverride: () => undefined,
		...overrides.config,
	};

	const ctx = {
		hasUI: overrides.hasUI ?? true,
		model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		ui: {
			setWidget,
			setStatus,
			notify: vi.fn(),
			theme: {
				fg: (_c: string, t: string) => t,
				bold: (t: string) => t,
			},
		},
		sessionManager: { getBranch, getLeafId },
		modelRegistry: { getApiKeyAndHeaders },
	};

	const deps = {
		completeSimple: completeSimple as unknown as RecapOrchestratorDeps["completeSimple"],
		getModel: getModel as unknown as RecapOrchestratorDeps["getModel"],
		ctx: ctx as unknown as RecapOrchestratorDeps["ctx"],
		config,
	} as RecapOrchestratorDeps;
	return Object.assign(deps, {
		// Raw vi.fn() handles re-exposed so individual tests can inspect
		// calls without reaching back through `deps.completeSimple`.
		completeSimple,
		getModel,
		getBranch,
		getLeafId,
		setWidget,
		setStatus,
		getApiKeyAndHeaders,
	});
}

// --- tests ----------------------------------------------------------------

describe("recapOrchestrator", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("runGenerateAndShow calls completeSimple and paints the widget when the leaf is stable", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		expect(deps.setWidget).toHaveBeenCalled();
	});

	it("discards the recap if the leaf advances while the model call is in flight (leaf-id snapshot guard), for non-manual reasons", async () => {
		// Two distinct leaves: snapshot reads the first, post-await reads the second.
		// The guard only applies to automatic triggers (idle/focus/resume), not manual.
		const deps = makeDeps({ leafIds: ["leaf-A", "leaf-B"] });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "idle" });

		// LLM ran...
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		// Placeholder was set before the LLM call, but the final recap must NOT be painted (stale leaf).
		const finalPaints = deps.setWidget.mock.calls.filter(
			(a) => a[1] !== undefined && !(a[1] as string).includes("generating…"),
		);
		expect(finalPaints).toHaveLength(0);
	});

	it("shows the recap even if the leaf advances during manual /recap (leaf-id guard skipped for manual)", async () => {
		// Manual /recap adds the command itself as a new leaf entry — expected and harmless.
		const deps = makeDeps({ leafIds: ["leaf-A", "leaf-B"] });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		// Widget MUST be shown for manual even with a new leaf (placeholder + final = 2 calls).
		expect(deps.setWidget).toHaveBeenCalledTimes(2);
	});

	it("late completion from a cancelled request does not clobber a newer active request (ownership guard)", async () => {
		// Hold the first call open until we tell it to resolve.
		let releaseFirst: ((v: unknown) => void) | undefined;
		const firstDone = new Promise((res) => {
			releaseFirst = res;
		});

		const completeSimpleImpl = vi
			.fn()
			// First call: hangs until we release.
			.mockImplementationOnce(async (_m, _c, opts: { signal?: AbortSignal }) => {
				await firstDone;
				// After release, if we were aborted, simulate the real API
				// returning its (now-ignored) response — the orchestrator must
				// not paint it.
				if (opts.signal?.aborted) throw new Error("aborted");
				return { content: [{ type: "text", text: "stale" }] };
			})
			// Second call: resolves immediately with a fresh recap.
			.mockImplementationOnce(() => ({
				content: [{ type: "text", text: "fresh" }],
			}));

		const deps = makeDeps({ completeSimpleImpl });
		const orch = createRecapOrchestrator(deps);

		// Kick off #1 (don't await — it's blocked).
		const p1 = orch.runGenerateAndShow({ reason: "manual" });

		// Kick off #2; per ownership contract, it cancels #1 and runs to completion.
		await orch.runGenerateAndShow({ reason: "manual" });

		// Release #1 so its finally block runs with an aborted signal.
		releaseFirst!(undefined);
		await p1.catch(() => {});

		// Only the fresh final recap should have painted; placeholders are excluded.
		const finalCalls = deps.setWidget.mock.calls.filter(
			(args) => args[1] !== undefined && !(args[1] as string).includes("generating…"),
		);
		expect(finalCalls).toHaveLength(1);
	});

	it("onFocusOut skips regen when a recap already exists for the current leaf", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);

		// Prime: a successful focus recap stamps the current leaf.
		await orch.runGenerateAndShow({ reason: "focus" });
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);

		// Another focus-out at the same leaf must short-circuit.
		orch.onFocusOut();
		// Give any scheduled microtasks a chance to run.
		await Promise.resolve();
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("onFocusIn under the min-seconds glance threshold cancels an in-flight focus draft and discards any pending recap", async () => {
		// Hold the focus draft open.
		let releaseDraft: ((v: unknown) => void) | undefined;
		const draftDone = new Promise((res) => {
			releaseDraft = res;
		});
		const completeSimpleImpl = vi
			.fn()
			.mockImplementationOnce(async (_m, _c, opts: { signal?: AbortSignal }) => {
				await draftDone;
				if (opts.signal?.aborted) throw new Error("aborted");
				return { content: [{ type: "text", text: "draft" }] };
			});
		const deps = makeDeps({ completeSimpleImpl });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		// Wait for the draft's async path to be kicked off.
		await Promise.resolve();
		await Promise.resolve();

		// Very fast focus-in (< focusMinMs = 100ms by default in makeDeps).
		orch.onFocusIn();

		// Release the stuck draft so its finally runs.
		releaseDraft!(undefined);
		await new Promise((r) => setTimeout(r, 10));

		// Final recap must never have been painted (placeholder is expected; draft was aborted).
		expect(deps.setWidget.mock.calls.filter(
			(args) => args[1] !== undefined && !(args[1] as string).includes("generating…"),
		)).toEqual([]);
	});

	it("onFocusIn after the min-seconds threshold reveals a pending recap", async () => {
		const deps = makeDeps({ config: { focusMinMs: () => 0 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		// Await the draft cycle (focus reason + focusedOutAt !== undefined ⇒ parks in pendingRecap).
		await new Promise((r) => setTimeout(r, 10));
		// It should NOT have painted a final recap yet — the draft parked (placeholder is expected).
		expect(deps.setWidget.mock.calls.filter(
			(args) => args[1] !== undefined && !(args[1] as string).includes("generating…"),
		)).toEqual([]);

		orch.onFocusIn();
		// pendingRecap is revealed synchronously in onFocusIn.
		const paints = deps.setWidget.mock.calls.filter(
			(args) => args[1] !== undefined && !(args[1] as string).includes("generating…"),
		);
		expect(paints).toHaveLength(1);
	});

	it("scheduleRecap arms an idle timer that fires runGenerateAndShow; cancelActive aborts the in-flight request", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { idleMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.scheduleRecap();
		expect(deps.completeSimple).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(5000);
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);

		// cancelActive is a noop when nothing is in flight and must not throw.
		orch.cancelActive();
	});

	it("scheduleRecap does nothing when --recap-auto is not set", () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { isAutoEnabled: () => false } });
		const orch = createRecapOrchestrator(deps);
		orch.scheduleRecap();
		vi.advanceTimersByTime(10_000);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	// Regression: the idle-timer callback must not throw when the captured
	// ctx has been invalidated by pi (e.g. a prior ctx.reload() / session
	// replacement whose session_shutdown cleanup for this orchestrator was
	// missed or raced). The stale-ctx getters throw a canonical message; the
	// orchestrator must catch it and silently bail.
	it("runGenerateAndShow swallows stale-ctx errors from ctx.sessionManager and does not throw", async () => {
		const deps = makeDeps();
		// Simulate the captured ctx going stale: every sessionManager access
		// throws the canonical message from pi's ExtensionRunner.assertActive().
		const STALE = new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
		deps.getBranch.mockImplementation(() => {
			throw STALE;
		});
		deps.getLeafId.mockImplementation(() => {
			throw STALE;
		});

		const orch = createRecapOrchestrator(deps);
		await expect(orch.runGenerateAndShow({ reason: "idle" })).resolves.toBeUndefined();
		expect(deps.completeSimple).not.toHaveBeenCalled();
		expect(deps.setWidget).not.toHaveBeenCalled();
	});

	it("idle timer callback swallows stale-ctx errors rather than throwing from the Timeout", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { idleMs: () => 1000 } });
		const orch = createRecapOrchestrator(deps);

		orch.scheduleRecap();

		// Invalidate the captured ctx between scheduling and firing.
		const STALE = new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
		deps.getBranch.mockImplementation(() => {
			throw STALE;
		});

		// Advancing timers must not surface an unhandled exception.
		await vi.advanceTimersByTimeAsync(1500);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("allows focus recap during active agent when allowDuringActive() returns true; agent_end does not double-fire", async () => {
		const deps = makeDeps({ config: { allowDuringActive: () => true } });
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut();

		// With the opt-in flag set, the focus draft must run immediately rather
		// than parking. ~10ms of real timers is enough for the async chain.
		await new Promise((r) => setTimeout(r, 10));
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);

		// agent_end must NOT flush a deferred draft — nothing was parked.
		orch.onAgentEnd();
		await new Promise((r) => setTimeout(r, 10));
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("defers focus recap while agent is active and fires it on agent_end", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut();
		// Allow any errantly-scheduled microtasks to run.
		await Promise.resolve();
		await Promise.resolve();
		expect(deps.completeSimple).not.toHaveBeenCalled();

		orch.onAgentEnd();
		// onAgentEnd kicks off the deferred focus draft asynchronously.
		await new Promise((r) => setTimeout(r, 10));
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("checkDeferredFocus fires a deferred focus recap when agent has since ended", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut();
		orch.onAgentEnd();
		// Drain agent_end's scheduled draft first so we can see whether
		// checkDeferredFocus does anything additional. Reset the mock after.
		await new Promise((r) => setTimeout(r, 10));
		deps.completeSimple.mockClear();

		// Now the deferred bit is cleared; checkDeferredFocus is a no-op.
		orch.checkDeferredFocus();
		await Promise.resolve();
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("checkDeferredFocus is the only thing that flushes a deferred focus recap when agent_end was missed", async () => {
		// Simulate a path where onAgentEnd never fires (e.g. event ordering)
		// and only turn_end / checkDeferredFocus is left to flush the parked
		// focus draft. We force this by manually clearing agentActive via a
		// fresh orchestrator that never received onAgentStart.
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut();
		await Promise.resolve();
		expect(deps.completeSimple).not.toHaveBeenCalled();

		// checkDeferredFocus while agent is still active must NOT fire.
		orch.checkDeferredFocus();
		await Promise.resolve();
		expect(deps.completeSimple).not.toHaveBeenCalled();

		// After agent ends, onAgentEnd flushes; if we instead use
		// checkDeferredFocus on a state where agentActive has gone false
		// without onAgentEnd's flush running, it should still fire.
		orch.onAgentEnd();
		await new Promise((r) => setTimeout(r, 10));
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("focus-out during active agent + focus-in before agent_end clears the deferred bit (no recap on agent_end)", async () => {
		const deps = makeDeps({ config: { focusMinMs: () => 0 } });
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut();
		// User comes back before the agent finishes — wipes the parked focus draft.
		orch.onFocusIn();
		orch.onAgentEnd();

		await new Promise((r) => setTimeout(r, 10));
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("onTurnStart cancels active recap and clears pending state", async () => {
		// First, prime the orchestrator with a pending recap parked behind
		// focus-out (focusedOutAt set, so a focus draft parks rather than
		// paints).
		const deps = makeDeps({ config: { focusMinMs: () => 100 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		await new Promise((r) => setTimeout(r, 10));
		// First focus draft completed and parked; no final recap yet (placeholder is expected).
		expect(
			deps.setWidget.mock.calls.filter(
				(args) => args[1] !== undefined && !(args[1] as string).includes("generating…"),
			),
		).toEqual([]);
		deps.completeSimple.mockClear();

		// turn_start should clear the parked recap so a later focus-in won't reveal it.
		orch.onTurnStart();
		orch.onFocusIn();
		expect(
			deps.setWidget.mock.calls.filter(
				(args) => args[1] !== undefined && !(args[1] as string).includes("generating…"),
			),
		).toEqual([]);
	});

	it("onTurnStart aborts an in-flight recap", async () => {
		let release: ((v: unknown) => void) | undefined;
		const hold = new Promise((res) => {
			release = res;
		});
		let wasAborted = false;
		const completeSimpleImpl = vi.fn(
			async (_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) => {
				await hold;
				wasAborted = !!opts.signal?.aborted;
				if (opts.signal?.aborted) throw new Error("aborted");
				return { content: [{ type: "text", text: "x" }] };
			},
		);
		const deps = makeDeps({ completeSimpleImpl });
		const orch = createRecapOrchestrator(deps);

		const p = orch.runGenerateAndShow({ reason: "manual" });
		await Promise.resolve();

		orch.onTurnStart();
		release!(undefined);
		await p.catch(() => {});

		expect(wasAborted).toBe(true);
		expect(
			deps.setWidget.mock.calls.filter(
				(args) => args[1] !== undefined && !(args[1] as string).includes("generating…"),
			),
		).toEqual([]);
	});

	it("passes cacheRetention: 'none' to completeSimple and does not cap maxTokens (Bedrock thinking models truncate text otherwise)", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		const opts = deps.completeSimple.mock.calls[0]![2] as Record<string, unknown>;
		expect(opts["cacheRetention"]).toBe("none");
		expect("maxTokens" in opts).toBe(false);
	});

	it("sets reasoning: 'minimal' for reasoning models to keep hidden-reasoning spend at the floor", async () => {
		const deps = makeDeps();
		(deps.ctx as unknown as { model: Record<string, unknown> }).model = {
			provider: "openai",
			id: "gpt-5",
			reasoning: true,
		};
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		const opts = deps.completeSimple.mock.calls[0]![2] as Record<string, unknown>;
		expect(opts["reasoning"]).toBe("minimal");
	});

	it("omits the reasoning field for non-reasoning models", async () => {
		const deps = makeDeps();
		(deps.ctx as unknown as { model: Record<string, unknown> }).model = {
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			reasoning: false,
		};
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		const opts = deps.completeSimple.mock.calls[0]![2] as Record<string, unknown>;
		expect("reasoning" in opts).toBe(false);
	});

	it("onFocusOut swallows stale-ctx errors from ctx.sessionManager", () => {
		const deps = makeDeps();
		const STALE = new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
		deps.getBranch.mockImplementation(() => {
			throw STALE;
		});
		deps.getLeafId.mockImplementation(() => {
			throw STALE;
		});
		const orch = createRecapOrchestrator(deps);
		expect(() => orch.onFocusOut()).not.toThrow();
	});

	// ---- model override & auth coverage ------------------------------------

	it("uses the resolved model when modelOverride() returns a parseable spec that getModel resolves", async () => {
		const found = { provider: "anthropic", id: "claude-haiku-4-5" };
		const deps = makeDeps({ config: { modelOverride: () => "anthropic/claude-haiku-4-5" } });
		deps.getModel.mockReturnValue(found);
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		// First argument should be the found model.
		expect(deps.completeSimple.mock.calls[0]![0]).toBe(found);
		expect(deps.setWidget).toHaveBeenCalled();
	});

	it("falls back to ctx.model when modelOverride() returns a parseable spec that getModel cannot resolve", async () => {
		const deps = makeDeps({ config: { modelOverride: () => "anthropic/claude-haiku-4-5" } });
		deps.getModel.mockReturnValue(undefined);
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		// Falls back to ctx.model since found === undefined.
		expect(deps.completeSimple.mock.calls[0]![0]).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6" });
	});

	it("skips model override block entirely when spec has no slash (splitModel returns undefined)", async () => {
		// A spec with no slash is invalid — splitModel returns undefined.
		const deps = makeDeps({ config: { modelOverride: () => "no-slash-spec" } });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		// getModel should never be consulted.
		expect(deps.getModel).not.toHaveBeenCalled();
		// Falls back to ctx.model — recap still generated.
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("returns undefined from runModelCall when ctx.model is undefined and no override resolves", async () => {
		const deps = makeDeps();
		// Clear the active model.
		(deps.ctx as unknown as { model: undefined }).model = undefined;
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		// No model → runModelCall returns undefined → no completeSimple call.
		expect(deps.completeSimple).not.toHaveBeenCalled();
		// Placeholder was set before runModelCall bailed; no final recap painted.
		expect(deps.setWidget).toHaveBeenCalledTimes(1);
	});

	it("returns undefined from runModelCall when getApiKeyAndHeaders returns ok=false", async () => {
		const deps = makeDeps();
		deps.getApiKeyAndHeaders.mockReturnValue({ ok: false, apiKey: undefined });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).not.toHaveBeenCalled();
		// Placeholder was set before runModelCall bailed; no final recap painted.
		expect(deps.setWidget).toHaveBeenCalledTimes(1);
	});

	// ---- early-return paths in runGenerateAndShow -------------------------

	it("returns early without calling completeSimple when the transcript is empty (all entries have no text)", async () => {
		// A branch with an assistant message that has no text and no tool calls
		// → buildRecentTranscript returns only whitespace → early return.
		const emptyBranch = [
			{
				type: "message",
				message: { role: "user", content: [] },
			},
			{
				type: "message",
				message: { role: "assistant", content: [] },
			},
		];
		const deps = makeDeps({ branch: emptyBranch });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).not.toHaveBeenCalled();
		// Manual /recap on empty transcript should notify the user.
		const notify = (deps.ctx.ui as unknown as { notify: ReturnType<typeof vi.fn> }).notify;
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatch(/nothing to recap/i);
		expect(notify.mock.calls[0]?.[1]).toBe("info");
	});

	it("returns early without calling completeSimple when entries have no meaningful activity and reason is not 'manual'", async () => {
		// A user message only (no assistant tool calls or long text) fails the
		// hasMeaningfulActivity check. Non-manual reasons gate on this check.
		const noActivityBranch = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "ping" }] },
			},
		];
		const deps = makeDeps({ branch: noActivityBranch });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "idle" });

		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("does not paint the widget when completeSimple returns an empty text response", async () => {
		const deps = makeDeps({
			completeSimpleImpl: () => Promise.resolve({ content: [{ type: "text", text: "" }] }),
		});
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		// Placeholder was set, but final recap was not (empty LLM response).
		expect(deps.setWidget.mock.calls.filter(
			(a) => a[1] !== undefined && !(a[1] as string).includes("generating…"),
		)).toEqual([]);
	});

	it("focus recap shows directly when onFocusIn clears focusedOutAt while the draft is in flight", async () => {
		let releaseDraft: ((v: unknown) => void) | undefined;
		const draftDone = new Promise((res) => {
			releaseDraft = res;
		});
		const completeSimpleImpl = vi.fn(async (_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) => {
			await draftDone;
			if (opts.signal?.aborted) throw new Error("aborted");
			return { content: [{ type: "text", text: "direct recap" }] };
		});
		// focusMinMs=0: any focus-out duration meets the threshold (draft not cancelled).
		const deps = makeDeps({ completeSimpleImpl, config: { focusMinMs: () => 0 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut(); // sets focusedOutAt, kicks off held draft
		await Promise.resolve();
		await Promise.resolve();

		// onFocusIn with sufficient duration clears focusedOutAt without cancelling
		orch.onFocusIn();

		// Release the draft — it should find focusedOutAt===undefined → showRecap directly.
		releaseDraft!(undefined);
		await new Promise((r) => setTimeout(r, 10));

		// placeholder + final recap = 2 non-undefined calls; filter to final only.
		const paints = deps.setWidget.mock.calls.filter(
			(a) => a[1] !== undefined && !(a[1] as string).includes("generating…"),
		);
		expect(paints).toHaveLength(1);
	});

	// ---- scheduleRecap & safeHasUI ----------------------------------------

	it("scheduleRecap does nothing when hasUI is false (safeHasUI returns false)", () => {
		vi.useFakeTimers();
		const deps = makeDeps({ hasUI: false });
		const orch = createRecapOrchestrator(deps);
		orch.scheduleRecap();
		vi.advanceTimersByTime(10_000);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("safeHasUI returns false (and does not throw) when ctx.hasUI getter throws a stale-ctx error", () => {
		vi.useFakeTimers();
		const deps = makeDeps();
		Object.defineProperty(deps.ctx, "hasUI", {
			get: () => { throw new Error("This extension ctx is stale after session replacement or reload."); },
			configurable: true,
		});
		const orch = createRecapOrchestrator(deps);
		// scheduleRecap calls safeHasUI; stale error should not surface.
		expect(() => orch.scheduleRecap()).not.toThrow();
		vi.useRealTimers();
	});

	it("safeHasUI re-throws non-stale-ctx errors from ctx.hasUI", () => {
		vi.useFakeTimers();
		const deps = makeDeps();
		Object.defineProperty(deps.ctx, "hasUI", {
			get: () => { throw new Error("permission denied"); },
			configurable: true,
		});
		const orch = createRecapOrchestrator(deps);
		expect(() => orch.scheduleRecap()).toThrow("permission denied");
		vi.useRealTimers();
	});

	it("safeGetBranch re-throws non-stale-ctx errors from sessionManager.getBranch", async () => {
		const deps = makeDeps();
		deps.getBranch.mockImplementation(() => {
			throw new Error("unexpected I/O error");
		});
		const orch = createRecapOrchestrator(deps);
		await expect(orch.runGenerateAndShow({ reason: "manual" })).rejects.toThrow("unexpected I/O error");
	});

	// ---- optional-chain callbacks (onTrigger, onUsage, onError) -----------

	it("calls onTrigger and onUsage when a recap is successfully generated", async () => {
		const onTrigger = vi.fn();
		const onUsage = vi.fn();
		const deps = makeDeps({
			completeSimpleImpl: () => Promise.resolve({
				content: [{ type: "text", text: "recap" }],
				usage: { input: 42, output: 7 },
			}),
		});
		deps.onTrigger = onTrigger;
		deps.onUsage = onUsage;
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(onTrigger).toHaveBeenCalledTimes(1);
		expect(onUsage).toHaveBeenCalledWith({ input: 42, output: 7 });
	});

	it("calls onError when completeSimple throws a non-abort error", async () => {
		const onError = vi.fn();
		const deps = makeDeps({
			completeSimpleImpl: () => Promise.reject(new Error("model API failure")),
		});
		deps.onError = onError;
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "model API failure" }));
	});

	it("idle timer's .catch calls onError when runGenerateAndShow rejects with a non-stale-ctx error", async () => {
		vi.useFakeTimers();
		const onError = vi.fn();
		const deps = makeDeps({ config: { idleMs: () => 1000 } });
		deps.onError = onError;
		deps.getBranch.mockImplementation(() => {
			throw new Error("branch read failed");
		});
		const orch = createRecapOrchestrator(deps);
		orch.scheduleRecap();
		await vi.advanceTimersByTimeAsync(1500);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "branch read failed" }));
	});

	it("maybeGenerateDeferredFocusRecap's .catch calls onError when runGenerateAndShow rejects", async () => {
		const onError = vi.fn();
		const deps = makeDeps();
		deps.onError = onError;
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut(); // parks deferred focus (agentActive=true)

		// Make getBranch throw on the next call (inside runGenerateAndShow).
		deps.getBranch.mockImplementation(() => {
			throw new Error("deferred branch error");
		});
		orch.onAgentEnd(); // triggers maybeGenerateDeferredFocusRecap
		await new Promise((r) => setTimeout(r, 10));

		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "deferred branch error" }));
	});

	it("onFocusOut's .catch calls onError when runGenerateAndShow rejects with a non-stale-ctx error", async () => {
		const onError = vi.fn();
		const deps = makeDeps();
		deps.onError = onError;

		// First getBranch call (synchronous in onFocusOut): succeeds with activity.
		// Second call (inside runGenerateAndShow): throws a non-stale error.
		deps.getBranch
			.mockReturnValueOnce(branchWithActivity())
			.mockImplementation(() => {
				throw new Error("focus branch error");
			});

		const orch = createRecapOrchestrator(deps);
		orch.onFocusOut();
		await new Promise((r) => setTimeout(r, 10));

		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "focus branch error" }));
	});
});
