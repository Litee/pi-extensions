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
		isDisabled: () => false,
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

	it("discards the recap if the leaf advances while the model call is in flight (leaf-id snapshot guard)", async () => {
		// Two distinct leaves: snapshot reads the first, post-await reads the second.
		const deps = makeDeps({ leafIds: ["leaf-A", "leaf-B"] });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		// LLM ran...
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		// ...but the widget must NOT be painted (stale leaf).
		expect(deps.setWidget).not.toHaveBeenCalled();
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

		// Only the fresh recap should have painted; no stale second paint.
		const widgetCalls = deps.setWidget.mock.calls.filter(
			(args) => args[1] !== undefined,
		);
		expect(widgetCalls).toHaveLength(1);
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

		// Widget must never have been painted.
		expect(deps.setWidget.mock.calls.filter((args) => args[1] !== undefined)).toEqual([]);
	});

	it("onFocusIn after the min-seconds threshold reveals a pending recap", async () => {
		const deps = makeDeps({ config: { focusMinMs: () => 0 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		// Await the draft cycle (focus reason + focusedOutAt !== undefined ⇒ parks in pendingRecap).
		await new Promise((r) => setTimeout(r, 10));
		// It should NOT have painted yet — it parked.
		expect(deps.setWidget.mock.calls.filter((args) => args[1] !== undefined)).toEqual([]);

		orch.onFocusIn();
		// pendingRecap is revealed synchronously in onFocusIn.
		const paints = deps.setWidget.mock.calls.filter((args) => args[1] !== undefined);
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

	it("scheduleRecap does nothing when --recap-disable is set", () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { isDisabled: () => true } });
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
		// First focus draft completed and parked; no widget yet.
		expect(
			deps.setWidget.mock.calls.filter((args) => args[1] !== undefined),
		).toEqual([]);
		deps.completeSimple.mockClear();

		// turn_start should clear the parked recap so a later focus-in won't reveal it.
		orch.onTurnStart();
		orch.onFocusIn();
		expect(
			deps.setWidget.mock.calls.filter((args) => args[1] !== undefined),
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
			deps.setWidget.mock.calls.filter((args) => args[1] !== undefined),
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
});
