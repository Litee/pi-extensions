import { describe, expect, it } from "vitest";

import {
	buildConversationBreakdown,
	buildSystemPromptBreakdown,
	estimateTokens,
	type BranchEntry,
	type SystemPromptOptions,
} from "../src/breakdown.js";

// ────────────────────────────────────────────────────────────────────────────
// estimateTokens
// ────────────────────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
	it("returns 0 for an empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("returns 1 for a 4-character string", () => {
		expect(estimateTokens("abcd")).toBe(1);
	});

	it("returns 25 for a 100-character string", () => {
		expect(estimateTokens("a".repeat(100))).toBe(25);
	});

	it("rounds up (ceiling) for non-divisible lengths", () => {
		// 5 chars → ceil(5/4) = 2
		expect(estimateTokens("abcde")).toBe(2);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown
// ────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown", () => {
	it("with undefined options: core equals estimateTokens(prompt), all others 0", () => {
		const prompt = "a".repeat(400);
		const result = buildSystemPromptBreakdown(prompt, undefined);

		expect(result.core).toBe(estimateTokens(prompt));
		expect(result.tools).toBe(0);
		expect(result.guidelines).toBe(0);
		expect(result.appendSystemPrompt).toBe(0);
		expect(result.contextFiles).toHaveLength(0);
		expect(result.skillsCatalog).toBe(0);
		expect(result.total).toBe(estimateTokens(prompt));
	});

	it("with toolSnippets: tools > 0", () => {
		const options: SystemPromptOptions = {
			toolSnippets: { read: "Read a file", bash: "Execute a bash command" },
		};
		// Give the prompt enough text so core stays ≥ 0
		const prompt = "x".repeat(800);
		const result = buildSystemPromptBreakdown(prompt, options);

		expect(result.tools).toBeGreaterThan(0);
	});

	it("with contextFiles: each file has tokens > 0", () => {
		const options: SystemPromptOptions = {
			contextFiles: [
				{ path: "/project/AGENTS.md", content: "# Instructions\nDo things correctly." },
				{ path: "/project/README.md", content: "# My Project\nA great project." },
			],
		};
		const prompt = "y".repeat(2000);
		const result = buildSystemPromptBreakdown(prompt, options);

		expect(result.contextFiles).toHaveLength(2);
		for (const cf of result.contextFiles) {
			expect(cf.tokens).toBeGreaterThan(0);
		}
	});

	it("with skills: skillsCatalog > 0", () => {
		const options: SystemPromptOptions = {
			skills: [
				{ name: "my-skill", description: "Does something useful", filePath: "/path/to/skill.md" },
			],
		};
		const prompt = "z".repeat(1200);
		const result = buildSystemPromptBreakdown(prompt, options);

		expect(result.skillsCatalog).toBeGreaterThan(0);
	});

	it("core is always >= 0 even when components exceed total estimate", () => {
		// Very short prompt so estimated total < sum of components
		const options: SystemPromptOptions = {
			toolSnippets: { read: "a".repeat(200) },
			promptGuidelines: ["b".repeat(200)],
		};
		const prompt = "tiny";
		const result = buildSystemPromptBreakdown(prompt, options);

		expect(result.core).toBeGreaterThanOrEqual(0);
	});

	it("total equals estimateTokens of the full prompt string", () => {
		const prompt = "hello world, this is my system prompt!";
		const result = buildSystemPromptBreakdown(prompt, {});
		expect(result.total).toBe(estimateTokens(prompt));
	});
});

// ────────────────────────────────────────────────────────────────────────────
// buildConversationBreakdown
// ────────────────────────────────────────────────────────────────────────────

describe("buildConversationBreakdown", () => {
	function makeUserEntry(content: string): BranchEntry {
		return { type: "message", message: { role: "user", content } };
	}

	function makeAssistantEntry(content: string, outputTokens?: number): BranchEntry {
		return {
			type: "message",
			message: {
				role: "assistant",
				content,
				...(outputTokens !== undefined
					? {
							usage: {
								input: 100,
								output: outputTokens,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 100 + outputTokens,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
					  }
					: {}),
			},
		};
	}

	function makeToolResultEntry(content: string): BranchEntry {
		return { type: "message", message: { role: "toolResult", content } };
	}

	it("returns zeros for an empty branch", () => {
		const result = buildConversationBreakdown([]);
		expect(result.total).toBe(0);
		expect(result.userMessages).toBe(0);
		expect(result.assistantOutput).toBe(0);
		expect(result.toolResults).toBe(0);
	});

	it("accumulates user message tokens", () => {
		const entries: BranchEntry[] = [
			makeUserEntry("hello"),
			makeUserEntry("world!!!"),
		];
		const result = buildConversationBreakdown(entries);
		expect(result.userMessages).toBeGreaterThan(0);
	});

	it("uses actual usage.output for assistant messages when available", () => {
		const entries: BranchEntry[] = [makeAssistantEntry("some output text", 42)];
		const result = buildConversationBreakdown(entries);
		expect(result.assistantOutput).toBe(42);
	});

	it("falls back to estimate for assistant messages without usage", () => {
		const content = "a".repeat(80);
		const entries: BranchEntry[] = [makeAssistantEntry(content)];
		const result = buildConversationBreakdown(entries);
		expect(result.assistantOutput).toBe(estimateTokens(content));
	});

	it("accumulates tool result tokens", () => {
		const entries: BranchEntry[] = [
			makeToolResultEntry("tool output here"),
			makeToolResultEntry("more tool output"),
		];
		const result = buildConversationBreakdown(entries);
		expect(result.toolResults).toBeGreaterThan(0);
	});

	it("total equals sum of userMessages + assistantOutput + toolResults", () => {
		const entries: BranchEntry[] = [
			makeUserEntry("user says something"),
			makeAssistantEntry("assistant replies", 30),
			makeToolResultEntry("tool returned data"),
		];
		const result = buildConversationBreakdown(entries);
		expect(result.total).toBe(result.userMessages + result.assistantOutput + result.toolResults);
	});

	it("skips non-message entry types", () => {
		const entries: BranchEntry[] = [
			{ type: "compaction" } as BranchEntry,
			makeUserEntry("only user message"),
		];
		const result = buildConversationBreakdown(entries);
		expect(result.userMessages).toBeGreaterThan(0);
		expect(result.assistantOutput).toBe(0);
		expect(result.toolResults).toBe(0);
	});
});
