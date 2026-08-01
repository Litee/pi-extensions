/**
 * Unit tests for `createRecapOrchestrator` — the state machine that owns
 * the away timer, the post-turn debounce, the idle fallback, the
 * active-request controller, and the fingerprint dedupe.
 *
 * The orchestrator is constructed with a plain deps object (no globals,
 * no pi-tui, no pi-ai) so every branch can be driven deterministically.
 *
 * Semantics follow upstream session-recap v0.2.2: a recap is only drafted
 * after a genuine absence (continuous blur ≥ away-seconds, a turn ending
 * while blurred, or an idle timeout on terminals that never report focus).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRecapOrchestrator, type RecapOrchestratorDeps } from "../src/recapOrchestrator.js";

// --- fixtures -------------------------------------------------------------

function branchWithActivity(): unknown[] {
	// Tool call -> passes hasMeaningfulActivity; transcript is non-empty.
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
	setWidget: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	ctx: unknown;
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
		) => unknown;
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
	const setWidget = vi.fn();
	const setStatus = vi.fn();
	const notify = vi.fn();
	const getApiKeyAndHeaders = vi.fn(() => ({ ok: true, apiKey: "test-key" }));

	const config: RecapOrchestratorDeps["config"] = {
		isAutoEnabled: () => true,
		isFocusDisabled: () => false,
		idleMs: () => 1000,
		awayMs: () => 1000,
		modelOverride: () => undefined,
		...overrides.config,
	};

	const ctx = {
		hasUI: overrides.hasUI ?? true,
		model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		ui: {
			setWidget,
			setStatus,
			notify,
			theme: {
				fg: (_c: string, t: string) => t,
				bold: (t: string) => t,
			},
		},
		sessionManager: { getBranch },
		modelRegistry: { getApiKeyAndHeaders },
	};

	const deps = {
		completeSimple: completeSimple as unknown as RecapOrchestratorDeps["completeSimple"],
		getModel: getModel as unknown as RecapOrchestratorDeps["getModel"],
		ctx: ctx as unknown as RecapOrchestratorDeps["ctx"],
		config,
	} as RecapOrchestratorDeps;
	return Object.assign(deps, {
		completeSimple,
		getModel,
		getBranch,
		setWidget,
		setStatus,
		getApiKeyAndHeaders,
		notify,
		ctx,
	});
}

/** Widget paints carrying a final recap (any setWidget with non-undefined body). */
function finalPaints(setWidget: ReturnType<typeof vi.fn>) {
	return setWidget.mock.calls.filter((a: unknown[]) => a[1] !== undefined);
}

// --- tests ----------------------------------------------------------------

describe("recapOrchestrator", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("runGenerateAndShow calls completeSimple and paints the widget", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		expect(finalPaints(deps.setWidget)).toHaveLength(1);
	});

	it("passes cacheRetention 'none' and maxTokens 256, and omits the reasoning field", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		const opts = deps.completeSimple.mock.calls[0]![2] as Record<string, unknown>;
		expect(opts["cacheRetention"]).toBe("none");
		expect(opts["maxTokens"]).toBe(256);
		expect("reasoning" in opts).toBe(false);
	});

	it("does not send an apiKey when auth resolved ok without one (env-auth providers)", async () => {
		const deps = makeDeps();
		deps.getApiKeyAndHeaders.mockReturnValue({
			ok: true,
			env: { ANTHROPIC_BASE_URL: "http://localhost.invalid" },
		});
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		const opts = deps.completeSimple.mock.calls[0]![2] as Record<string, unknown>;
		expect("apiKey" in opts).toBe(false);
		expect(opts["env"]).toEqual({ ANTHROPIC_BASE_URL: "http://localhost.invalid" });
	});

	it("forwards auth.env when auth resolution provides one alongside an apiKey", async () => {
		const deps = makeDeps();
		deps.getApiKeyAndHeaders.mockReturnValue({
			ok: true,
			apiKey: "key",
			env: { FOO: "bar" },
		});
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		const opts = deps.completeSimple.mock.calls[0]![2] as Record<string, unknown>;
		expect(opts["apiKey"]).toBe("key");
		expect(opts["env"]).toEqual({ FOO: "bar" });
	});

	it("bails without calling completeSimple when auth resolution failed (ok=false)", async () => {
		const deps = makeDeps();
		deps.getApiKeyAndHeaders.mockReturnValue({ ok: false, error: "no auth" });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).not.toHaveBeenCalled();
		expect(finalPaints(deps.setWidget)).toHaveLength(0);
	});

	it("skips silently when the provider is unknown to pi-ai (no widget, no onError)", async () => {
		const onError = vi.fn();
		const deps = makeDeps({
			completeSimpleImpl: () => Promise.reject(new Error("No API provider registered for api: bridge")),
		});
		deps.onError = onError;
		const orch = createRecapOrchestrator(deps);

		await expect(orch.runGenerateAndShow({ reason: "manual" })).resolves.toBeUndefined();
		expect(finalPaints(deps.setWidget)).toHaveLength(0);
		expect(onError).not.toHaveBeenCalled();
	});

	it("routes other model errors through onError", async () => {
		const onError = vi.fn();
		const deps = makeDeps({
			completeSimpleImpl: () => Promise.reject(new Error("model API failure")),
		});
		deps.onError = onError;
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "model API failure" }));
	});

	it("flattens multi-block model output: joins text blocks, collapses whitespace, trims, caps at 600", async () => {
		const long = "start ".repeat(400); // 2400 chars > 600
		const deps = makeDeps({
			completeSimpleImpl: () =>
				Promise.resolve({
					content: [
						{ type: "text", text: "line one\n\nline   two" },
						{ type: "text", text: ` tail ${long}` },
					],
				}),
		});
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		// Widget body lines joined must reflect the flattened text, capped at 600.
		const body = finalPaints(deps.setWidget)[0]![1] as string[];
		const joined = body.join(" ");
		expect(joined).toContain("line one line two");
		expect(joined.length).toBeLessThanOrEqual(700); // header + wrapped body
	});

	it("wraps the recap body to at most 4 lines, appending ' …' when truncated", async () => {
		const recap = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
		const deps = makeDeps({ completeSimpleImpl: () => ({ content: [{ type: "text", text: recap }] }) });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		const paint = finalPaints(deps.setWidget)[0]!;
		const body = (paint[1] as string[]).slice(1); // drop the header line
		expect(body).toHaveLength(4);
		expect(body[3]!.endsWith(" …")).toBe(true);
	});

	it("calls onTrigger and onUsage when a recap is successfully generated", async () => {
		const onTrigger = vi.fn();
		const onUsage = vi.fn();
		const deps = makeDeps({
			completeSimpleImpl: () =>
				Promise.resolve({
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

	it("uses 0 for input/output when response.usage is undefined", async () => {
		const onUsage = vi.fn();
		const deps = makeDeps({
			completeSimpleImpl: () => Promise.resolve({ content: [{ type: "text", text: "recap" }] }),
		});
		deps.onUsage = onUsage;
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(onUsage).toHaveBeenCalledWith({ input: 0, output: 0 });
	});

	it("notifies instead of painting when the model returns no text (manual)", async () => {
		const deps = makeDeps({
			completeSimpleImpl: () => Promise.resolve({ content: [{ type: "text", text: "   " }] }),
		});
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(finalPaints(deps.setWidget)).toHaveLength(0);
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify.mock.calls[0]?.[0]).toMatch(/empty/i);
	});

	it("notifies instead of painting when the transcript is empty (manual)", async () => {
		const deps = makeDeps({ branch: [] });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).not.toHaveBeenCalled();
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify.mock.calls[0]?.[0]).toMatch(/nothing to recap/i);
	});

	it("skips the model call when there is no meaningful activity and the reason is not manual", async () => {
		const deps = makeDeps({
			branch: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "ping" }] } }],
		});
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "idle" });

		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("discards the draft when the recap prompt changed while the model call was in flight", async () => {
		let releaseDraft: ((v: unknown) => void) | undefined;
		const draftDone = new Promise((res) => {
			releaseDraft = res;
		});
		const completeSimpleImpl = vi.fn(
			async (_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) => {
				await draftDone;
				if (opts.signal?.aborted) throw new Error("aborted");
				return { content: [{ type: "text", text: "stale draft" }] };
			},
		);
		const deps = makeDeps({ completeSimpleImpl });
		const orch = createRecapOrchestrator(deps);

		const p = orch.runGenerateAndShow({ reason: "idle" });
		await Promise.resolve();
		// The branch changes while the call is in flight.
		deps.getBranch.mockImplementation(() => [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "different question" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: {} }],
				},
			},
		]);
		releaseDraft!(undefined);
		await p;

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		expect(finalPaints(deps.setWidget)).toHaveLength(0);
	});

	it("dedupes: a second trigger for the same transcript fingerprint makes no further model call", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);

		await orch.runGenerateAndShow({ reason: "idle" });
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		expect(finalPaints(deps.setWidget)).toHaveLength(1);

		await orch.runGenerateAndShow({ reason: "idle" });
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		expect(finalPaints(deps.setWidget)).toHaveLength(1);
	});

	it("manual /recap bypasses the dedupe stamp", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);

		await orch.runGenerateAndShow({ reason: "idle" });
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(2);
	});

	it("sets the status line only for manual and idle reasons", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);

		await orch.runGenerateAndShow({ reason: "manual" });
		expect(deps.setStatus).toHaveBeenCalled();

		// The dedupe stamp is content-based; reset it between reasons so each
		// call actually reaches the model call.
		orch.reset();
		deps.setStatus.mockClear();
		deps.completeSimple.mockClear();
		await orch.runGenerateAndShow({ reason: "idle" });
		expect(deps.setStatus).toHaveBeenCalled();

		orch.reset();
		deps.setStatus.mockClear();
		deps.completeSimple.mockClear();
		await orch.runGenerateAndShow({ reason: "resume" });
		expect(deps.setStatus).not.toHaveBeenCalled();

		orch.reset();
		deps.setStatus.mockClear();
		deps.completeSimple.mockClear();
		await orch.runGenerateAndShow({ reason: "focus" });
		expect(deps.setStatus).not.toHaveBeenCalled();
	});

	// ---- away timer --------------------------------------------------------

	it("onFocusOut arms the away timer which drafts a recap after awayMs", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { awayMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		expect(deps.completeSimple).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(4900);
		expect(deps.completeSimple).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(200);
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		expect(finalPaints(deps.setWidget)).toHaveLength(1);
	});

	it("focus-in before the away timer expires cancels it (quick alt-tab costs nothing)", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { awayMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		await vi.advanceTimersByTimeAsync(3000);
		orch.onFocusIn();
		await vi.advanceTimersByTimeAsync(5000);

		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("the away recap shows even though the user already refocused mid-draft (draft is left to finish)", async () => {
		let releaseDraft: ((v: unknown) => void) | undefined;
		const draftDone = new Promise((res) => {
			releaseDraft = res;
		});
		const completeSimpleImpl = vi.fn(
			async (_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) => {
				await draftDone;
				if (opts.signal?.aborted) throw new Error("aborted");
				return { content: [{ type: "text", text: "away recap" }] };
			},
		);
		vi.useFakeTimers();
		const deps = makeDeps({ completeSimpleImpl, config: { awayMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		await vi.advanceTimersByTimeAsync(5000); // away timer fires, draft starts
		orch.onFocusIn(); // user returns while drafting
		releaseDraft!(undefined);
		await vi.advanceTimersByTimeAsync(10);

		const paints = finalPaints(deps.setWidget);
		expect(paints).toHaveLength(1);
	});

	// ---- turn-end while blurred --------------------------------------------

	it("turn_end while blurred drafts after the post-turn debounce", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { awayMs: () => 100_000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		orch.onTurnEnd();
		expect(deps.completeSimple).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(2999);
		expect(deps.completeSimple).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10);
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("a turn_start right after turn_end cancels the post-turn draft (mid-loop turn_ends)", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { awayMs: () => 100_000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut();
		orch.onTurnEnd();
		await vi.advanceTimersByTimeAsync(1000);
		orch.onTurnStart();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("turn_end while the terminal is focused does NOT arm the post-turn path", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { idleMs: () => 100_000, awayMs: () => 100_000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onTurnEnd(); // never blurred
		await vi.advanceTimersByTimeAsync(10_000);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	// ---- idle fallback -----------------------------------------------------

	it("turn_end arms the idle fallback when the terminal has not demonstrated focus support", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { idleMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onTurnEnd();
		expect(deps.completeSimple).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(5000);
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("the idle fallback is disarmed once a real focus event is seen this session", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { idleMs: () => 5000, awayMs: () => 100_000 } });
		const orch = createRecapOrchestrator(deps);

		// Blur then quickly refocus: focus support is demonstrated, and the
		// away/post-turn path is cancelled along the way.
		orch.onFocusOut();
		orch.onFocusIn();
		orch.onTurnEnd();
		// The idle delay passes with no recap — the idle path was not armed.
		await vi.advanceTimersByTimeAsync(5000);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("the idle fallback stays eligible when focus reporting is disabled", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({
			config: { isFocusDisabled: () => true, idleMs: () => 5000, awayMs: () => 100_000 },
		});
		const orch = createRecapOrchestrator(deps);

		orch.onFocusOut(); // would mark support, but focus is disabled
		orch.onTurnEnd();
		await vi.advanceTimersByTimeAsync(5000);

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("onInput cancels the armed idle timer", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { idleMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onTurnEnd();
		orch.onInput();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("scheduleIdleRecap (via onTurnEnd) does nothing when --recap-auto is off", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { isAutoEnabled: () => false } });
		const orch = createRecapOrchestrator(deps);

		orch.onTurnEnd();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	// ---- agent activity deferral -------------------------------------------

	it("defers the away recap while an agent turn is active and fires it on agent_end", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { awayMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut();
		await vi.advanceTimersByTimeAsync(5000); // away timer fires → parks
		expect(deps.completeSimple).not.toHaveBeenCalled();

		orch.onAgentEnd();
		await vi.advanceTimersByTimeAsync(10);
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("focus-in while the agent is still active clears the deferred bit (no recap on agent_end)", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { awayMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut();
		await vi.advanceTimersByTimeAsync(5000);
		orch.onFocusIn(); // user came back before the agent finished
		orch.onAgentEnd();
		await vi.advanceTimersByTimeAsync(10);

		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("allowDuringActive() drafts the away recap immediately instead of deferring", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({
			config: { allowDuringActive: () => true, awayMs: () => 5000 },
		});
		const orch = createRecapOrchestrator(deps);

		orch.onAgentStart();
		orch.onFocusOut();
		await vi.advanceTimersByTimeAsync(5000);
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);

		orch.onAgentEnd();
		await vi.advanceTimersByTimeAsync(10);
		expect(deps.completeSimple).toHaveBeenCalledTimes(1); // no double fire
	});

	// ---- abort / ownership ------------------------------------------------

	it("onTurnStart cancels an in-flight recap", async () => {
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
		expect(finalPaints(deps.setWidget)).toHaveLength(0);
	});

	it("late completion from a cancelled request does not clobber a newer active request", async () => {
		let releaseFirst: ((v: unknown) => void) | undefined;
		const firstDone = new Promise((res) => {
			releaseFirst = res;
		});
		const completeSimpleImpl = vi
			.fn()
			.mockImplementationOnce(async (_m, _c, opts: { signal?: AbortSignal }) => {
				await firstDone;
				if (opts.signal?.aborted) throw new Error("aborted");
				return { content: [{ type: "text", text: "stale" }] };
			})
			.mockImplementationOnce(() => ({ content: [{ type: "text", text: "fresh" }] }));

		const deps = makeDeps({ completeSimpleImpl });
		const orch = createRecapOrchestrator(deps);

		const p1 = orch.runGenerateAndShow({ reason: "manual" });
		await orch.runGenerateAndShow({ reason: "manual" });

		releaseFirst!(undefined);
		await p1.catch(() => {});

		const paints = finalPaints(deps.setWidget);
		expect(paints).toHaveLength(1);
		expect((paints[0]![1] as string[]).join(" ")).toContain("fresh");
	});

	it("onInput cancels an in-flight recap", async () => {
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
		orch.onInput();
		release!(undefined);
		await p.catch(() => {});

		expect(wasAborted).toBe(true);
		expect(finalPaints(deps.setWidget)).toHaveLength(0);
	});

	it("reset clears all timers and pending state", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { idleMs: () => 5000, awayMs: () => 5000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onTurnEnd(); // arms idle
		orch.onFocusOut(); // arms away
		orch.reset();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("reset clears the dedupe stamp so a later draft can run again", async () => {
		const deps = makeDeps();
		const orch = createRecapOrchestrator(deps);

		await orch.runGenerateAndShow({ reason: "idle" });
		await orch.runGenerateAndShow({ reason: "idle" }); // deduped
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);

		orch.reset();
		await orch.runGenerateAndShow({ reason: "idle" });
		expect(deps.completeSimple).toHaveBeenCalledTimes(2);
	});

	// ---- model override ----------------------------------------------------

	it("uses the resolved model when modelOverride() resolves via getModel", async () => {
		const found = { provider: "anthropic", id: "claude-haiku-4-5" };
		const deps = makeDeps({ config: { modelOverride: () => "anthropic/claude-haiku-4-5" } });
		deps.getModel.mockReturnValue(found);
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple.mock.calls[0]![0]).toBe(found);
	});

	it("falls back to ctx.model when modelOverride() cannot be resolved", async () => {
		const deps = makeDeps({ config: { modelOverride: () => "anthropic/claude-haiku-4-5" } });
		deps.getModel.mockReturnValue(undefined);
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple.mock.calls[0]![0]).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6" });
	});

	it("skips the override block when the spec has no slash", async () => {
		const deps = makeDeps({ config: { modelOverride: () => "no-slash-spec" } });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.getModel).not.toHaveBeenCalled();
		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
	});

	it("returns undefined from the model call when ctx.model is undefined and no override resolves", async () => {
		const deps = makeDeps();
		(deps.ctx as unknown as { model: undefined }).model = undefined;
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	// ---- stale-ctx guards --------------------------------------------------

	it("runGenerateAndShow swallows stale-ctx errors from ctx.sessionManager", async () => {
		const deps = makeDeps();
		const STALE = new Error("This extension ctx is stale after session replacement or reload.");
		deps.getBranch.mockImplementation(() => {
			throw STALE;
		});

		const orch = createRecapOrchestrator(deps);
		await expect(orch.runGenerateAndShow({ reason: "idle" })).resolves.toBeUndefined();
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("the idle timer callback swallows stale-ctx errors rather than throwing from the Timeout", async () => {
		vi.useFakeTimers();
		const deps = makeDeps({ config: { idleMs: () => 1000 } });
		const orch = createRecapOrchestrator(deps);

		orch.onTurnEnd();
		const STALE = new Error("This extension ctx is stale after session replacement or reload.");
		deps.getBranch.mockImplementation(() => {
			throw STALE;
		});

		await vi.advanceTimersByTimeAsync(1500);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("safeHasUI returns false (without throwing) when ctx.hasUI throws a stale-ctx error", async () => {
		vi.useFakeTimers();
		const deps = makeDeps();
		Object.defineProperty(deps.ctx, "hasUI", {
			get: () => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
			configurable: true,
		});
		const orch = createRecapOrchestrator(deps);
		expect(() => orch.onTurnEnd()).not.toThrow();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(deps.completeSimple).not.toHaveBeenCalled();
	});

	it("non-stale errors from the branch read still surface", async () => {
		const deps = makeDeps();
		deps.getBranch.mockImplementation(() => {
			throw new Error("unexpected I/O error");
		});
		const orch = createRecapOrchestrator(deps);
		await expect(orch.runGenerateAndShow({ reason: "manual" })).rejects.toThrow("unexpected I/O error");
	});

	// ---- UI surface --------------------------------------------------------

	it("does not paint the widget or status when ctx.hasUI is false", async () => {
		const deps = makeDeps({ hasUI: false });
		const orch = createRecapOrchestrator(deps);
		await orch.runGenerateAndShow({ reason: "manual" });

		expect(deps.completeSimple).toHaveBeenCalledTimes(1);
		expect(deps.setWidget).not.toHaveBeenCalled();
		expect(deps.setStatus).not.toHaveBeenCalled();
	});
});
