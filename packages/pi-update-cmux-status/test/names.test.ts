import { describe, expect, it, vi } from "vitest";

import {
	clipToLimit,
	generateNames,
	MAX_TAB_CHARS,
	MAX_WORKSPACE_CHARS,
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

	it("describes the input as a session summary, not the first user request", () => {
		expect(SUMMARY_SYSTEM_PROMPT).toMatch(/session/i);
		expect(SUMMARY_SYSTEM_PROMPT).toMatch(/recent user messages/i);
		expect(SUMMARY_SYSTEM_PROMPT).not.toMatch(/first user request/i);
	});

	it("instructs the model to prefer the most recent user messages on conflict", () => {
		expect(SUMMARY_SYSTEM_PROMPT).toMatch(/most recent/i);
	});

	it("specifies character limits (not word counts) for both fields", () => {
		expect(SUMMARY_SYSTEM_PROMPT).toContain(`up to ${MAX_TAB_CHARS} characters`);
		expect(SUMMARY_SYSTEM_PROMPT).toContain(`up to ${MAX_WORKSPACE_CHARS} characters`);
		// The old word-count rules are gone.
		expect(SUMMARY_SYSTEM_PROMPT).not.toMatch(/\d+-\d+\s+words/);
	});
});

// ---------------------------------------------------------------------------
// clipToLimit + parseNames enforcement of char caps
// ---------------------------------------------------------------------------

describe("clipToLimit", () => {
	it("returns the trimmed input when already within the cap", () => {
		expect(clipToLimit("  hi  ", 10)).toBe("hi");
		expect(clipToLimit("exactly10!", 10)).toBe("exactly10!");
	});

	it("prefers truncation at the last word boundary within the cap", () => {
		expect(clipToLimit("alpha beta gamma delta", 15)).toBe("alpha beta");
	});

	it("hard-cuts when the boundary would fall in the first 60% of the budget", () => {
		// "abcdefgh ijklm" — space at index 8, budget 10, 60% of 10 = 6,
		// 8 > 6 so word-boundary wins.
		expect(clipToLimit("abcdefgh ijklm", 10)).toBe("abcdefgh");
		// No space at all — hard cut.
		expect(clipToLimit("abcdefghijklmno", 10)).toBe("abcdefghij");
		// Space too early — hard cut.
		expect(clipToLimit("a bcdefghijklmno", 10)).toBe("a bcdefghi");
	});
});

describe("parseNames character-cap enforcement", () => {
	it("clips an over-long tab to MAX_TAB_CHARS", () => {
		const longTab = "Super Duper Ultra Mega Very Long Tab Title That Exceeds The Cap";
		const out = parseNames(`{"tab":"${longTab}","workspace":"Short"}`);
		expect(out).toBeDefined();
		expect(out!.tab.length).toBeLessThanOrEqual(MAX_TAB_CHARS);
		expect(longTab.startsWith(out!.tab)).toBe(true);
	});

	it("clips an over-long workspace to MAX_WORKSPACE_CHARS", () => {
		const longWs =
			"Super Duper Ultra Mega Very Long Workspace Title That Exceeds The Cap";
		const out = parseNames(`{"tab":"Short","workspace":"${longWs}"}`);
		expect(out).toBeDefined();
		expect(out!.workspace.length).toBeLessThanOrEqual(MAX_WORKSPACE_CHARS);
		expect(longWs.startsWith(out!.workspace)).toBe(true);
	});

	it("accepts realistic longer workspace names within the cap", () => {
		const out = parseNames(
			`{"tab":"Check SVC-API Video Search","workspace":"Debug OAuth Token Refresh Flow"}`,
		);
		expect(out).toEqual({
			tab: "Check SVC-API Video Search",
			workspace: "Debug OAuth Token Refresh Flow",
		});
	});

	it("fills missing field from the other, with the other's char cap applied", () => {
		const longWs =
			"Workspace-Only Name That Is Also Quite Long And Extends Past The Tab Cap";
		const out = parseNames(`{"workspace":"${longWs}"}`);
		expect(out).toBeDefined();
		expect(out!.workspace.length).toBeLessThanOrEqual(MAX_WORKSPACE_CHARS);
		expect(out!.tab.length).toBeLessThanOrEqual(MAX_TAB_CHARS);
		expect(longWs.startsWith(out!.tab)).toBe(true);
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

	it("keeps the *tail* of an oversized prompt (most recent user messages survive)", async () => {
		const completion = vi.fn(async () => undefined);
		const ctx = {
			model: { id: "fake" },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k", headers: {} })),
			},
		} as never;
		const padding = "OLD-".repeat(600); // 2400 chars — will get trimmed
		const tail = "THIS-IS-THE-NEWEST-USER-MESSAGE";
		const joined = `${padding}${tail}`;
		await generateNames(ctx, joined, {}, completion as never);
		const [, prompt] = completion.mock.calls[0] as unknown as [unknown, string, unknown, unknown];
		expect(prompt.length).toBe(2000);
		expect(prompt.endsWith(tail)).toBe(true);
		expect(prompt.startsWith("OLD-")).toBe(false); // head was dropped
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
