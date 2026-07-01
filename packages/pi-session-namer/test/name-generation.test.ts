import { describe, expect, it } from "vitest";

import { buildTranscript, parseName, type Entry } from "../src/name-generation.js";

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
