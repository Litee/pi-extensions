import { describe, expect, it } from "vitest";

import {
	buildConversationBreakdown,
	buildSystemPromptBreakdown,
	estimateTokens,
	type BranchEntry,
	type SystemPromptOptions,
} from "../src/breakdown.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal default-path system prompt used across multiple tests. */
function makeSystemPrompt(opts: {
	tools?: string[];
	guidelines?: string[];
	contextFiles?: { path: string; content: string }[];
	skillCount?: number;
	appendSystemPrompt?: string;
} = {}): string {
	const toolLines =
		(opts.tools ?? ["read: Read a file", "bash: Run bash"])
			.map((t) => `- ${t}`)
			.join("\n");

	const guidelineLines =
		(opts.guidelines ?? ["Be concise in your responses"])
			.map((g) => `- ${g}`)
			.join("\n");

	const skillXml =
		opts.skillCount != null && opts.skillCount > 0
			? "\n\nThe following skills provide specialized instructions for specific tasks.\n" +
			  "Use the read tool to load a skill's file when the task matches its description.\n\n" +
			  "<available_skills>\n" +
			  Array.from({ length: opts.skillCount }, (_, i) =>
					`  <skill>\n    <name>skill-${i}</name>\n    <description>Skill ${i} desc</description>\n    <location>/path/skill-${i}.md</location>\n  </skill>`,
			  ).join("\n") +
			  "\n</available_skills>"
			: "";

	const contextSection =
		(opts.contextFiles ?? []).length > 0
			? "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n" +
			  (opts.contextFiles ?? [])
					.map((f) => `## ${f.path}\n\n${f.content}\n\n`)
					.join("")
			: "";

	const appendSection = opts.appendSystemPrompt ? `\n\n${opts.appendSystemPrompt}` : "";

	return (
		`You are an expert coding assistant.\n\nAvailable tools:\n${toolLines}\n\n` +
		`In addition to the tools above, you may have access to other custom tools.\n\n` +
		`Guidelines:\n${guidelineLines}\n\n` +
		`Pi documentation (read only when the user asks about pi itself).` +
		appendSection +
		contextSection +
		skillXml +
		`\nCurrent date: 2026-05-06\nCurrent working directory: /tmp`
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// estimateTokens
// ─────────────────────────────────────────────────────────────────────────────

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
		expect(estimateTokens("abcde")).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown — empty / missing prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown — empty prompt", () => {
	it("returns all zeros when systemPrompt is empty", () => {
		// Arrange
		const prompt = "";

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.total).toBe(0);
		expect(result.core).toBe(0);
		expect(result.tools).toBe(0);
		expect(result.toolCount).toBe(0);
		expect(result.skillsCatalog).toBe(0);
		expect(result.skillCount).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown — tools
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown — tools section", () => {
	it("measures tools from the Available tools: section in the prompt", () => {
		// Arrange
		const prompt = makeSystemPrompt({ tools: ["read: Read a file", "bash: Run bash"] });

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert — tools are found even though toolSnippets is not in options
		expect(result.tools).toBeGreaterThan(0);
	});

	it("counts the number of tool entries", () => {
		// Arrange
		const prompt = makeSystemPrompt({
			tools: ["read: Read a file", "bash: Run bash", "edit: Edit a file"],
		});

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.toolCount).toBe(3);
	});

	it("returns toolCount 0 when Available tools section is absent", () => {
		// Arrange — custom prompt path with no tools section
		const prompt = "Custom instructions only. No tools listed here.";

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.tools).toBe(0);
		expect(result.toolCount).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown — guidelines
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown — guidelines section", () => {
	it("measures guidelines from the Guidelines: section", () => {
		// Arrange
		const prompt = makeSystemPrompt({ guidelines: ["Be concise", "Show file paths clearly"] });

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.guidelines).toBeGreaterThan(0);
	});

	it("returns 0 guidelines when the section is absent", () => {
		// Arrange
		const prompt = "No guidelines section here at all.";

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.guidelines).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown — skills catalog
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown — skills catalog", () => {
	it("measures skills catalog from the available_skills XML block", () => {
		// Arrange
		const prompt = makeSystemPrompt({ skillCount: 3 });

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.skillsCatalog).toBeGreaterThan(0);
	});

	it("counts skills accurately", () => {
		// Arrange
		const prompt = makeSystemPrompt({ skillCount: 5 });

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.skillCount).toBe(5);
	});

	it("returns skillCount 0 and skillsCatalog 0 when no skills are present", () => {
		// Arrange
		const prompt = makeSystemPrompt({ skillCount: 0 });

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.skillsCatalog).toBe(0);
		expect(result.skillCount).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown — context files
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown — context files", () => {
	it("measures each context file's tokens from the prompt string", () => {
		// Arrange
		const contextFiles = [
			{ path: "/proj/AGENTS.md", content: "# Instructions\nDo things correctly." },
			{ path: "/proj/README.md", content: "# My Project\nA great project." },
		];
		const prompt = makeSystemPrompt({ contextFiles });
		const options: SystemPromptOptions = { contextFiles };

		// Act
		const result = buildSystemPromptBreakdown(prompt, options);

		// Assert
		expect(result.contextFiles).toHaveLength(2);
		for (const cf of result.contextFiles) {
			expect(cf.tokens).toBeGreaterThan(0);
		}
	});

	it("falls back to content-based estimate when header not found in prompt", () => {
		// Arrange — options has a file that is not in the prompt
		const options: SystemPromptOptions = {
			contextFiles: [{ path: "/not/in/prompt.md", content: "a".repeat(400) }],
		};
		const prompt = makeSystemPrompt();

		// Act
		const result = buildSystemPromptBreakdown(prompt, options);

		// Assert — fallback estimate is non-zero
		expect(result.contextFiles[0]?.tokens).toBeGreaterThan(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown — appendSystemPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown — appendSystemPrompt", () => {
	it("estimates appendSystemPrompt tokens from options", () => {
		// Arrange
		const appendContent = "a".repeat(400);
		const prompt = makeSystemPrompt({ appendSystemPrompt: appendContent });
		const options: SystemPromptOptions = { appendSystemPrompt: appendContent };

		// Act
		const result = buildSystemPromptBreakdown(prompt, options);

		// Assert
		expect(result.appendSystemPrompt).toBe(estimateTokens(appendContent));
	});

	it("returns 0 when options has no appendSystemPrompt", () => {
		// Arrange
		const prompt = makeSystemPrompt();
		const options: SystemPromptOptions = {};

		// Act
		const result = buildSystemPromptBreakdown(prompt, options);

		// Assert
		expect(result.appendSystemPrompt).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown — core and totals
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown — core and total invariants", () => {
	it("total equals estimateTokens of the full prompt", () => {
		// Arrange
		const prompt = makeSystemPrompt({ tools: ["read: Read"], skillCount: 2 });

		// Act
		const result = buildSystemPromptBreakdown(prompt, undefined);

		// Assert
		expect(result.total).toBe(estimateTokens(prompt));
	});

	it("core is > 0 for a realistic default-path system prompt", () => {
		// Arrange — a normal system prompt with tools, guidelines, skills, and context files
		const prompt = makeSystemPrompt({
			tools: ["read: Read a file", "bash: Run bash", "edit: Edit a file", "write: Write a file"],
			guidelines: ["Be concise", "Show file paths clearly"],
			contextFiles: [{ path: "/proj/AGENTS.md", content: "Some project guidelines." }],
			skillCount: 3,
		});
		const options: SystemPromptOptions = {
			contextFiles: [{ path: "/proj/AGENTS.md", content: "Some project guidelines." }],
		};

		// Act
		const result = buildSystemPromptBreakdown(prompt, options);

		// Assert — core instructions should be non-zero
		expect(result.core).toBeGreaterThan(0);
	});

	it("core is always >= 0", () => {
		// Arrange — artificially inflate options to stress-test clamping
		const options: SystemPromptOptions = {
			appendSystemPrompt: "a".repeat(10000),
		};
		const prompt = "tiny";

		// Act
		const result = buildSystemPromptBreakdown(prompt, options);

		// Assert
		expect(result.core).toBeGreaterThanOrEqual(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildConversationBreakdown
// ─────────────────────────────────────────────────────────────────────────────

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
		const entries: BranchEntry[] = [makeUserEntry("hello"), makeUserEntry("world!!!")];
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

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPromptBreakdown — appendSystemPromptPreview
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPromptBreakdown — appendSystemPromptPreview", () => {
	it("is undefined when there is no appendSystemPrompt", () => {
		const result = buildSystemPromptBreakdown(makeSystemPrompt(), {});
		expect(result.appendSystemPromptPreview).toBeUndefined();
	});

	it("contains the first non-empty line when appendSystemPrompt is set", () => {
		const options: SystemPromptOptions = { appendSystemPrompt: "# CDK Guidelines\n\nSome text." };
		const result = buildSystemPromptBreakdown(makeSystemPrompt({ appendSystemPrompt: "# CDK Guidelines\n\nSome text." }), options);
		expect(result.appendSystemPromptPreview).toBe("# CDK Guidelines");
	});

	it("truncates previews longer than 40 characters", () => {
		const longLine = "x".repeat(60);
		const options: SystemPromptOptions = { appendSystemPrompt: longLine };
		const result = buildSystemPromptBreakdown(makeSystemPrompt({ appendSystemPrompt: longLine }), options);
		expect(result.appendSystemPromptPreview).toHaveLength(41); // 40 chars + ellipsis
		expect(result.appendSystemPromptPreview).toMatch(/…$/);
	});

	it("skips leading blank lines to find the first non-empty line", () => {
		const options: SystemPromptOptions = { appendSystemPrompt: "\n\n\n# Real Content" };
		const result = buildSystemPromptBreakdown(makeSystemPrompt({ appendSystemPrompt: "\n\n\n# Real Content" }), options);
		expect(result.appendSystemPromptPreview).toBe("# Real Content");
	});
});
