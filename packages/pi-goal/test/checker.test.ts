import { describe, expect, it, vi } from "vitest";

import {
	createCompletionChecker,
	parseCheckerJson,
	splitModelSpec,
	truncateTranscriptTail,
} from "../src/checker.js";

// --- pure-helper coverage ---------------------------------------------------

describe("splitModelSpec", () => {
	it("splits a normal provider/id spec", () => {
		expect(splitModelSpec("anthropic/claude-3-5")).toEqual({
			provider: "anthropic",
			id: "claude-3-5",
		});
	});

	it("preserves additional slashes inside the id (Bedrock global.x.y)", () => {
		expect(splitModelSpec("amazon-bedrock/global.anthropic.claude-haiku-4-5")).toEqual({
			provider: "amazon-bedrock",
			id: "global.anthropic.claude-haiku-4-5",
		});
	});

	it("rejects malformed specs", () => {
		expect(splitModelSpec("noslash")).toBeUndefined();
		expect(splitModelSpec("/leading")).toBeUndefined();
		expect(splitModelSpec("trailing/")).toBeUndefined();
	});
});

describe("truncateTranscriptTail", () => {
	it("returns input unchanged when under the limit", () => {
		expect(truncateTranscriptTail("hi", 10)).toBe("hi");
	});

	it("keeps the END (most recent material) when over the limit", () => {
		const input = "AAAA" + "B".repeat(50) + "CCCC";
		const out = truncateTranscriptTail(input, 10);
		expect(out).toContain("CCCC"); // tail preserved
		expect(out).not.toContain("AAAA"); // head dropped
		expect(out.startsWith("[…earlier")).toBe(true); // ellipsis prefix
	});
});

describe("parseCheckerJson", () => {
	it("parses a plain JSON object", () => {
		const out = parseCheckerJson(
			'{"verdict":"complete","confidence":"high","reason":"answered with 8"}',
		);
		expect(out?.verdict).toBe("complete");
		expect(out?.confidence).toBe("high");
		expect(out?.reason).toBe("answered with 8");
		expect(out?.rawText).toContain('"verdict"');
	});

	it("strips ```json fences before parsing", () => {
		const raw = '```json\n{"verdict":"incomplete","confidence":"low","reason":"no answer"}\n```';
		const out = parseCheckerJson(raw);
		expect(out?.verdict).toBe("incomplete");
		expect(out?.confidence).toBe("low");
	});

	it("recovers from leading prose by extracting the first {...} block", () => {
		const raw =
			'Sure thing, here is my verdict: {"verdict":"complete","confidence":"medium","reason":"seems done"}.';
		const out = parseCheckerJson(raw);
		expect(out?.verdict).toBe("complete");
		expect(out?.reason).toBe("seems done");
	});

	it("falls back to medium confidence when an unknown level is returned", () => {
		const out = parseCheckerJson('{"verdict":"complete","confidence":"unsure","reason":"x"}');
		expect(out?.confidence).toBe("medium");
	});

	it("returns undefined when verdict is invalid", () => {
		expect(
			parseCheckerJson('{"verdict":"maybe","confidence":"high","reason":"x"}'),
		).toBeUndefined();
	});

	it("returns undefined for non-JSON output", () => {
		expect(parseCheckerJson("the goal looks done to me")).toBeUndefined();
	});

	// Branch 82: parsed === null — JSON.parse("null") returns null, triggers continue
	it("returns undefined when JSON parses to null (line 82 branch)", () => {
		expect(parseCheckerJson("null")).toBeUndefined();
	});

	// Branch 92: typeof obj["reason"] === "string" is false — non-string reason defaults to ""
	it("defaults reason to empty string when reason is not a string (line 92 branch)", () => {
		const out = parseCheckerJson(
			'{"verdict":"complete","confidence":"high","reason":42}',
		);
		expect(out?.verdict).toBe("complete");
		expect(out?.reason).toBe(""); // non-string reason → empty string
	});
});

// --- orchestrator coverage with DI ------------------------------------------

/**
 * Build a fake ExtensionContext with just the surface the checker reads:
 * `model`, `modelRegistry.getApiKeyAndHeaders`. Anything else throws — that
 * way we catch accidental coupling early.
 */
function fakeCtx(opts: {
	model?: { reasoning?: boolean; id?: string };
	authOk?: boolean;
	apiKey?: string | undefined;
	headers?: Record<string, string> | undefined;
}) {
	const handler: ProxyHandler<object> = {
		get(_target, prop) {
			if (prop === "model") return "model" in opts ? opts.model : { reasoning: false, id: "fake" };
			if (prop === "modelRegistry") {
				return {
					getApiKeyAndHeaders: vi.fn(() => Promise.resolve({
						ok: opts.authOk ?? true,
						apiKey: opts.apiKey,
						headers: opts.headers,
					})),
				};
			}
			throw new Error(`unexpected ctx access: ${String(prop)}`);
		},
	};
	return new Proxy({}, handler) as never; // checker only reads what it needs
}

describe("createCompletionChecker.run", () => {
	it("calls completeSimple with system prompt + user prompt and parses the JSON verdict", async () => {
		const completeSimple = vi.fn(() => ({
			content: [
				{
					type: "text",
					text: '{"verdict":"complete","confidence":"high","reason":"agent stated 8"}',
				},
			],
		}));
		const getModel = vi.fn(() => undefined);

		const checker = createCompletionChecker({
			completeSimple: completeSimple as never,
			getModel: getModel as never,
			ctx: fakeCtx({ apiKey: "k" }),
			config: { modelOverride: () => undefined },
		});

		const ctrl = new AbortController();
		const result = await checker.run({
			objective: "calc 2+2",
			transcript: "ASSISTANT:\n4",
			signal: ctrl.signal,
		});

		expect(result?.verdict).toBe("complete");
		expect(result?.reason).toContain("agent stated");
		expect(completeSimple).toHaveBeenCalledOnce();
		const callArgs = (completeSimple.mock.calls as unknown[][])[0]!;
		// systemPrompt populated from CHECKER_SYSTEM_PROMPT
		expect((callArgs[1] as { systemPrompt?: string }).systemPrompt).toMatch(/JSON/);
		// User message contains the objective + transcript
		const messages = (callArgs[1] as { messages: Array<{ content: Array<{ text: string }> }> })
			.messages;
		expect(messages[0]?.content[0]?.text).toContain("calc 2+2");
		expect(messages[0]?.content[0]?.text).toContain("ASSISTANT:\n4");
	});

	it("uses an override model when modelOverride() returns a resolvable spec", async () => {
		const overrideModel = { reasoning: false, id: "haiku" };
		const completeSimple = vi.fn(() => ({
			content: [{ type: "text", text: '{"verdict":"incomplete","confidence":"medium","reason":""}' }],
		}));
		const getModel = vi.fn((_provider: string, _id: string) => overrideModel);

		const checker = createCompletionChecker({
			completeSimple: completeSimple as never,
			getModel: getModel as never,
			ctx: fakeCtx({ model: { reasoning: true, id: "opus" }, apiKey: "k" }),
			config: { modelOverride: () => "amazon-bedrock/global.anthropic.claude-haiku-4-5" },
		});

		const ctrl = new AbortController();
		await checker.run({ objective: "x", transcript: "y", signal: ctrl.signal });

		// getModel called with split spec
		expect(getModel).toHaveBeenCalledWith("amazon-bedrock", "global.anthropic.claude-haiku-4-5");
		// completeSimple called with override model, not ctx.model
		expect((completeSimple.mock.calls as unknown[][])[0]?.[0]).toBe(overrideModel);
	});

	it("does NOT pass apiKey when auth.apiKey is undefined (Bedrock SigV4)", async () => {
		// Regression: pi-session-recap's pattern bails when apiKey is missing,
		// which would render the checker unusable on Amazon Bedrock. Our
		// checker must proceed with auth.headers / signed-request flow.
		const completeSimple = vi.fn(() => ({
			content: [{ type: "text", text: '{"verdict":"complete","confidence":"high","reason":"x"}' }],
		}));
		const checker = createCompletionChecker({
			completeSimple: completeSimple as never,
			getModel: (() => undefined) as never,
			ctx: fakeCtx({ apiKey: undefined, headers: { "x-amz-date": "now" } }),
			config: { modelOverride: () => undefined },
		});

		const ctrl = new AbortController();
		const result = await checker.run({ objective: "x", transcript: "y", signal: ctrl.signal });

		expect(result?.verdict).toBe("complete");
		const opts = (completeSimple.mock.calls as unknown[][])[0]?.[2] as
			| Record<string, unknown>
			| undefined;
		expect(opts).toBeDefined();
		// apiKey omitted entirely (not passed as undefined under
		// exactOptionalPropertyTypes)
		expect("apiKey" in (opts ?? {})).toBe(false);
		// headers forwarded
		expect((opts as { headers: Record<string, string> }).headers["x-amz-date"]).toBe("now");
	});

	it("returns undefined when no model is available", async () => {
		const checker = createCompletionChecker({
			completeSimple: vi.fn() as never,
			getModel: (() => undefined) as never,
			ctx: fakeCtx({ model: undefined as never, apiKey: "k" }),
			config: { modelOverride: () => undefined },
		});
		const result = await checker.run({
			objective: "x",
			transcript: "y",
			signal: new AbortController().signal,
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined when auth resolution fails", async () => {
		const checker = createCompletionChecker({
			completeSimple: vi.fn() as never,
			getModel: (() => undefined) as never,
			ctx: fakeCtx({ authOk: false, apiKey: undefined }),
			config: { modelOverride: () => undefined },
		});
		const result = await checker.run({
			objective: "x",
			transcript: "y",
			signal: new AbortController().signal,
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined and does NOT call onError when aborted mid-flight", async () => {
		const onError = vi.fn();
		const completeSimple = vi.fn(() => {
			throw new Error("aborted");
		});
		const checker = createCompletionChecker({
			completeSimple: completeSimple,
			getModel: (() => undefined) as never,
			ctx: fakeCtx({ apiKey: "k" }),
			config: { modelOverride: () => undefined },
			onError,
		});

		const ctrl = new AbortController();
		ctrl.abort();
		const result = await checker.run({ objective: "x", transcript: "y", signal: ctrl.signal });

		expect(result).toBeUndefined();
		expect(onError).not.toHaveBeenCalled(); // cancelled, not a real error
	});

	it("calls onError and returns undefined for non-abort completeSimple errors", async () => {
		const onError = vi.fn();
		const completeSimple = vi.fn(() => {
			throw new Error("rate limited");
		});
		const checker = createCompletionChecker({
			completeSimple: completeSimple,
			getModel: (() => undefined) as never,
			ctx: fakeCtx({ apiKey: "k" }),
			config: { modelOverride: () => undefined },
			onError,
		});

		const result = await checker.run({
			objective: "x",
			transcript: "y",
			signal: new AbortController().signal,
		});
		expect(result).toBeUndefined();
		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls as unknown[][])[0]?.[0]).toBeInstanceOf(Error);
	});

	it("returns undefined when the model emits unparseable output", async () => {
		const completeSimple = vi.fn(() => ({
			content: [{ type: "text", text: "the goal looks complete to me" }],
		}));
		const checker = createCompletionChecker({
			completeSimple: completeSimple as never,
			getModel: (() => undefined) as never,
			ctx: fakeCtx({ apiKey: "k" }),
			config: { modelOverride: () => undefined },
		});

		const result = await checker.run({
			objective: "x",
			transcript: "y",
			signal: new AbortController().signal,
		});
		expect(result).toBeUndefined();
	});
});

  it("passes reasoning:'minimal' option when model.reasoning is true (line 178)", async () => {
    const reasoningModel = { reasoning: true, id: "claude-opus" };
    const capturedOptions: Array<Record<string, unknown>> = [];
    const completeSimple = vi.fn((_model: unknown, _config: unknown, opts: Record<string, unknown>) => {
      capturedOptions.push(opts ?? {});
      return {
        content: [{ type: "text", text: '{"verdict":"incomplete","confidence":"low","reason":""}' }],
      };
    });

    const checker = createCompletionChecker({
      completeSimple: completeSimple as never,
      getModel: (() => undefined) as never,
      ctx: fakeCtx({ model: reasoningModel, apiKey: "k" }),
      config: { modelOverride: () => undefined },
    });

    const ctrl = new AbortController();
    await checker.run({ objective: "x", transcript: "y", signal: ctrl.signal });

    // The reasoning option should have been set to "minimal"
    expect(capturedOptions[0]?.["reasoning"]).toBe("minimal");
  });

  it("returns undefined when signal is aborted after completeSimple resolves (line 199)", async () => {
    const ctrl = new AbortController();
    const completeSimple = vi.fn(() => {
      // Abort the signal mid-execution, just before the aborted check
      ctrl.abort();
      return {
        content: [{ type: "text", text: '{"verdict":"complete","confidence":"high","reason":"done"}' }],
      };
    });

    const checker = createCompletionChecker({
      completeSimple: completeSimple as never,
      getModel: (() => undefined) as never,
      ctx: fakeCtx({ apiKey: "k" }),
      config: { modelOverride: () => undefined },
    });

    const result = await checker.run({ objective: "x", transcript: "y", signal: ctrl.signal });
    // Signal was aborted after completeSimple, so checker returns undefined
    expect(result).toBeUndefined();
  });

  // Branch 146: splitModelSpec returns undefined for malformed spec → skip getModel, fall through to ctx.model
  it("falls back to ctx.model when override spec is malformed (line 146 branch)", async () => {
    const completeSimple = vi.fn(() => ({
      content: [{ type: "text", text: '{"verdict":"complete","confidence":"high","reason":"overrode"}' }],
    }));
    const checker = createCompletionChecker({
      completeSimple: completeSimple as never,
      getModel: (() => undefined) as never,
      ctx: fakeCtx({ model: { reasoning: false, id: "fallback" }, apiKey: "k" }),
      config: { modelOverride: () => "noslash" }, // no slash → splitModelSpec returns undefined
    });
    const result = await checker.run({ objective: "x", transcript: "y", signal: new AbortController().signal });
    expect(result?.verdict).toBe("complete");
    expect(result?.reason).toBe("overrode");
    // completeSimple was called with the fallback model (not getModel)
    expect(completeSimple).toHaveBeenCalledOnce();
  });

  // Branch 150: getModel returns undefined for valid spec → fall through to ctx.model
  it("falls back to ctx.model when getModel returns undefined for valid override spec (line 150 branch)", async () => {
    const completeSimple = vi.fn(() => ({
      content: [{ type: "text", text: '{"verdict":"complete","confidence":"high","reason":"fallback reason"}' }],
    }));
    const checker = createCompletionChecker({
      completeSimple: completeSimple as never,
      getModel: (() => undefined) as never, // valid spec but model not found
      ctx: fakeCtx({ model: { reasoning: false, id: "ctx-model" }, apiKey: "k" }),
      config: { modelOverride: () => "some-provider/some-model" }, // valid spec → splitModelSpec succeeds
    });
    const result = await checker.run({ objective: "x", transcript: "y", signal: new AbortController().signal });
    expect(result?.verdict).toBe("complete");
    expect(result?.reason).toBe("fallback reason");
    expect(completeSimple).toHaveBeenCalledOnce();
  });
