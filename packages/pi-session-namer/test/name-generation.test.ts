import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildTranscript, generateSessionName, parseName, type Entry } from "../src/name-generation.js";

// ---------------------------------------------------------------------------
// buildTranscript
// ---------------------------------------------------------------------------

describe("buildTranscript", () => {
	it("returns empty string for empty entries", () => {
		expect(buildTranscript([])).toBe("");
	});

	it("includes user and assistant text", () => {
		const entries: Entry[] = [
			{ type: "message", message: { role: "user", content: "hello" } },
			{ type: "message", message: { role: "assistant", content: "hi there" } },
		];
		const result = buildTranscript(entries);
		expect(result).toContain("User: hello");
		expect(result).toContain("Assistant: hi there");
	});

	it("includes tool calls", () => {
		const entries: Entry[] = [
			{ type: "message", message: { role: "user", content: "read a file" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "reading file" },
						{ type: "toolCall", name: "read", arguments: { path: "/foo/bar.ts" } },
					],
				},
			},
		];
		const result = buildTranscript(entries);
		expect(result).toContain("User: read a file");
		expect(result).toContain("read({\"path\":\"/foo/bar.ts\"})");
	});

	it("includes tool results", () => {
		const entries: Entry[] = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: "file contents here",
					toolName: "read",
				},
			},
		];
		const result = buildTranscript(entries);
		expect(result).toContain("Result(read): file contents here");
	});

	it("truncates long text to 5K", () => {
		const longText = "x".repeat(6000);
		const entries: Entry[] = [
			{ type: "message", message: { role: "user", content: longText } },
		];
		const result = buildTranscript(entries);
		expect(result).toContain("User: ");
		expect(result.length).toBeLessThan(6000); // truncated to 5K
	});

	it("includes first 3 and last 3 messages", () => {
		const entries: Entry[] = [
			{ type: "message", message: { role: "user", content: "msg1" } },
			{ type: "message", message: { role: "assistant", content: "reply1" } },
			{ type: "message", message: { role: "user", content: "msg2" } },
			{ type: "message", message: { role: "assistant", content: "reply2" } },
			{ type: "message", message: { role: "user", content: "msg3" } },
			{ type: "message", message: { role: "assistant", content: "reply3" } },
			{ type: "message", message: { role: "user", content: "msg4" } },
			{ type: "message", message: { role: "assistant", content: "reply4" } },
		];
		const result = buildTranscript(entries);
		// First 3: msg1, reply1, msg2
		expect(result).toContain("User: msg1");
		expect(result).toContain("reply1");
		expect(result).toContain("User: msg2");
		// Last 3: reply3, msg4, reply4
		expect(result).toContain("reply3");
		expect(result).toContain("User: msg4");
		expect(result).toContain("reply4");
		// Middle should be excluded
		expect(result).not.toContain("msg3");
	});

	it("deduplicates when session has ≤ 6 messages", () => {
		const entries: Entry[] = [
			{ type: "message", message: { role: "user", content: "msg1" } },
			{ type: "message", message: { role: "assistant", content: "reply1" } },
			{ type: "message", message: { role: "user", content: "msg2" } },
			{ type: "message", message: { role: "assistant", content: "reply2" } },
		];
		const result = buildTranscript(entries);
		// All 4 messages included (first 3 + last 3 overlap)
		expect(result).toContain("msg1");
		expect(result).toContain("reply1");
		expect(result).toContain("msg2");
		expect(result).toContain("reply2");
		// No duplicates
		expect(result.split("msg1").length).toBe(2);
	});

	it("handles 1-2 messages gracefully", () => {
		const entries1: Entry[] = [
			{ type: "message", message: { role: "user", content: "only one" } },
		];
		expect(buildTranscript(entries1)).toContain("only one");

		const entries2: Entry[] = [
			{ type: "message", message: { role: "user", content: "first" } },
			{ type: "message", message: { role: "assistant", content: "second" } },
		];
		const result2 = buildTranscript(entries2);
		expect(result2).toContain("first");
		expect(result2).toContain("second");
	});
});

// ---------------------------------------------------------------------------
// parseName
// ---------------------------------------------------------------------------

describe("parseName", () => {
	it("returns empty for empty input", () => {
		expect(parseName("")).toBe("");
		expect(parseName("   ")).toBe("");
	});

	it("takes the first line only", () => {
		expect(parseName("fix auth bug\nmore text")).toBe("fix auth bug");
	});

	it("lowercases everything", () => {
		expect(parseName("Fix Auth Bug")).toBe("fix auth bug");
	});

	it("strips surrounding quotes", () => {
		expect(parseName('"fix auth bug"')).toBe("fix auth bug");
		expect(parseName("'fix auth bug'")).toBe("fix auth bug");
	});

	it("strips punctuation", () => {
		expect(parseName("fix-auth-bug!")).toBe("fix auth bug");
	});

	it("keeps alphanumeric and spaces", () => {
		expect(parseName("fix auth bug 123")).toBe("fix auth bug 123");
	});

	it("truncates to 5 words", () => {
		expect(parseName("one two three four five six seven")).toBe("one two three four five");
	});

	it("collapses whitespace", () => {
		expect(parseName("fix   auth    bug")).toBe("fix auth bug");
	});

	it("handles multi-line with quotes", () => {
		expect(parseName('"fix auth bug"\n// explanation')).toBe("fix auth bug");
	});

	it("handles empty first line", () => {
		expect(parseName("\nfix auth bug")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// generateSessionName
// ---------------------------------------------------------------------------

describe("generateSessionName", () => {
	const mockCompleteSimple = vi.fn();
	const mockGetApiKeyAndHeaders = vi.fn();
	const stableModel = { name: "test-model", reasoning: false };
	const reasoningModel = { name: "test-model", reasoning: true };

	function makeDeps(overrides?: {
		model?: unknown;
		modelRegistry?: { getApiKeyAndHeaders: typeof mockGetApiKeyAndHeaders };
		completeSimple?: typeof mockCompleteSimple;
	}) {
		return {
			completeSimple: overrides?.completeSimple ?? mockCompleteSimple,
			ctx: {
				model: overrides?.model,
				modelRegistry: overrides?.modelRegistry ?? { getApiKeyAndHeaders: mockGetApiKeyAndHeaders },
			} as unknown as ExtensionContext,
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockCompleteSimple.mockRejectedValue(new Error("not implemented"));
		mockGetApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: "sk-test" });
	});

	it("returns undefined when model is absent", async () => {
		const deps = makeDeps({ model: undefined });
		const result = await generateSessionName("some transcript", deps, new AbortController().signal);
		expect(result).toBeUndefined();
		expect(mockGetApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(mockCompleteSimple).not.toHaveBeenCalled();
	});

	it("returns undefined when getApiKeyAndHeaders fails (ok: false)", async () => {
		mockGetApiKeyAndHeaders.mockResolvedValue({ ok: false });
		const deps = makeDeps({ model: stableModel });
		const result = await generateSessionName("transcript", deps, new AbortController().signal);
		expect(result).toBeUndefined();
		expect(mockCompleteSimple).not.toHaveBeenCalled();
	});

	it("returns undefined when getApiKeyAndHeaders returns no apiKey", async () => {
		mockGetApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: undefined });
		const deps = makeDeps({ model: stableModel });
		const result = await generateSessionName("transcript", deps, new AbortController().signal);
		expect(result).toBeUndefined();
		expect(mockCompleteSimple).not.toHaveBeenCalled();
	});

	it("throws when getApiKeyAndHeaders throws (no try/catch in generateSessionName)", async () => {
		mockGetApiKeyAndHeaders.mockRejectedValue(new Error("registry unavailable"));
		const deps = makeDeps({ model: stableModel });
		await expect(
			generateSessionName("transcript", deps, new AbortController().signal),
		).rejects.toThrow("registry unavailable");
		expect(mockCompleteSimple).not.toHaveBeenCalled();
	});

	it("calls completeSimple with the model and a user message containing the transcript", async () => {
		mockCompleteSimple.mockResolvedValue({ content: [{ type: "text", text: "fix auth bug" }] });
		const deps = makeDeps({ model: stableModel });
		await generateSessionName("user: hello", deps, new AbortController().signal);

		expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
		const [model, messages, options] = mockCompleteSimple.mock.calls[0] as [
			string,
			{ messages: { role: string; content: { type: string; text: string }[] }[] },
			{ apiKey: string },
		];
		expect(model).toBe(stableModel);
		expect(messages.messages).toHaveLength(1);
		expect(messages.messages[0]!.role).toBe("user");
		expect(messages.messages[0]!.content[0]!.type).toBe("text");
		expect(messages.messages[0]!.content[0]!.text).toContain("user: hello");
		expect(options.apiKey).toBe("sk-test");
	});

	it("passes headers when modelRegistry provides them", async () => {
		mockGetApiKeyAndHeaders.mockResolvedValue({
			ok: true,
			apiKey: "sk-test",
			headers: { "X-Custom": "header" },
		});
		mockCompleteSimple.mockResolvedValue({ content: [{ type: "text", text: "fix auth bug" }] });
		const deps = makeDeps({ model: stableModel });
		await generateSessionName("transcript", deps, new AbortController().signal);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		expect(mockCompleteSimple.mock.calls[0]![2].headers).toEqual({ "X-Custom": "header" });
	});

	it("passes reasoning: 'minimal' when model has reasoning flag", async () => {
		mockCompleteSimple.mockResolvedValue({ content: [{ type: "text", text: "fix auth bug" }] });
		const deps = makeDeps({ model: reasoningModel });
		await generateSessionName("transcript", deps, new AbortController().signal);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		expect(mockCompleteSimple.mock.calls[0]![2].reasoning).toBe("minimal");
	});

	it("does not pass reasoning when model has no reasoning flag", async () => {
		mockCompleteSimple.mockResolvedValue({ content: [{ type: "text", text: "fix auth bug" }] });
		const deps = makeDeps({ model: stableModel });
		await generateSessionName("transcript", deps, new AbortController().signal);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		expect(mockCompleteSimple.mock.calls[0]![2].reasoning).toBeUndefined();
	});

	it("passes the abort signal to completeSimple", async () => {
		const controller = new AbortController();
		mockCompleteSimple.mockResolvedValue({ content: [{ type: "text", text: "fix auth bug" }] });
		const deps = makeDeps({ model: stableModel });
		await generateSessionName("transcript", deps, controller.signal);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		expect(mockCompleteSimple.mock.calls[0]![2].signal).toBe(controller.signal);
	});

	it("parses and returns the generated name from text content", async () => {
		mockCompleteSimple.mockResolvedValue({ content: [{ type: "text", text: "fix auth bug" }] });
		const deps = makeDeps({ model: stableModel });
		const result = await generateSessionName("transcript", deps, new AbortController().signal);
		expect(result).toBe("fix auth bug");
	});

	it("handles response with multiple text content blocks (joins with newline)", async () => {
		mockCompleteSimple.mockResolvedValue({
			content: [{ type: "text", text: "fix auth" }, { type: "text", text: "bug" }],
		});
		const deps = makeDeps({ model: stableModel });
		const result = await generateSessionName("transcript", deps, new AbortController().signal);
		// join("\n") → "fix auth\nbug" → parseName takes first line → "fix auth"
		expect(result).toBe("fix auth");
	});

	it("returns empty string when response has no text content blocks", async () => {
		mockCompleteSimple.mockResolvedValue({ content: [{ type: "image", url: "http://example.com/img.png" }] });
		const deps = makeDeps({ model: stableModel });
		const result = await generateSessionName("transcript", deps, new AbortController().signal);
		expect(result).toBe("");
	});

	it("throws when completeSimple throws (no try/catch in generateSessionName)", async () => {
		mockCompleteSimple.mockRejectedValue(new Error("network error"));
		const deps = makeDeps({ model: stableModel });
		await expect(
			generateSessionName("transcript", deps, new AbortController().signal),
		).rejects.toThrow("network error");
	});

	it("throws when completeSimple rejects with a non-Error value", async () => {
		mockCompleteSimple.mockRejectedValue("string error");
		const deps = makeDeps({ model: stableModel });
		await expect(
			generateSessionName("transcript", deps, new AbortController().signal),
		).rejects.toBe("string error");
	});

	it("truncates transcript to TRANSCRIPT_MAX_CHARS (12000)", async () => {
		mockCompleteSimple.mockResolvedValue({ content: [{ type: "text", text: "name" }] });
		const longTranscript = "x".repeat(15000);
		const deps = makeDeps({ model: stableModel });
		await generateSessionName(longTranscript, deps, new AbortController().signal);

		const callArgs = mockCompleteSimple.mock.calls[0]!;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
		const promptText = callArgs[1]!.messages[0]!.content[0]!.text;
		// buildNamePrompt adds ~40 chars wrapper, transcript is sliced to 12000
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		expect(promptText.length).toBeLessThanOrEqual(12100);
	});
});
