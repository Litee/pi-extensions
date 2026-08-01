import { describe, expect, it } from "vitest";

import {
	buildStatusLine,
	buildTranscript,
	extractText,
	extractToolCalls,
	hasMeaningfulActivity,
	recapStateKey,
	splitModel,
	TRANSCRIPT_CHAR_CAP,
	wrapText,
	type Entry,
} from "../src/helpers.js";

// ---------------------------------------------------------------------------
// splitModel
// ---------------------------------------------------------------------------

describe("splitModel", () => {
	it("splits provider and id on the first slash", () => {
		expect(splitModel("anthropic/claude-sonnet-4-6")).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
		});
	});

	it("keeps every slash after the first in the id", () => {
		expect(splitModel("local/owner/model-name")).toEqual({
			provider: "local",
			id: "owner/model-name",
		});
	});

	it("returns undefined when there is no slash", () => {
		expect(splitModel("not-a-spec")).toBeUndefined();
	});

	it("returns undefined when the provider is empty (leading slash)", () => {
		expect(splitModel("/foo")).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(splitModel("")).toBeUndefined();
	});

	it("allows an empty id after the slash (non-useful but non-crashing)", () => {
		expect(splitModel("anthropic/")).toEqual({ provider: "anthropic", id: "" });
	});
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
	it("returns the string verbatim when content is a string", () => {
		expect(extractText("hello world")).toBe("hello world");
	});

	it("joins every text block in an array with newlines", () => {
		expect(
			extractText([
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			]),
		).toBe("first\nsecond");
	});

	it("ignores non-text blocks in a content array", () => {
		expect(
			extractText([
				{ type: "text", text: "keep" },
				{ type: "toolCall", name: "bash", arguments: {} },
				{ type: "image", text: "ignored" },
			]),
		).toBe("keep");
	});

	it("skips entries missing the .text field", () => {
		expect(
			extractText([
				{ type: "text", text: "ok" },
				{ type: "text" }, // no text
				{ type: "text", text: 42 as unknown as string }, // not a string
			]),
		).toBe("ok");
	});

	it("returns '' when content is null / undefined / a non-array object", () => {
		expect(extractText(null)).toBe("");
		expect(extractText(undefined)).toBe("");
		expect(extractText({ type: "text", text: "no" })).toBe("");
	});

	it("returns '' for an empty array", () => {
		expect(extractText([])).toBe("");
	});

	it("skips non-object truthy entries (e.g. a string) in the content array without crashing", () => {
		expect(
			extractText([
				"hello", // non-object truthy entry exercises the `typeof part !== 'object'` branch
				{ type: "text", text: "kept" },
			]),
		).toBe("kept");
	});
});

// ---------------------------------------------------------------------------
// extractToolCalls
// ---------------------------------------------------------------------------

describe("extractToolCalls", () => {
	it("extracts one bullet per toolCall block", () => {
		const calls = extractToolCalls([
			{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
			{ type: "toolCall", name: "read", arguments: { path: "/tmp/x" } },
		]);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatch(/^- bash\(\{.*cmd.*ls.*\}\)$/);
		expect(calls[1]).toMatch(/^- read\(\{.*path.*\/tmp\/x.*\}\)$/);
	});

	it("serialises arguments via JSON.stringify truncated at 280 chars", () => {
		const huge = "x".repeat(1000);
		const calls = extractToolCalls([
			{ type: "toolCall", name: "big", arguments: { payload: huge } },
		]);
		expect(calls).toHaveLength(1);
		const line = calls[0]!;
		// Body inside the parens is JSON stringified, sliced to 280 chars.
		const paren = line.slice(line.indexOf("(") + 1, line.lastIndexOf(")"));
		expect(paren.length).toBeLessThanOrEqual(280);
	});

	it("treats a missing arguments field as empty object", () => {
		expect(extractToolCalls([{ type: "toolCall", name: "noop" }])).toEqual(["- noop({})"]);
	});

	it("skips non-toolCall entries", () => {
		expect(
			extractToolCalls([
				{ type: "text", text: "hi" },
				{ type: "toolCall", name: "bash", arguments: {} },
			]),
		).toEqual(["- bash({})"]);
	});

	it("skips entries whose name is not a string", () => {
		expect(
			extractToolCalls([
				{ type: "toolCall", name: 42 as unknown as string, arguments: {} },
				{ type: "toolCall", arguments: {} }, // no name
			]),
		).toEqual([]);
	});

	it("returns [] for non-arrays and empty arrays", () => {
		expect(extractToolCalls(null)).toEqual([]);
		expect(extractToolCalls("nope")).toEqual([]);
		expect(extractToolCalls([])).toEqual([]);
	});

	it("skips non-object truthy entries (e.g. a string) in the content array without crashing", () => {
		expect(
			extractToolCalls([
				"hello", // non-object truthy entry exercises the `typeof part !== 'object'` branch
				{ type: "toolCall", name: "bash", arguments: {} },
			]),
		).toEqual(["- bash({})"]);
	});
});

// ---------------------------------------------------------------------------
// buildTranscript (two-tier)
// ---------------------------------------------------------------------------

function userMsg(text: string): Entry {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantMsg(text: string, toolCalls: Array<{ name: string; args?: Record<string, unknown> }> = []): Entry {
	const content: unknown[] = text ? [{ type: "text", text }] : [];
	for (const tc of toolCalls) {
		content.push({ type: "toolCall", name: tc.name, arguments: tc.args ?? {} });
	}
	return { type: "message", message: { role: "assistant", content } };
}

function toolResultMsg(toolName: string, text: string): Entry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName,
			content: [{ type: "text", text }],
		},
	};
}

describe("buildTranscript — tier 1a (compaction / branch summary)", () => {
	it("puts the most recent compaction summary at the top", () => {
		const out = buildTranscript([
			{ type: "compaction", summary: "Building a parser." },
			userMsg("q"),
			assistantMsg("a"),
		]);
		expect(out.startsWith("Session summary so far: Building a parser.")).toBe(true);
	});

	it("caps the compaction summary at 600 chars", () => {
		const out = buildTranscript([
			{ type: "compaction", summary: "x".repeat(2000) },
			userMsg("q"),
			assistantMsg("a"),
		]);
		expect(out).toContain(`Session summary so far: ${"x".repeat(600)}`);
		expect(out.includes("x".repeat(601))).toBe(false);
	});

	it("ignores compaction entries without a usable summary", () => {
		const out = buildTranscript([
			{ type: "compaction" }, // no summary field
			{ type: "compaction", summary: "   " }, // whitespace-only
			userMsg("q"),
			assistantMsg("a"),
		]);
		expect(out).not.toContain("Session summary so far:");
	});

	it("uses only the most recent compaction / branch_summary entry", () => {
		const out = buildTranscript([
			{ type: "compaction", summary: "older summary" },
			{ type: "branch_summary", summary: "newer summary" },
			userMsg("q"),
			assistantMsg("a"),
		]);
		expect(out).toContain("Session summary so far: newer summary");
		expect(out).not.toContain("older summary");
	});
});

describe("buildTranscript — tier 1b (earlier user prompts)", () => {
	it("lists the earlier user prompts oldest → newest under a header, excluding the latest one", () => {
		const out = buildTranscript([
			userMsg("first task"),
			assistantMsg("a1"),
			userMsg("second task"),
			assistantMsg("a2"),
			userMsg("third task"),
			assistantMsg("a3"),
		]);
		const lines = out.split("\n");
		const headerIdx = lines.findIndex((l) => l.startsWith("Earlier user prompts"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		const bullets = lines.slice(headerIdx + 1).filter((l) => l.startsWith("- "));
		expect(bullets).toEqual(["- first task", "- second task"]);
		// The latest user prompt belongs to tier 2, not the framing block.
		expect(bullets.join("\n")).not.toContain("third task");
	});

	it("keeps at most 4 earlier prompts", () => {
		const entries: Entry[] = [];
		for (let i = 0; i < 7; i++) entries.push(userMsg(`prompt ${i}`), assistantMsg(`answer ${i}`));
		const out = buildTranscript(entries);
		const lines = out.split("\n");
		const headerIdx = lines.findIndex((l) => l.startsWith("Earlier user prompts"));
		const bullets = lines.slice(headerIdx + 1).filter((l) => l.startsWith("- "));
		expect(bullets).toHaveLength(4);
		expect(bullets[0]).toContain("prompt 2"); // oldest of the retained window
		expect(bullets[3]).toContain("prompt 5");
	});

	it("caps each earlier prompt at 300 chars", () => {
		const out = buildTranscript([
			userMsg(`huge ${"x".repeat(500)}`),
			userMsg("latest"),
			assistantMsg("a"),
		]);
		const bullet = out.split("\n").find((l) => l.startsWith("- "))!;
		expect(bullet.length).toBeLessThanOrEqual("- ".length + 300);
	});

	it("omits the framing block when there is at most one user message", () => {
		const out = buildTranscript([userMsg("only task"), assistantMsg("a")]);
		expect(out).not.toContain("Earlier user prompts");
	});

	it("skips empty earlier prompts", () => {
		const out = buildTranscript([
			userMsg(""),
			userMsg("framing task"),
			userMsg("latest task"),
			assistantMsg("a"),
		]);
		const bullets = out.split("\n").filter((l) => l.startsWith("- "));
		expect(bullets).toEqual(["- framing task"]);
	});
});

describe("buildTranscript — tier 2 (recent detail)", () => {
	it("renders the recent activity since the last user message (inclusive)", () => {
		const out = buildTranscript([
			userMsg("old question"),
			assistantMsg("old answer"),
			userMsg("recent question"),
			assistantMsg("recent answer"),
		]);
		expect(out).toContain("Recent activity (since the user's last message):");
		expect(out).toContain("User: recent question");
		expect(out).toContain("Assistant: recent answer");
		// Tier 2 starts at the last user message — pre-last-user assistant
		// output must not appear in the detail block.
		expect(out).not.toContain("old answer");
	});

	it("falls back to the whole branch when there is no user message", () => {
		const out = buildTranscript([assistantMsg("stray assistant"), assistantMsg("more")]);
		expect(out).not.toContain("Earlier user prompts");
		expect(out).toContain("Recent activity (since the user's last message):");
		expect(out).toContain("Assistant: stray assistant");
	});

	it("includes tool call bullet lines and tool results in the detail block", () => {
		const out = buildTranscript([
			userMsg("q"),
			assistantMsg("working on it", [
				{ name: "bash", args: { cmd: "ls" } },
				{ name: "read", args: { path: "/tmp" } },
			]),
			toolResultMsg("bash", "hello output"),
		]);
		expect(out).toMatch(/- bash\(/);
		expect(out).toMatch(/- read\(/);
		expect(out).toContain("Result(bash): hello output");
	});

	it("defaults tool result name to 'tool' when toolName is missing", () => {
		const out = buildTranscript([
			userMsg("q"),
			{
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "body" }] },
			},
		]);
		expect(out).toContain("Result(tool): body");
	});

	it("truncates user/assistant text to 1200 chars and tool results to 400 chars", () => {
		const huge = "y".repeat(2000);
		const out = buildTranscript([
			userMsg(huge),
			assistantMsg(huge),
			toolResultMsg("bash", huge),
		]);
		const userLine = out.split("\n").find((l) => l.startsWith("User: "))!;
		const asstLine = out.split("\n").find((l) => l.startsWith("Assistant: "))!;
		const resultLine = out.split("\n").find((l) => l.startsWith("Result(bash): "))!;
		expect(userLine.length).toBeLessThanOrEqual("User: ".length + 1200);
		expect(asstLine.length).toBeLessThanOrEqual("Assistant: ".length + 1200);
		expect(resultLine.length).toBeLessThanOrEqual("Result(bash): ".length + 400);
	});

	it("skips entries with empty text", () => {
		const out = buildTranscript([
			userMsg(""),
			assistantMsg("   "),
			userMsg("real"),
			assistantMsg("reply"),
		]);
		expect(out).toContain("User: real");
		expect(out).toContain("Assistant: reply");
		expect(out).not.toMatch(/^User: $/m);
		expect(out).not.toMatch(/^Assistant: $/m);
	});

	it("ignores non-message entries and entries without a role", () => {
		const out = buildTranscript([
			{ type: "thinking", message: { role: "assistant", content: "dropped" } },
			userMsg("q"),
			{ type: "message", message: { content: [{ type: "text", text: "no-role" }] } },
			assistantMsg("a"),
		]);
		expect(out).not.toContain("dropped");
		expect(out).not.toContain("no-role");
	});

	it("returns '' when there are no meaningful entries", () => {
		expect(buildTranscript([])).toBe("");
		expect(buildTranscript([userMsg("")])).toBe("");
	});

	it("omits the Assistant: line when the assistant message has only tool calls", () => {
		const out = buildTranscript([userMsg("do it"), assistantMsg("", [{ name: "bash" }])]);
		expect(out).not.toMatch(/^Assistant:/m);
		expect(out).toContain("- bash(");
	});
});

// ---------------------------------------------------------------------------
// recapStateKey
// ---------------------------------------------------------------------------

describe("recapStateKey", () => {
	it("is deterministic for identical transcripts", () => {
		expect(recapStateKey("some transcript")).toBe(recapStateKey("some transcript"));
	});

	it("differs for different transcripts", () => {
		expect(recapStateKey("alpha")).not.toBe(recapStateKey("beta"));
	});

	it("hashes only the capped prefix — content beyond the cap does not change the key", () => {
		const base = "x".repeat(TRANSCRIPT_CHAR_CAP);
		expect(recapStateKey(base)).toBe(recapStateKey(`${base}trailing changes`));
		// A change within the capped prefix must still change the key.
		expect(recapStateKey(base)).not.toBe(recapStateKey(`${base.slice(0, -1)}y`));
	});

	it("produces a 64-char hex digest", () => {
		expect(recapStateKey("anything")).toMatch(/^[0-9a-f]{64}$/);
	});
});

// ---------------------------------------------------------------------------
// wrapText
// ---------------------------------------------------------------------------

describe("wrapText", () => {
	it("returns a single line for short input", () => {
		expect(wrapText("hello world", 100, 4)).toEqual(["hello world"]);
	});

	it("word-wraps long text at the width", () => {
		// "aaa bbb ccc" is 11 chars > 10 → first line ends at "aaa bbb".
		expect(wrapText("aaa bbb ccc ddd", 10, 4)).toEqual(["aaa bbb", "ccc ddd"]);
	});

	it("truncates beyond maxLines with ' …' appended to the last kept line", () => {
		const text = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const lines = wrapText(text, 10, 3);
		expect(lines).toHaveLength(3);
		expect(lines[2]!.endsWith(" …")).toBe(true);
	});

	it("does not truncate when the line count is exactly maxLines", () => {
		expect(wrapText("aaa bbb ccc", 5, 3)).toEqual(["aaa", "bbb", "ccc"]);
	});

	it("keeps a single over-width word on its own line", () => {
		const word = "x".repeat(50);
		expect(wrapText(word, 10, 4)).toEqual([word]);
	});

	it("collapses repeated whitespace", () => {
		expect(wrapText("a   b\nc", 100, 4)).toEqual(["a b c"]);
	});

	it("returns an empty array for empty / whitespace-only input", () => {
		expect(wrapText("", 100, 4)).toEqual([]);
		expect(wrapText("   \n ", 100, 4)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// hasMeaningfulActivity
// ---------------------------------------------------------------------------

describe("hasMeaningfulActivity", () => {
	it("returns false for an empty branch", () => {
		expect(hasMeaningfulActivity([])).toBe(false);
	});

	it("returns false when the only activity is a user message", () => {
		expect(hasMeaningfulActivity([userMsg("just asked")])).toBe(false);
	});

	it("returns false when the assistant has only spoken a few words", () => {
		expect(hasMeaningfulActivity([userMsg("q"), assistantMsg("okay sure done")])).toBe(false);
	});

	it("returns true when assistant has produced >= 30 words since the last user turn", () => {
		const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
		expect(hasMeaningfulActivity([userMsg("q"), assistantMsg(words)])).toBe(true);
	});

	it("returns true when the assistant made at least one tool call, even with no text", () => {
		expect(
			hasMeaningfulActivity([userMsg("q"), assistantMsg("", [{ name: "bash" }])]),
		).toBe(true);
	});

	it("ignores activity that precedes the last user message", () => {
		const words = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
		// Lots of activity BEFORE the last user message, nothing after.
		expect(
			hasMeaningfulActivity([
				userMsg("old"),
				assistantMsg(words, [{ name: "bash" }]),
				userMsg("new"), // nothing after this
			]),
		).toBe(false);
	});

	it("does not count tool-result or user text as assistant work", () => {
		const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
		expect(
			hasMeaningfulActivity([
				userMsg("q"),
				toolResultMsg("bash", words), // tool result, not assistant
			]),
		).toBe(false);
	});

	it("treats a branch with no user messages as 'tail is the whole branch'", () => {
		// No user messages at all; tail = entries.
		expect(
			hasMeaningfulActivity([assistantMsg("hi", [{ name: "bash" }])]),
		).toBe(true);
	});

	it("skips non-message entries in the tail without counting them as assistant activity", () => {
		// A non-message entry (e.g. a session event) must be skipped by the
		// `if (e.type !== 'message') continue` guard.
		expect(
			hasMeaningfulActivity([
				userMsg("q"),
				{ type: "session_start" }, // non-message entry
			]),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildStatusLine (tracker issue #0004)
// ---------------------------------------------------------------------------

describe("buildStatusLine", () => {
	const base = {
		activeModelSpec: "anthropic/claude-sonnet-4-6",
		autoRecapEnabled: true,
		idleSeconds: 300,
		awaySeconds: 90 as number | null,
		disabledFlags: [] as ReadonlyArray<"--recap-disable-focus">,
		triggerCount: 0,
		tokenUsage: null,
	};

	it("shows `(from --recap-model)` when the CLI override resolves", () => {
		expect(
			buildStatusLine({
				...base,
				override: {
					source: "--recap-model",
					spec: "amazon-bedrock/global.anthropic.claude-haiku-4-5",
					resolved: true,
				},
			}),
		).toBe(
			[
				"recap status",
				"  Model:          amazon-bedrock/global.anthropic.claude-haiku-4-5  (from --recap-model)",
				"  Auto-recap:     enabled",
				"  Idle trigger:   300s after turn_end",
				"  Away trigger:   enabled (90s blur)",
				"  Triggers:       0 (this session)",
				"  Disabled flags: (none)",
			].join("\n"),
		);
	});

	it("shows `(from pi-session-recap.json)` when the config-file override resolves", () => {
		expect(
			buildStatusLine({
				...base,
				override: {
					source: "pi-session-recap.json",
					spec: "anthropic/claude-haiku-4-5",
					resolved: true,
				},
			}),
		).toBe(
			[
				"recap status",
				"  Model:          anthropic/claude-haiku-4-5  (from pi-session-recap.json)",
				"  Auto-recap:     enabled",
				"  Idle trigger:   300s after turn_end",
				"  Away trigger:   enabled (90s blur)",
				"  Triggers:       0 (this session)",
				"  Disabled flags: (none)",
			].join("\n"),
		);
	});

	it("shows the active model with `(active model)` when there is no override", () => {
		expect(buildStatusLine({ ...base, override: null })).toBe(
			[
				"recap status",
				"  Model:          anthropic/claude-sonnet-4-6  (active model)",
				"  Auto-recap:     enabled",
				"  Idle trigger:   300s after turn_end",
				"  Away trigger:   enabled (90s blur)",
				"  Triggers:       0 (this session)",
				"  Disabled flags: (none)",
			].join("\n"),
		);
	});

	it("surfaces the unresolved override and a fallback active-model line when the override does not resolve", () => {
		expect(
			buildStatusLine({
				...base,
				override: {
					source: "--recap-model",
					spec: "bogus-provider/does-not-exist",
					resolved: false,
				},
			}),
		).toBe(
			[
				"recap status",
				"  Model:          bogus-provider/does-not-exist  (override failed to resolve, falling back to active)",
				"                  anthropic/claude-sonnet-4-6  (active model)",
				"  Auto-recap:     enabled",
				"  Idle trigger:   300s after turn_end",
				"  Away trigger:   enabled (90s blur)",
				"  Triggers:       0 (this session)",
				"  Disabled flags: (none)",
			].join("\n"),
		);
	});

	it("renders `Auto-recap: disabled` when autoRecapEnabled is false", () => {
		const out = buildStatusLine({
			...base,
			override: null,
			autoRecapEnabled: false,
		});
		expect(out).toContain("Auto-recap:     disabled");
	});

	it("renders `Away trigger: disabled` and lists `--recap-disable-focus` under Disabled flags", () => {
		const out = buildStatusLine({
			...base,
			override: null,
			awaySeconds: null,
			disabledFlags: ["--recap-disable-focus"],
		});
		expect(out).toContain("Away trigger:   disabled");
		expect(out).toContain("Disabled flags: --recap-disable-focus");
	});

	it("surfaces custom idle and away seconds verbatim", () => {
		const out = buildStatusLine({
			...base,
			override: null,
			idleSeconds: 45,
			awaySeconds: 7,
		});
		expect(out).toContain("Idle trigger:   45s after turn_end");
		expect(out).toContain("Away trigger:   enabled (7s blur)");
	});

	it("renders `(none)` in Disabled flags when nothing is disabled", () => {
		const out = buildStatusLine({ ...base, override: null });
		expect(out).toContain("Disabled flags: (none)");
	});

	it("joins multiple disabled flags with a comma in presentation order", () => {
		// Only --recap-disable-focus can appear in the disabled flags list now
		const out = buildStatusLine({
			...base,
			override: null,
			autoRecapEnabled: false,
			awaySeconds: null,
			disabledFlags: ["--recap-disable-focus"],
		});
		expect(out).toContain("Disabled flags: --recap-disable-focus");
	});
	it("shows Triggers: 0 when triggerCount is 0", () => {
		const out = buildStatusLine({ ...base, override: null, triggerCount: 0, tokenUsage: null });
		expect(out).toContain("Triggers:       0 (this session)");
	});

	it("shows Triggers: N for non-zero triggerCount", () => {
		const out = buildStatusLine({ ...base, override: null, triggerCount: 7, tokenUsage: null });
		expect(out).toContain("Triggers:       7 (this session)");
	});

	it("omits Token usage line when tokenUsage is null", () => {
		const out = buildStatusLine({ ...base, override: null, triggerCount: 0, tokenUsage: null });
		expect(out).not.toContain("Token usage:");
	});

	it("shows Token usage with toLocaleString formatting when tokenUsage is non-null", () => {
		const out = buildStatusLine({ ...base, override: null, triggerCount: 3, tokenUsage: { input: 12450, output: 3820 } });
		expect(out).toContain("Token usage:");
		expect(out).toContain("in");
		expect(out).toContain("out");
		expect(out).toContain("(this session)");
	});

	it("places Triggers and Token usage between Away trigger and Disabled flags", () => {
		const out = buildStatusLine({ ...base, override: null, triggerCount: 2, tokenUsage: { input: 1000, output: 500 } });
		const lines = out.split("\n");
		const awayIdx = lines.findIndex((l) => l.includes("Away trigger:"));
		const triggersIdx = lines.findIndex((l) => l.includes("Triggers:"));
		const tokenIdx = lines.findIndex((l) => l.includes("Token usage:"));
		const flagsIdx = lines.findIndex((l) => l.includes("Disabled flags:"));
		expect(awayIdx).toBeLessThan(triggersIdx);
		expect(triggersIdx).toBeLessThan(tokenIdx);
		expect(tokenIdx).toBeLessThan(flagsIdx);
	});
});
