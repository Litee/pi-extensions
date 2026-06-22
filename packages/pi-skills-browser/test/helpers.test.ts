import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyFilter,
	applySortMode,
	detectPathDisplay,
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
// detectPathDisplay
// ---------------------------------------------------------------------------

describe("detectPathDisplay", () => {
	const cwd = "/projects/my-repo";

	it("strips cwd prefix and removes SKILL.md filename for a project skill", () => {
		const path = "/projects/my-repo/.pi/skills/my-skill/SKILL.md";
		expect(detectPathDisplay(path, cwd)).toBe(".pi/skills/my-skill");
	});

	it("strips cwd prefix for a nested path without SKILL.md suffix", () => {
		// A skill stored at a non-standard name still strips the cwd prefix.
		const path = "/projects/my-repo/custom/skill-dir";
		// dir = "custom/skill-dir" (no SKILL.md to strip) → returned as-is relative
		expect(detectPathDisplay(path, cwd)).toBe("custom/skill-dir");
	});

	it("returns the SKILL.md filename when SKILL.md sits directly in cwd (dir is empty)", () => {
		// When dir becomes "" after stripping the SKILL.md suffix the function
		// falls back to returning the unmodified `relative`.
		// relative = "SKILL.md", dir = "" (falsy) — falls back to returning relative
		expect(detectPathDisplay("/projects/my-repo/SKILL.md", cwd)).toBe("SKILL.md");
	});

	it("restores the ~ prefix for paths under the user home directory", () => {
		const home = homedir();
		const path = join(home, ".pi/agent/skills/my-skill/SKILL.md");
		const result = detectPathDisplay(path, cwd);
		expect(result).toBe(`~/.pi/agent/skills/my-skill/SKILL.md`);
	});

	it("expands a tilde path and then restores ~ for home-relative display", () => {
		// A path supplied as ~/... should be expanded then re-tilde'd.
		const tildePath = "~/.pi/agent/agents/my-agent/SKILL.md";
		const result = detectPathDisplay(tildePath, cwd);
		expect(result).toBe("~/.pi/agent/agents/my-agent/SKILL.md");
	});

	it("returns the path unchanged when it is outside cwd and home", () => {
		const path = "/opt/system/skills/SKILL.md";
		expect(detectPathDisplay(path, cwd)).toBe(path);
	});

	it("returns empty string when path equals cwd exactly (dir || relative fallback with both empty)", () => {
		// When normalized === cwdNorm, relative = "" and dir = "", so the ||
		// right-hand side is the value returned (both are "").
		expect(detectPathDisplay("/projects/my-repo", cwd)).toBe("");
	});

	it("handles the case where cwd IS the home directory (path under both)", () => {
		// cwd = homedir() — the cwd check fires first, so the path is stripped
		// relative to cwd without a leading ~.
		const home = homedir();
		const path = join(home, ".pi/skills/my-skill/SKILL.md");
		const result = detectPathDisplay(path, home);
		// Stripped relative to cwd (= home), not re-tilde'd
		expect(result).toBe(".pi/skills/my-skill");
	});
});

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
			{ name: "zeta", description: "abcd", tokens: 1, path: "", scope: "project", pathDisplay: "" },
			{ name: "alpha", description: "abcd", tokens: 1, path: "", scope: "project", pathDisplay: "" },
			{ name: "mango", description: "abcd", tokens: 1, path: "", scope: "project", pathDisplay: "" },
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

	it("paths under ~/.pi/agent/agents/ fall through to project scope", () => {
		expect(
			detectScope("/home/user/.pi/agent/agents/my-agent/SKILL.md"),
		).toBe("project");
	});

	it("handles tilde-prefixed paths", () => {
		expect(detectScope("~/.pi/agent/skills/my-skill/SKILL.md")).toBe("user-skills");
	});

	it("defaults to project for unknown paths", () => {
		expect(detectScope("/some/random/path/SKILL.md")).toBe("project");
	});

	it("handles Windows-style backslashes", () => {
		expect(
			detectScope("C:\\Users\\user\\.pi\\agent\\skills\\my-skill\\SKILL.md"),
		).toBe("user-skills");
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
			{ name: "beta", description: "x".repeat(20), tokens: 5, path: "", scope: "project", pathDisplay: "" },
			{ name: "alpha", description: "x".repeat(40), tokens: 10, path: "", scope: "project", pathDisplay: "" },
			{ name: "gamma", description: "x".repeat(8), tokens: 2, path: "", scope: "project", pathDisplay: "" },
			{ name: "delta-extra", description: "x".repeat(16), tokens: 4, path: "", scope: "project", pathDisplay: "" },
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
