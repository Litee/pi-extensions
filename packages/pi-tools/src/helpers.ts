/**
 * Pure, side-effect-free helpers for pi-tool-info.
 *
 * Kept separate from `index.ts` so they can be exercised by unit tests
 * without pulling in the pi-tui/pi-coding-agent runtime.
 */

import type { ToolInfo } from "@mariozechner/pi-coding-agent";

/**
 * Collapse whitespace and truncate `text` to at most `max` visible
 * characters. Avoids cutting mid-word: if a word boundary exists within the
 * last 50% of the budget, the string is cut there. Ends with a single
 * ellipsis character (`…`) when truncation actually happened.
 *
 * `max` is interpreted as the maximum visible-width budget including the
 * ellipsis. Callers that only have very tight budgets should still pass a
 * positive value; the function clamps to ≥1.
 */
export function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	// Degenerate budgets: no room for anything, or only enough for the ellipsis.
	if (max <= 0) return "";
	if (max === 1) return "…";
	const budget = max - 1; // reserve 1 char for the ellipsis
	const slice = collapsed.slice(0, budget);
	const lastSpace = slice.lastIndexOf(" ");
	const base = lastSpace > Math.floor(budget / 2) ? slice.slice(0, lastSpace) : slice;
	return `${base.trimEnd()}…`;
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
 * Rough token estimate for a tool's system-prompt footprint.
 *
 * Uses the same `chars/4` heuristic pi uses internally in its `estimateTokens`
 * (see `packages/coding-agent/src/core/compaction/compaction.ts` in the
 * pi-coding-agent source). Counts the tool name + description + serialized
 * parameter schema — that is what providers include in the tool manifest on
 * every request.
 */
export function estimateToolTokens(tool: ToolInfo): number {
	let chars = tool.name.length;
	if (tool.description) chars += tool.description.length;
	try {
		chars += JSON.stringify(tool.parameters ?? {}).length;
	} catch {
		chars += String(tool.parameters ?? "").length;
	}
	return Math.ceil(chars / 4);
}

/**
 * Produce a short, human-readable label for `tool.sourceInfo`.
 *
 * For built-in tools the synthetic `<builtin:name>` path is suppressed so the
 * label reads `"builtin"`. For SDK / extension tools with a real path, the
 * label is `"<source> · <path>"`.
 */
export function sourceLabel(tool: ToolInfo): string {
	const src = tool.sourceInfo?.source ?? "unknown";
	const path = tool.sourceInfo?.path;
	return path && path !== `<builtin:${tool.name}>` ? `${src} · ${path}` : src;
}

/**
 * Build the title line for the interactive tool selector.
 *
 * Shows both active and total token counts so the user can see the cost of
 * currently-enabled tools and the ceiling of "what if I enabled everything."
 * When `activeTokens === totalTokens` (every tool enabled) the parenthetical
 * "(N total)" is suppressed to avoid visual noise.
 *
 * Example outputs:
 *   `"Tools (12 total · 5 active · ~1.2k active tokens, 3.4k total)"`
 *   `"Tools (12 total · 12 active · ~3.4k tokens)"`  (all active)
 */
export function buildSelectorTitle(
	toolCount: number,
	activeCount: number,
	activeTokens: number,
	totalTokens: number,
): string {
	const allActive = activeCount === toolCount;
	const tokenPart = allActive
		? `~${formatTokens(totalTokens)} tokens`
		: `~${formatTokens(activeTokens)} active tokens, ${formatTokens(totalTokens)} total`;
	return `Tools (${toolCount} total · ${activeCount} active · ${tokenPart})`;
}
