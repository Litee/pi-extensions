/**
 * Pure, side-effect-free helpers for pi-system-prompt-browser.
 *
 * Kept separate from any TUI code so they can be exercised by unit tests
 * without pulling in `@earendil-works/pi-tui`.
 */

import { readFileSync } from "node:fs";

/* ------------------------------------------------------------------ */
/*  Interfaces                                                        */
/* ------------------------------------------------------------------ */

/** A resolved skill entry with its token estimate. */
export interface SkillWithTokens {
	name: string;
	filePath: string;
	tokens: number | null;
	error: boolean;
}

/** A resolved context file with its token estimate. */
export interface ContextFileWithTokens {
	path: string;
	tokens: number | null;
	error: boolean;
}

/** Options for the details-view formatter. */
export interface FormatDetailsOpts {
	skills: SkillWithTokens[];
	contextFiles: ContextFileWithTokens[];
	selectedTools: string[];
	appendSystemPrompt?: string;
	promptGuidelines?: string[];
}

/* ------------------------------------------------------------------ */
/*  Token helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Estimate token count from text content using the chars/4 heuristic.
 */
export function estimateTokensFromContent(content: string): number {
	return Math.ceil(content.length / 4);
}

/**
 * Read a file and estimate its token count using the chars/4 heuristic.
 *
 * Returns `{ tokens: null, error: true }` on any read failure so callers
 * can surface the problem without throwing.
 */
export function estimateTokensFromFile(filePath: string): {
	tokens: number | null;
	error: boolean;
} {
	try {
		const content = readFileSync(filePath, "utf-8");
		return { tokens: estimateTokensFromContent(content), error: false };
	} catch {
		return { tokens: null, error: true };
	}
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

/* ------------------------------------------------------------------ */
/*  Details-view formatter                                            */
/* ------------------------------------------------------------------ */

/**
 * Format the details view as a text block with sections for skills,
 * context files, selected tools, appended prompt, guidelines, and a
 * total token estimate.
 *
 * Sections are separated by blank lines. Each section has a header
 * with a total token count (for skills/context files) or just a count
 * (for guidelines).
 */
export function formatDetailsView(opts: FormatDetailsOpts): string {
	const lines: string[] = [];

	// ── Skills ────────────────────────────────────────────────────────────────
	const totalSkillTokens = opts.skills.reduce(
		(sum, s) => sum + (s.tokens ?? 0),
		0,
	);
	lines.push(`Skills (${formatTokens(totalSkillTokens)})`);
	if (opts.skills.length === 0) {
		lines.push("  (no skills)");
	} else {
		for (const skill of opts.skills) {
			const tok = skill.tokens !== null ? formatTokens(skill.tokens) : "?";
			lines.push(`  ${skill.name}  ~${tok} tokens`);
			if (skill.filePath) {
				lines.push(`    ${skill.filePath}`);
			}
			if (skill.error) {
				lines.push(`    (read error)`);
			}
		}
	}
	lines.push("");

	// ── Context Files ─────────────────────────────────────────────────────────
	const totalCtxTokens = opts.contextFiles.reduce(
		(sum, f) => sum + (f.tokens ?? 0),
		0,
	);
	lines.push(`Context files (${formatTokens(totalCtxTokens)})`);
	if (opts.contextFiles.length === 0) {
		lines.push("  (none)");
	} else {
		for (const file of opts.contextFiles) {
			const tok = file.tokens !== null ? formatTokens(file.tokens) : "?";
			lines.push(`  ${file.path}  ~${tok} tokens`);
			if (file.error) {
				lines.push(`    (read error)`);
			}
		}
	}
	lines.push("");

	// ── Selected Tools ────────────────────────────────────────────────────────
	const toolList =
		opts.selectedTools.length > 0
			? opts.selectedTools.join(", ")
			: "(none)";
	lines.push(`Selected tools: ${toolList}`);
	lines.push("");

	// ── Append System Prompt ──────────────────────────────────────────────────
	if (opts.appendSystemPrompt) {
		const appendLen = opts.appendSystemPrompt.length;
		const appendTokens = formatTokens(Math.ceil(appendLen / 4));
		lines.push(
			`Append system prompt: ~${appendTokens} tokens (${appendLen.toLocaleString()} chars)`,
		);
		lines.push("");
	}

	// ── Prompt Guidelines ─────────────────────────────────────────────────────
	if (opts.promptGuidelines && opts.promptGuidelines.length > 0) {
		lines.push(
			`Prompt guidelines (${opts.promptGuidelines.length})`,
		);
		for (const g of opts.promptGuidelines) {
			lines.push(`  ${g}`);
		}
		lines.push("");
	}

	// ── Total ─────────────────────────────────────────────────────────────────
	const totalAll = totalSkillTokens + totalCtxTokens;
	lines.push(`Total estimated: ~${formatTokens(totalAll)} tokens`);

	return lines.join("\n");
}
