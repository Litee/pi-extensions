import { describe, expect, it } from "vitest";

import {
	buildRecentTranscript,
	buildStatusLine,
	extractText,
	extractToolCalls,
	firstLine,
	hasMeaningfulActivity,
	splitModel,
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
});

// ---------------------------------------------------------------------------
// buildRecentTranscript
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

describe("buildRecentTranscript", () => {
	it("returns only the segment from the last user message forward by default", () => {
		const out = buildRecentTranscript([
			userMsg("old question"),
			assistantMsg("old answer"),
			userMsg("new question"),
			assistantMsg("new answer"),
		]);
		expect(out).toContain("User: new question");
		expect(out).toContain("Assistant: new answer");
		expect(out).not.toContain("old question");
		expect(out).not.toContain("old answer");
	});

	it("returns the whole branch when fromLastUser=false (resume path)", () => {
		const out = buildRecentTranscript(
			[
				userMsg("first"),
				assistantMsg("second"),
				userMsg("third"),
				assistantMsg("fourth"),
			],
			false,
		);
		expect(out).toContain("User: first");
		expect(out).toContain("Assistant: second");
		expect(out).toContain("User: third");
		expect(out).toContain("Assistant: fourth");
	});

	it("falls back to the whole branch when there is no user message (fromLastUser=true)", () => {
		const out = buildRecentTranscript([
			assistantMsg("stray assistant"),
			assistantMsg("another one"),
		]);
		expect(out).toContain("stray assistant");
		expect(out).toContain("another one");
	});

	it("includes tool call bullet lines right after the assistant line", () => {
		const out = buildRecentTranscript([
			userMsg("q"),
			assistantMsg("working on it", [
				{ name: "bash", args: { cmd: "ls" } },
				{ name: "read", args: { path: "/tmp" } },
			]),
		]);
		const lines = out.split("\n");
		const aIdx = lines.findIndex((l) => l.startsWith("Assistant:"));
		expect(aIdx).toBeGreaterThanOrEqual(0);
		expect(lines[aIdx + 1]).toMatch(/^- bash\(/);
		expect(lines[aIdx + 2]).toMatch(/^- read\(/);
	});

	it("renders tool results using the toolName field", () => {
		const out = buildRecentTranscript([
			userMsg("q"),
			assistantMsg("call", [{ name: "bash" }]),
			toolResultMsg("bash", "hello output"),
		]);
		expect(out).toContain("Result(bash): hello output");
	});

	it("defaults tool result name to 'tool' when toolName is missing", () => {
		const out = buildRecentTranscript([
			userMsg("q"),
			{
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "body" }] },
			},
		]);
		expect(out).toContain("Result(tool): body");
	});

	it("truncates user/assistant text to 1200 chars", () => {
		const huge = "x".repeat(2000);
		const out = buildRecentTranscript([userMsg(huge), assistantMsg(huge)]);
		// Two lines: "User: <=1200 chars>" and "Assistant: <=1200 chars>".
		const userLine = out.split("\n").find((l) => l.startsWith("User: "))!;
		const asstLine = out.split("\n").find((l) => l.startsWith("Assistant: "))!;
		expect(userLine.length).toBeLessThanOrEqual("User: ".length + 1200);
		expect(asstLine.length).toBeLessThanOrEqual("Assistant: ".length + 1200);
	});

	it("truncates tool results to 400 chars", () => {
		const huge = "y".repeat(1000);
		const out = buildRecentTranscript([
			userMsg("q"),
			assistantMsg("a", [{ name: "bash" }]),
			toolResultMsg("bash", huge),
		]);
		const line = out.split("\n").find((l) => l.startsWith("Result(bash): "))!;
		expect(line.length).toBeLessThanOrEqual("Result(bash): ".length + 400);
	});

	it("skips entries with empty text", () => {
		const out = buildRecentTranscript([
			userMsg(""),
			assistantMsg("   "),
			userMsg("real"),
			assistantMsg("reply"),
		]);
		const lines = out.split("\n").filter(Boolean);
		expect(lines).toEqual(["User: real", "Assistant: reply"]);
	});

	it("ignores non-message entries", () => {
		const out = buildRecentTranscript([
			{ type: "thinking", message: { role: "assistant", content: "dropped" } },
			userMsg("q"),
			assistantMsg("a"),
		]);
		expect(out).not.toContain("dropped");
		expect(out).toContain("User: q");
	});

	it("ignores entries whose message has no role", () => {
		const out = buildRecentTranscript([
			userMsg("q"),
			{ type: "message", message: { content: [{ type: "text", text: "no-role" }] } },
			assistantMsg("a"),
		]);
		expect(out).not.toContain("no-role");
	});

	it("returns '' when there are no meaningful entries", () => {
		expect(buildRecentTranscript([])).toBe("");
		expect(buildRecentTranscript([userMsg("")])).toBe("");
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
});

// ---------------------------------------------------------------------------
// firstLine
// ---------------------------------------------------------------------------

describe("firstLine", () => {
	it("returns undefined for empty input", () => {
		expect(firstLine("")).toBeUndefined();
	});

	it("returns the string trimmed when it has no newlines", () => {
		expect(firstLine("  hello world  ")).toBe("hello world");
	});

	it("drops every line after the first, LF-separated", () => {
		expect(firstLine("first\nsecond\nthird")).toBe("first");
	});

	it("handles CRLF line endings", () => {
		expect(firstLine("first\r\nsecond")).toBe("first");
	});

	it("trims the first line", () => {
		expect(firstLine("   first line   \nsecond")).toBe("first line");
	});

	it("returns an empty string when the first line is whitespace only", () => {
		expect(firstLine("   \n\nreal")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// buildStatusLine (tracker issue #0004)
// ---------------------------------------------------------------------------

describe("buildStatusLine", () => {
	const base = {
		activeModelSpec: "anthropic/claude-sonnet-4-6",
		autoRecapEnabled: true,
		idleSeconds: 120,
		focusMinSeconds: 3 as number | null,
		disabledFlags: [] as ReadonlyArray<"--recap-disable" | "--recap-disable-focus">,
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
				"  Idle trigger:   120s after turn_end",
				"  Focus trigger:  enabled (min 3s away)",
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
				"  Idle trigger:   120s after turn_end",
				"  Focus trigger:  enabled (min 3s away)",
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
				"  Idle trigger:   120s after turn_end",
				"  Focus trigger:  enabled (min 3s away)",
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
				"  Idle trigger:   120s after turn_end",
				"  Focus trigger:  enabled (min 3s away)",
				"  Disabled flags: (none)",
			].join("\n"),
		);
	});

	it("renders `Auto-recap: disabled` and lists `--recap-disable` under Disabled flags", () => {
		const out = buildStatusLine({
			...base,
			override: null,
			autoRecapEnabled: false,
			disabledFlags: ["--recap-disable"],
		});
		expect(out).toContain("Auto-recap:     disabled");
		expect(out).toContain("Disabled flags: --recap-disable");
	});

	it("renders `Focus trigger: disabled` and lists `--recap-disable-focus` under Disabled flags", () => {
		const out = buildStatusLine({
			...base,
			override: null,
			focusMinSeconds: null,
			disabledFlags: ["--recap-disable-focus"],
		});
		expect(out).toContain("Focus trigger:  disabled");
		expect(out).toContain("Disabled flags: --recap-disable-focus");
	});

	it("surfaces custom idle and focus-min seconds verbatim", () => {
		const out = buildStatusLine({
			...base,
			override: null,
			idleSeconds: 45,
			focusMinSeconds: 7,
		});
		expect(out).toContain("Idle trigger:   45s after turn_end");
		expect(out).toContain("Focus trigger:  enabled (min 7s away)");
	});

	it("renders `(none)` in Disabled flags when nothing is disabled", () => {
		const out = buildStatusLine({ ...base, override: null });
		expect(out).toContain("Disabled flags: (none)");
	});

	it("joins multiple disabled flags with a comma in presentation order", () => {
		// Both flags active — they appear in registration order
		// (--recap-disable, then --recap-disable-focus) so a future refactor
		// can't re-order them silently.
		const out = buildStatusLine({
			...base,
			override: null,
			autoRecapEnabled: false,
			focusMinSeconds: null,
			disabledFlags: ["--recap-disable", "--recap-disable-focus"],
		});
		expect(out).toContain("Disabled flags: --recap-disable, --recap-disable-focus");
	});
});
