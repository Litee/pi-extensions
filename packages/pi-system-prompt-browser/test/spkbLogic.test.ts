import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
	estimateTokensFromFile,
	estimateTokensFromContent,
	formatTokens,
	formatDetailsView,
	type SkillWithTokens,
	type ContextFileWithTokens,
} from "../src/spkbLogic.js";

// ---------------------------------------------------------------------------
// estimateTokensFromContent
// ---------------------------------------------------------------------------

describe("estimateTokensFromContent", () => {
	it("estimates 0 tokens for empty string", () => {
		expect(estimateTokensFromContent("")).toBe(0);
	});

	it("uses chars/4 heuristic", () => {
		// 10 chars → 10/4 = 2.5 → ceil = 3
		expect(estimateTokensFromContent("hello world")).toBe(3);
	});

	it("rounds up", () => {
		// 13 chars → 13/4 = 3.25 → ceil = 4
		expect(estimateTokensFromContent("hello, world!")).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// estimateTokensFromFile
// ---------------------------------------------------------------------------

describe("estimateTokensFromFile", () => {
	it("returns token count for a readable file", () => {
		const result = estimateTokensFromFile(
			"packages/pi-agent-introspection/README.md",
		);
		expect(result.error).toBe(false);
		expect(result.tokens).toBeGreaterThan(0);
		// Should match the direct estimate
		const direct = estimateTokensFromContent(
			readFileSync("packages/pi-agent-introspection/README.md", "utf-8"),
		);
		expect(result.tokens).toBe(direct);
	});

	it("returns { tokens: null, error: true } on read failure", () => {
		const result = estimateTokensFromFile("/nonexistent/file.txt");

		expect(result.error).toBe(true);
		expect(result.tokens).toBeNull();
	});

	it("handles a real existing file", () => {
		const result = estimateTokensFromFile(
			"packages/pi-agent-introspection/test/tool.test.ts",
		);
		expect(result.error).toBe(false);
		expect(result.tokens).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("formats <1000 as plain number", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(123)).toBe("123");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats <10000 with one decimal", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("formats ≥10000 with no decimals", () => {
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(12345)).toBe("12k");
		expect(formatTokens(99999)).toBe("100k");
	});
});

// ---------------------------------------------------------------------------
// formatDetailsView
// ---------------------------------------------------------------------------

describe("formatDetailsView", () => {
	const makeSkill = (
		name: string,
		tokens: number | null = 500,
		error = false,
	): SkillWithTokens => ({
		name,
		filePath: `/path/to/${name}/SKILL.md`,
		tokens,
		error,
	});

	const makeCtxFile = (
		path: string,
		tokens: number | null = 200,
		error = false,
	): ContextFileWithTokens => ({
		path,
		tokens,
		error,
	});

	it("shows skills with token counts", () => {
		const skills = [makeSkill("my-skill"), makeSkill("other-skill")];
		const result = formatDetailsView({ skills, contextFiles: [], selectedTools: [] });

		expect(result).toContain("Skills (1.0k)");
		expect(result).toContain("my-skill");
		expect(result).toContain("~500 tokens");
		expect(result).toContain("other-skill");
	});

	it("shows (no skills) when skills array is empty", () => {
		const result = formatDetailsView({
			skills: [],
			contextFiles: [],
			selectedTools: [],
		});

		expect(result).toContain("Skills (0)");
		expect(result).toContain("(no skills)");
	});

	it("shows read error for skills with error flag", () => {
		const skills: SkillWithTokens[] = [
			{ name: "broken-skill", filePath: "/no/such/file", tokens: null, error: true },
		];
		const result = formatDetailsView({ skills, contextFiles: [], selectedTools: [] });

		expect(result).toContain("(read error)");
		expect(result).toContain("~? tokens");
	});

	it("shows context files with token counts", () => {
		const files = [
			makeCtxFile("/home/user/project/AGENTS.md"),
			makeCtxFile("/home/user/.pi/AGENTS.md"),
		];
		const result = formatDetailsView({
			skills: [],
			contextFiles: files,
			selectedTools: [],
		});

		expect(result).toContain("Context files (400)");
		expect(result).toContain("/home/user/project/AGENTS.md");
		expect(result).toContain("~200 tokens");
	});

	it("shows (none) when context files array is empty", () => {
		const result = formatDetailsView({
			skills: [],
			contextFiles: [],
			selectedTools: [],
		});

		expect(result).toContain("Context files (0)");
		expect(result).toContain("(none)");
	});

	it("shows read error for context files with error flag", () => {
		const files: ContextFileWithTokens[] = [
			{ path: "/no/such/file.md", tokens: null, error: true },
		];
		const result = formatDetailsView({ skills: [], contextFiles: files, selectedTools: [] });

		expect(result).toContain("(read error)");
		expect(result).toContain("~? tokens");
	});

	it("shows selected tools", () => {
		const result = formatDetailsView({
			skills: [],
			contextFiles: [],
			selectedTools: ["bash", "read", "edit"],
		});

		expect(result).toContain("Selected tools: bash, read, edit");
	});

	it("shows (none) for selected tools when empty", () => {
		const result = formatDetailsView({
			skills: [],
			contextFiles: [],
			selectedTools: [],
		});

		expect(result).toContain("Selected tools: (none)");
	});

	it("shows append system prompt with token estimate", () => {
		const text = "Always respond in JSON format.";
		// 30 chars / 4 = 7.5 → ceil = 8 tokens
		const result = formatDetailsView({
			skills: [],
			contextFiles: [],
			selectedTools: [],
			appendSystemPrompt: text,
		});

		expect(result).toContain("Append system prompt:");
		expect(result).toContain("~8 tokens");
		expect(result).toContain("30 chars");
	});

	it("omits append system prompt section when absent", () => {
		const result = formatDetailsView({
			skills: [],
			contextFiles: [],
			selectedTools: [],
		});

		expect(result).not.toContain("Append system prompt");
	});

	it("shows prompt guidelines with count", () => {
		const result = formatDetailsView({
			skills: [],
			contextFiles: [],
			selectedTools: [],
			promptGuidelines: ["Be concise.", "Use TypeScript.", "Prefer functional style."],
		});

		expect(result).toContain("Prompt guidelines (3)");
		expect(result).toContain("Be concise.");
		expect(result).toContain("Use TypeScript.");
		expect(result).toContain("Prefer functional style.");
	});

	it("omits prompt guidelines section when absent", () => {
		const result = formatDetailsView({
			skills: [],
			contextFiles: [],
			selectedTools: [],
		});

		expect(result).not.toContain("Prompt guidelines");
	});

	it("shows total estimated tokens", () => {
		const skills = [makeSkill("s1", 500)];
		const files = [makeCtxFile("/f.md", 200)];
		const result = formatDetailsView({
			skills,
			contextFiles: files,
			selectedTools: [],
		});

		expect(result).toContain("Total estimated: ~700 tokens");
	});

	it("handles null tokens in total calculation", () => {
		const skills: SkillWithTokens[] = [{ name: "s1", filePath: "", tokens: null, error: true }];
		const result = formatDetailsView({
			skills,
			contextFiles: [],
			selectedTools: [],
		});

		expect(result).toContain("Total estimated: ~0 tokens");
	});

	it("sections appear in correct order", () => {
		const result = formatDetailsView({
			skills: [makeSkill("s1")],
			contextFiles: [makeCtxFile("/f.md")],
			selectedTools: ["bash"],
			appendSystemPrompt: "test",
			promptGuidelines: ["g1"],
		});

		const lines = result.split("\n");
		const skillIdx = lines.findIndex((l) => l.startsWith("Skills"));
		const ctxIdx = lines.findIndex((l) => l.startsWith("Context files"));
		const toolsIdx = lines.findIndex((l) => l.startsWith("Selected tools"));
		const totalIdx = lines.findIndex((l) => l.startsWith("Total estimated"));

		expect(skillIdx).toBeLessThan(ctxIdx);
		expect(ctxIdx).toBeLessThan(toolsIdx);
		expect(toolsIdx).toBeLessThan(totalIdx);
	});

	it("includes file paths for skills and context files", () => {
		const skills = [makeSkill("my-skill")];
		const files = [makeCtxFile("/home/user/project/AGENTS.md")];
		const result = formatDetailsView({
			skills,
			contextFiles: files,
			selectedTools: [],
		});

		expect(result).toContain("/path/to/my-skill/SKILL.md");
		expect(result).toContain("/home/user/project/AGENTS.md");
	});
});
