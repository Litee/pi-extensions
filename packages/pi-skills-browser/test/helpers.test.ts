import { describe, expect, it } from "vitest";

import {
	applyFilter,
	applySortMode,
	detectScope,
	estimateDescriptionTokens,
	filterAndSort,
	formatTokens,
	type SkillEntry,
	type SortMode,
} from "../src/helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkSkill(
	name: string,
	description: string,
	overrides?: Partial<SkillEntry>,
): SkillEntry {
	return {
		name,
		description,
		tokens: estimateDescriptionTokens(description),
		path: `/path/to/${name}`,
		inPrompt: false,
		pathDisplay: "",
		scope: "project",
		...overrides,
	};
}

const SKILLS: SkillEntry[] = [
	mkSkill("brainstorming", "Explore ideas before writing code."),
	mkSkill("aws-cdk-expert", "Build AWS CDK infrastructure using best practices."),
	mkSkill("use-pyspark", "Write and debug PySpark scripts."),
	mkSkill("write-well", "Compose and edit any written document."),
	mkSkill("skill-creator", "Create new skills or modify existing ones."),
];

// ---------------------------------------------------------------------------
// estimateDescriptionTokens
// ---------------------------------------------------------------------------

describe("estimateDescriptionTokens", () => {
	it("returns 0 for an empty string", () => {
		expect(estimateDescriptionTokens("")).toBe(0);
	});

	it("returns 1 for exactly 4 characters", () => {
		expect(estimateDescriptionTokens("abcd")).toBe(1);
	});

	it("rounds up (ceil) for non-multiples of 4", () => {
		expect(estimateDescriptionTokens("abcde")).toBe(2); // 5 chars → ceil(5/4)=2
	});

	it("grows linearly with description length", () => {
		const short = estimateDescriptionTokens("x".repeat(40));
		const long = estimateDescriptionTokens("x".repeat(80));
		expect(long).toBe(short * 2);
	});

	it("handles a realistic skill description", () => {
		const desc = "Explore user intent and requirements before writing code.";
		// 57 chars → ceil(57/4) = 15
		expect(estimateDescriptionTokens(desc)).toBe(Math.ceil(desc.length / 4));
	});
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("formats zero without k suffix", () => {
		expect(formatTokens(0)).toBe("0");
	});

	it("formats small numbers verbatim", () => {
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats 1k–9.9k with one decimal place", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(9949)).toBe("9.9k");
	});

	it("formats 10k and above without decimals", () => {
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(12345)).toBe("12k");
		expect(formatTokens(123456)).toBe("123k");
	});
});

// ---------------------------------------------------------------------------
// applyFilter
// ---------------------------------------------------------------------------

describe("applyFilter", () => {
	it("returns the original array reference when query is empty", () => {
		expect(applyFilter(SKILLS, "")).toBe(SKILLS);
	});

	it("returns the original array reference when query is whitespace only", () => {
		expect(applyFilter(SKILLS, "   ")).toBe(SKILLS);
	});

	it("matches skill names case-insensitively", () => {
		const result = applyFilter(SKILLS, "AWS");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("aws-cdk-expert");
	});

	it("matches a lowercase query against a mixed-case name", () => {
		const result = applyFilter(SKILLS, "pyspark");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("use-pyspark");
	});

	it("returns multiple matches when the query is a shared substring", () => {
		const result = applyFilter(SKILLS, "skill");
		// "skill-creator" contains "skill"
		expect(result.some((s) => s.name === "skill-creator")).toBe(true);
	});

	it("returns an empty array when there are no matches", () => {
		expect(applyFilter(SKILLS, "xyzzy")).toHaveLength(0);
	});

	it("does not mutate the input array", () => {
		const original = [...SKILLS];
		applyFilter(SKILLS, "aws");
		expect(SKILLS).toEqual(original);
	});
});

// ---------------------------------------------------------------------------
// applySortMode
// ---------------------------------------------------------------------------

describe("applySortMode", () => {
	it("sorts alphabetically by name in 'name' mode", () => {
		const sorted = applySortMode(SKILLS, "name");
		const names = sorted.map((s) => s.name);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
	});

	it("sorts by descending token count in 'tokens' mode", () => {
		const sorted = applySortMode(SKILLS, "tokens");
		for (let i = 0; i < sorted.length - 1; i++) {
			expect(sorted[i]!.tokens).toBeGreaterThanOrEqual(sorted[i + 1]!.tokens);
		}
	});

	it("uses name as a tiebreaker when token counts are equal in 'tokens' mode", () => {
		const equal: SkillEntry[] = [
			{ name: "zeta", description: "abcd", tokens: 1, path: "", inPrompt: false, scope: "project", pathDisplay: "" },
			{ name: "alpha", description: "abcd", tokens: 1, path: "", inPrompt: false, scope: "project", pathDisplay: "" },
			{ name: "mango", description: "abcd", tokens: 1, path: "", inPrompt: false, scope: "project", pathDisplay: "" },
		];
		const sorted = applySortMode(equal, "tokens");
		expect(sorted.map((s) => s.name)).toEqual(["alpha", "mango", "zeta"]);
	});

	it("does not mutate the input array", () => {
		const original = SKILLS.map((s) => s.name);
		applySortMode(SKILLS, "name");
		expect(SKILLS.map((s) => s.name)).toEqual(original);
	});

	it("returns a new array even when already sorted", () => {
		const sorted = applySortMode(SKILLS, "name");
		expect(sorted).not.toBe(SKILLS);
	});
});

// ---------------------------------------------------------------------------
// detectScope
// ---------------------------------------------------------------------------

describe("detectScope", () => {
	it("detects project scope from .pi/skills path", () => {
		expect(
			detectScope("/home/user/project/.pi/skills/my-skill/SKILL.md"),
		).toBe("project");
	});

	it("detects user-skills scope from ~/.pi/agent/skills path", () => {
		expect(
			detectScope("/home/user/.pi/agent/skills/my-skill/SKILL.md"),
		).toBe("user-skills");
	});

	it("detects user-agents scope from ~/.pi/agent/agents path", () => {
		expect(
			detectScope("/home/user/.pi/agent/agents/my-agent/SKILL.md"),
		).toBe("user-agents");
	});

	it("handles tilde-prefixed paths", () => {
		expect(detectScope("~/.pi/agent/skills/my-skill/SKILL.md")).toBe("user-skills");
		expect(detectScope("~/.pi/agent/agents/my-agent/SKILL.md")).toBe("user-agents");
	});

	it("defaults to project for unknown paths", () => {
		expect(detectScope("/some/random/path/SKILL.md")).toBe("project");
	});

	it("handles Windows-style backslashes", () => {
		expect(
			detectScope("C:\\Users\\user\\.pi\\agent\\skills\\my-skill\\SKILL.md"),
		).toBe("user-skills");
		expect(
			detectScope("C:\\Users\\user\\.pi\\agent\\agents\\my-agent\\SKILL.md"),
		).toBe("user-agents");
	});

	it("identifies skills in a directory named 'user-agents-extra' as user-skills", () => {
		// The path is under .pi/agent/skills/, so it's user-skills regardless
		// of the directory name.
		expect(
			detectScope("/home/user/.pi/agent/skills/user-agents-extra/SKILL.md"),
		).toBe("user-skills");
	});
});

// ---------------------------------------------------------------------------
// filterAndSort
// ---------------------------------------------------------------------------

describe("filterAndSort", () => {
	it("returns all skills sorted by name when query is empty and mode is 'name'", () => {
		const result = filterAndSort(SKILLS, "", "name");
		const names = result.map((s) => s.name);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		expect(result).toHaveLength(SKILLS.length);
	});

	it("filters then sorts — query restricts results, mode orders them", () => {
		// Two skills contain "s": "brainstorming", "use-pyspark", "skill-creator", "write-well" ... actually let's be specific
		const subset: SkillEntry[] = [
			{ name: "beta", description: "x".repeat(20), tokens: 5, path: "", inPrompt: false, scope: "project", pathDisplay: "" },
			{ name: "alpha", description: "x".repeat(40), tokens: 10, path: "", inPrompt: false, scope: "project", pathDisplay: "" },
			{ name: "gamma", description: "x".repeat(8), tokens: 2, path: "", inPrompt: false, scope: "project", pathDisplay: "" },
			{ name: "delta-extra", description: "x".repeat(16), tokens: 4, path: "", inPrompt: false, scope: "project", pathDisplay: "" },
		];
		// Filter: "a" matches all four entries (beta/alpha/gamma/delta-extra all contain "a").
		const result = filterAndSort(subset, "a", "tokens");
		// Expected order by tokens desc: alpha(10), beta(5), delta-extra(4), gamma(2)
		expect(result.map((s) => s.name)).toEqual(["alpha", "beta", "delta-extra", "gamma"]);
	});

	it("returns empty array when no skill matches the query", () => {
		expect(filterAndSort(SKILLS, "xyzzy-not-found", "name")).toHaveLength(0);
	});

	it("produces the same logical output as calling applyFilter + applySortMode", () => {
		const query = "s";
		const mode: SortMode = "tokens";
		const composed = applySortMode(applyFilter(SKILLS, query), mode);
		const combined = filterAndSort(SKILLS, query, mode);
		expect(combined).toEqual(composed);
	});
});
