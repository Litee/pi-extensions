import { describe, expect, it } from "vitest";

import { estimateStringTokens, estimateEntryTokens } from "../src/tokens.js";

describe("estimateStringTokens", () => {
	it("estimates tokens as ceil(length / 4)", () => {
		expect(estimateStringTokens("")).toBe(0);
		expect(estimateStringTokens("a")).toBe(1);
		expect(estimateStringTokens("abcd")).toBe(1);
		expect(estimateStringTokens("abcde")).toBe(2);
		expect(estimateStringTokens("a".repeat(100))).toBe(25);
		expect(estimateStringTokens("a".repeat(101))).toBe(26);
	});
});

describe("estimateEntryTokens", () => {
	it("returns 0 for unknown entry types", () => {
		expect(estimateEntryTokens({ type: "unknown" })).toBe(0);
		expect(estimateEntryTokens({ type: "compaction" })).toBe(0);
	});

	it("returns 0 for message entries without a message field", () => {
		expect(estimateEntryTokens({ type: "message" })).toBe(0);
	});

	it("delegates to estimateMessageTokens for message entries with a message", () => {
		// We can't directly inject the mock, but we can test the structure
		const entry = { type: "message", message: { role: "user" as const, content: "test" } };
		expect(estimateEntryTokens(entry)).toBeGreaterThan(0);
	});

	it("estimates tokens for custom_message with string content", () => {
		const content = "Hello world this is a test";
		const entry = { type: "custom_message", content };
		const expected = Math.ceil(content.length / 4);
		expect(estimateEntryTokens(entry)).toBe(expected);
	});

	it("estimates tokens for custom_message with array content (text blocks only)", () => {
		const content = [
			{ type: "text", text: "First block" },
			{ type: "text", text: "Second block" },
			{ type: "thinking", thinking: "hidden" },
			{ type: "toolCall", name: "bash", arguments: {} },
		];
		const entry = { type: "custom_message", content } as unknown as { type: string; content: unknown };
		const result = estimateEntryTokens(entry);
		// Should only count text blocks, not thinking or toolCall
		const textTotal = Math.ceil(("First block" + "\n" + "Second block").length / 4);
		expect(result).toBe(textTotal);
	});

	it("returns 0 for custom_message with non-string, non-array content", () => {
		const entry = { type: "custom_message", content: 42 };
		expect(estimateEntryTokens(entry)).toBe(0);
	});

	it("returns 0 for custom_message with null content", () => {
		const entry = { type: "custom_message", content: null };
		expect(estimateEntryTokens(entry)).toBe(0);
	});

	it("estimates tokens for branch_summary with string summary", () => {
		const summary = "Session compacted successfully";
		const entry = { type: "branch_summary", summary };
		const expected = Math.ceil(summary.length / 4);
		expect(estimateEntryTokens(entry)).toBe(expected);
	});

	it("returns 0 for branch_summary without string summary", () => {
		expect(estimateEntryTokens({ type: "branch_summary", summary: 123 })).toBe(0);
		expect(estimateEntryTokens({ type: "branch_summary" })).toBe(0);
	});

	it("handles custom_message with empty text blocks", () => {
		const content = [
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "thought" },
		];
		const entry = { type: "custom_message", content } as unknown as { type: string; content: unknown };
		expect(estimateEntryTokens(entry)).toBe(0);
	});

	it("handles custom_message with array content where blocks are objects with type but no text", () => {
		const content = [
			{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
			{ type: "thinking", thinking: "hidden" },
		];
		const entry = { type: "custom_message", content } as unknown as { type: string; content: unknown };
		expect(estimateEntryTokens(entry)).toBe(0);
	});
});
