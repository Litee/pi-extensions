/**
 * Pure, side-effect-free helpers for pi-skills-browser.
 *
 * Kept separate from `index.ts` so they can be exercised by unit tests
 * without pulling in the pi-tui / pi-coding-agent runtime.
 */

/** Sort order for the skills list. */
export type SortMode = "name" | "tokens";

/** A resolved skill entry ready for display. */
export interface SkillEntry {
	name: string;
	description: string;
	/** Pre-computed description token estimate. */
	tokens: number;
	path: string;
	/** True when this skill appears in the current system prompt. */
	inPrompt: boolean;
}

/**
 * Rough token estimate for a skill description using the standard chars/4
 * heuristic (same as pi's internal `estimateTokens`).
 */
export function estimateDescriptionTokens(description: string): number {
	return Math.ceil(description.length / 4);
}

/**
 * Format a token count for compact display.
 *
 * <1000   → `"123"`
 * <10000  → `"1.2k"` (one decimal place)
 * ≥10000  → `"12k"`  (no decimals)
 */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

/**
 * Filter skills by a query string.
 *
 * Performs a case-insensitive substring match on the skill name.
 * Returns the original array unchanged when query is empty or whitespace-only,
 * avoiding an unnecessary allocation.
 */
export function applyFilter(skills: SkillEntry[], query: string): SkillEntry[] {
	const trimmed = query.trim();
	if (!trimmed) return skills;
	const lower = trimmed.toLowerCase();
	return skills.filter((s) => s.name.toLowerCase().includes(lower));
}

/**
 * Sort skills by the given mode and return a new array (never mutates input).
 *
 * "name"   → ascending alphabetical by name
 * "tokens" → descending by token count, then ascending by name for ties
 */
export function applySortMode(skills: SkillEntry[], mode: SortMode): SkillEntry[] {
	const copy = [...skills];
	if (mode === "name") {
		copy.sort((a, b) => a.name.localeCompare(b.name));
	} else {
		copy.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
	}
	return copy;
}

/**
 * Filter and sort skills in one step.
 * Equivalent to `applySortMode(applyFilter(skills, query), mode)`.
 */
export function filterAndSort(skills: SkillEntry[], query: string, mode: SortMode): SkillEntry[] {
	return applySortMode(applyFilter(skills, query), mode);
}
