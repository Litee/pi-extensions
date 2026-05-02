import { describe, expect, it, vi } from "vitest";

import {
	generateNames,
	parseNames,
	resolveSummaryModel,
	SUMMARY_SYSTEM_PROMPT,
} from "../src/names.js";

// ---------------------------------------------------------------------------
// parseNames — pure JSON extraction
// ---------------------------------------------------------------------------

describe("parseNames", () => {
	it("returns undefined for null / empty input", () => {
		expect(parseNames(null)).toBeUndefined();
		expect(parseNames(undefined)).toBeUndefined();
		expect(parseNames("")).toBeUndefined();
	});

	it("returns undefined when no JSON object is present", () => {
		expect(parseNames("nope")).toBeUndefined();
	});

	it("parses a clean JSON object", () => {
		expect(parseNames('{"tab":"Add Skill","workspace":"Pi Extensions"}')).toEqual({
			tab: "Add Skill",
			workspace: "Pi Extensions",
		});
	});

	it("trims whitespace in tab / workspace fields", () => {
		expect(parseNames('{"tab":"  A  ","workspace":"  B  "}')).toEqual({
			tab: "A",
			workspace: "B",
		});
	});

	it("tolerates surrounding prose around the JSON", () => {
		const raw = 'Sure! Here is the JSON:\n{"tab":"Debug Flaky Test","workspace":"QA"}\nLet me know if you need anything else.';
		expect(parseNames(raw)).toEqual({
			tab: "Debug Flaky Test",
			workspace: "QA",
		});
	});

	it("fills workspace from tab when workspace is missing", () => {
		expect(parseNames('{"tab":"Chat"}')).toEqual({ tab: "Chat", workspace: "Chat" });
	});

	it("fills tab from workspace when tab is missing", () => {
		expect(parseNames('{"workspace":"Chat"}')).toEqual({
			tab: "Chat",
			workspace: "Chat",
		});
	});

	it("returns undefined when both fields are empty / missing", () => {
		expect(parseNames("{}")).toBeUndefined();
		expect(parseNames('{"tab":"","workspace":""}')).toBeUndefined();
	});

	it("returns undefined when JSON is malformed", () => {
		expect(parseNames('{"tab":"a",}')).toBeUndefined();
	});

	it("ignores non-string tab / workspace values", () => {
		expect(parseNames('{"tab":123,"workspace":null}')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// SUMMARY_SYSTEM_PROMPT — frozen contract
// ---------------------------------------------------------------------------

describe("SUMMARY_SYSTEM_PROMPT", () => {
	it("demands the exact output shape in its first paragraph", () => {
		expect(SUMMARY_SYSTEM_PROMPT).toMatch(/\{"tab":"\.\.\.","workspace":"\.\.\."\}/);
	});

	it("documents the tab and workspace constraints", () => {
		expect(SUMMARY_SYSTEM_PROMPT).toMatch(/"tab"/);
		expect(SUMMARY_SYSTEM_PROMPT).toMatch(/"workspace"/);
		expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Title Case/);
	});
});

// ---------------------------------------------------------------------------
// resolveSummaryModel — override vs session fallback
// ---------------------------------------------------------------------------

describe("resolveSummaryModel", () => {
	it("returns ctx.model when no env override is set", () => {
		const fakeModel = { id: "fake" } as never;
		const ctx = { model: fakeModel };
		expect(resolveSummaryModel(ctx, {})).toBe(fakeModel);
	});

	it("returns undefined when neither override nor ctx.model is usable", () => {
		expect(resolveSummaryModel({ model: undefined } as never, {})).toBeUndefined();
	});

	it("falls back to ctx.model when override provider is unknown", () => {
		// An override with an unknown provider makes getModel throw / return
		// nothing; we expect the session model as fallback.
		const fakeModel = { id: "session" } as never;
		const ctx = { model: fakeModel };
		expect(
			resolveSummaryModel(ctx, {
				PI_CMUX_SUMMARY_MODEL: "totally-made-up-provider:foo",
			}),
		).toBe(fakeModel);
	});
});

// ---------------------------------------------------------------------------
// generateNames — auth / model-missing short-circuits (no network)
// ---------------------------------------------------------------------------

describe("generateNames (short-circuit paths)", () => {
	it("returns undefined when ctx.model is absent and no override is set", async () => {
		const ctx = {
			model: undefined,
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k", headers: {} })),
			},
		} as never;
		expect(await generateNames(ctx, "first prompt", {})).toBeUndefined();
	});

	it("returns undefined when modelRegistry throws", async () => {
		const ctx = {
			model: { id: "fake" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => {
					throw new Error("boom");
				}),
			},
		} as never;
		expect(await generateNames(ctx, "first prompt", {})).toBeUndefined();
	});

	it("returns undefined when auth.ok is false", async () => {
		const ctx = {
			model: { id: "fake" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: false })),
			},
		} as never;
		expect(await generateNames(ctx, "first prompt", {})).toBeUndefined();
	});

	it("invokes the injected completion hook with the correct prompt + auth + system prompt", async () => {
		const completion = vi.fn(async () => '{"tab":"T","workspace":"W"}');
		const ctx = {
			model: { id: "fake" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({
					ok: true,
					apiKey: "api-key-123",
					headers: { "x-test": "1" },
				})),
			},
		} as never;

		const out = await generateNames(ctx, "first prompt", {}, completion as never);
		expect(out).toEqual({ tab: "T", workspace: "W" });
		expect(completion).toHaveBeenCalledTimes(1);
		const [model, prompt, auth, opts] = completion.mock.calls[0] as unknown as [
			unknown,
			string,
			{ apiKey?: string; headers?: Record<string, string> },
			{ systemPrompt: string; maxTokens: number },
		];
		expect(model).toEqual({ id: "fake" });
		expect(prompt).toBe("first prompt");
		expect(auth).toEqual({ apiKey: "api-key-123", headers: { "x-test": "1" } });
		expect(opts.systemPrompt).toMatch(/cmux terminal tabs/);
		expect(opts.maxTokens).toBeGreaterThan(0);
	});

	it("caps the prompt at MAX_PROMPT_CHARS before sending it to the completion", async () => {
		const completion = vi.fn(async () => undefined);
		const ctx = {
			model: { id: "fake" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k", headers: {} })),
			},
		} as never;
		const huge = "x".repeat(5000);
		await generateNames(ctx, huge, {}, completion as never);
		const [, prompt] = completion.mock.calls[0] as unknown as [unknown, string, unknown, unknown];
		expect(prompt.length).toBe(2000);
	});

	it("returns undefined when the completion returns undefined", async () => {
		const completion = vi.fn(async () => undefined);
		const ctx = {
			model: { id: "fake" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k", headers: {} })),
			},
		} as never;
		expect(await generateNames(ctx, "p", {}, completion as never)).toBeUndefined();
	});

	it("returns undefined when the completion returns unparseable text", async () => {
		const completion = vi.fn(async () => "not json");
		const ctx = {
			model: { id: "fake" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k", headers: {} })),
			},
		} as never;
		expect(await generateNames(ctx, "p", {}, completion as never)).toBeUndefined();
	});
});
