/**
 * Pure widget-line rendering helpers for pi-context-window-analysis.
 *
 * No pi-ai / pi-coding-agent / pi-tui imports here so these functions
 * can be exercised by unit tests without a live pi runtime.
 */

const FULL_BLOCK = "█";
const EMPTY_BLOCK = "░";

// ────────────────────────────────────────────────────────────────────────────
// Primitive renderers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Render a horizontal progress bar of `width` characters.
 *
 * @param value  Current value (numerator).
 * @param max    Maximum value (denominator). If ≤ 0 the bar is empty.
 * @param width  Total bar width in characters.
 */
export function renderBar(value: number, max: number, width: number): string {
	if (width <= 0) return "";
	if (max <= 0 || value <= 0) return EMPTY_BLOCK.repeat(width);

	const ratio = Math.min(1, value / max);
	// Always show at least 1 full block when value > 0.
	const filled = value > 0 ? Math.max(1, Math.round(ratio * width)) : 0;
	const empty = width - filled;
	return FULL_BLOCK.repeat(filled) + EMPTY_BLOCK.repeat(empty);
}

/**
 * Format a token count for compact display.
 *
 * < 1000  → `"123"`
 * < 10000 → `"1.2k"` (one decimal)
 * ≥ 10000 → `"12k"`  (no decimals)
 */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	return `${(n / 1000).toFixed(n < 100000 ? 1 : 0)}k`;
}

/**
 * Render a single breakdown row as a plain string.
 *
 * Layout (all widths in characters):
 *   `<label padded to labelWidth>  <bar barWidth>  <pct%>  ~<tokens>`
 *
 * @param label       Row label (already indented as desired by the caller).
 * @param tokens      Token count for this row.
 * @param parentTokens  Token count of the parent section (used as bar max and for percentage).
 *                    When 0 or less, the bar is empty and the percentage shows as "  0%".
 * @param barWidth    Width of the bar in characters.
 * @param labelWidth  Column width for the label (padded with spaces).
 */
export function renderRow(
	label: string,
	tokens: number,
	parentTokens: number,
	barWidth: number,
	labelWidth: number,
): string {
	const paddedLabel = label.padEnd(labelWidth);
	const bar = renderBar(tokens, parentTokens, barWidth);
	const pct = parentTokens > 0 ? Math.round((tokens / parentTokens) * 100) : 0;
	const pctStr = `${pct}%`.padStart(4);
	const tokStr = `~${formatTokens(tokens)}`;
	return `${paddedLabel}  ${bar}  ${pctStr}  ${tokStr}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Colour-theme injection
// ────────────────────────────────────────────────────────────────────────────

/** Minimal theme interface — only the parts this module uses. */
export interface RenderTheme {
	fg(color: "accent" | "dim" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
}

/** Identity theme used in tests (no ANSI codes). */
export const NO_THEME: RenderTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

// ────────────────────────────────────────────────────────────────────────────
// Widget line builders
// ────────────────────────────────────────────────────────────────────────────

const BAR_WIDTH = 20;
const LABEL_WIDTH = 21;
const INDENT = "  ";

/** Horizontal rule line. */
function rule(label: string): string {
	const pad = "─".repeat(4);
	return `${pad} ${label} ${"─".repeat(Math.max(0, 50 - label.length - 7))}`;
}

/** Usage stats from the last AssistantMessage. */
export interface LastTurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

import type { SystemPromptBreakdown, ConversationBreakdown } from "./breakdown.js";

/**
 * Build the full widget line array.
 *
 * @param sp       System prompt breakdown.
 * @param conv     Conversation breakdown.
 * @param usage    Last-turn actual usage (from AssistantMessage.usage), or undefined.
 * @param total    Total estimated context tokens (sp.total + conv.total).
 * @param ctxWindow  Context window size (from getContextUsage).
 * @param theme    Colour theme (pass NO_THEME for plain text).
 */
export function buildWidgetLines(
	sp: SystemPromptBreakdown,
	conv: ConversationBreakdown,
	usage: LastTurnUsage | undefined,
	ctxWindow: number,
	theme: RenderTheme,
): string[] {
	const total = sp.total + conv.total;
	const lines: string[] = [];

	// ── Context Breakdown ────────────────────────────────────────────────
	lines.push(theme.fg("accent", rule("Context Breakdown")));

	// System prompt row
	lines.push(
		theme.bold(
			renderRow("System prompt", sp.total, total, BAR_WIDTH, LABEL_WIDTH),
		),
	);

	// Sub-rows for system prompt (percentages relative to sp.total)
	lines.push(
		theme.fg("dim", renderRow(`${INDENT}core instructions`, sp.core, sp.total, BAR_WIDTH, LABEL_WIDTH)),
	);

	// Tools — show count if non-zero
	const toolsLabel = `${INDENT}tools`;
	lines.push(theme.fg("dim", renderRow(toolsLabel, sp.tools, sp.total, BAR_WIDTH, LABEL_WIDTH)));

	if (sp.guidelines > 0) {
		lines.push(
			theme.fg("dim", renderRow(`${INDENT}guidelines`, sp.guidelines, sp.total, BAR_WIDTH, LABEL_WIDTH)),
		);
	}

	if (sp.appendSystemPrompt > 0) {
		lines.push(
			theme.fg(
				"dim",
				renderRow(`${INDENT}appended prompt`, sp.appendSystemPrompt, sp.total, BAR_WIDTH, LABEL_WIDTH),
			),
		);
	}

	for (const cf of sp.contextFiles) {
		// Use the last path segment as label
		const segments = cf.path.split(/[/\\]/).filter(Boolean);
		const fileName = segments[segments.length - 1] ?? cf.path;
		lines.push(
			theme.fg("dim", renderRow(`${INDENT}${fileName}`, cf.tokens, sp.total, BAR_WIDTH, LABEL_WIDTH)),
		);
	}

	if (sp.skillsCatalog > 0) {
		lines.push(
			theme.fg(
				"dim",
				renderRow(`${INDENT}skills catalog`, sp.skillsCatalog, sp.total, BAR_WIDTH, LABEL_WIDTH),
			),
		);
	}

	// Conversation row
	lines.push(
		theme.bold(
			renderRow("Conversation", conv.total, total, BAR_WIDTH, LABEL_WIDTH),
		),
	);

	lines.push(
		theme.fg(
			"dim",
			renderRow(`${INDENT}user messages`, conv.userMessages, conv.total, BAR_WIDTH, LABEL_WIDTH),
		),
	);
	lines.push(
		theme.fg(
			"dim",
			renderRow(`${INDENT}assistant output`, conv.assistantOutput, conv.total, BAR_WIDTH, LABEL_WIDTH),
		),
	);
	lines.push(
		theme.fg(
			"dim",
			renderRow(`${INDENT}tool results`, conv.toolResults, conv.total, BAR_WIDTH, LABEL_WIDTH),
		),
	);

	// ── Last turn (actual) ───────────────────────────────────────────────
	if (usage) {
		lines.push(theme.fg("accent", rule("Last turn (actual)")));
		const inputSent = usage.input;
		lines.push(renderRow(`${INDENT}input sent`, inputSent, inputSent, BAR_WIDTH, LABEL_WIDTH));
		lines.push(
			theme.fg("dim", renderRow(`${INDENT}cache read`, usage.cacheRead, inputSent, BAR_WIDTH, LABEL_WIDTH)),
		);
		lines.push(
			theme.fg("dim", renderRow(`${INDENT}cache write`, usage.cacheWrite, inputSent, BAR_WIDTH, LABEL_WIDTH)),
		);
		lines.push(
			theme.fg("dim", renderRow(`${INDENT}output`, usage.output, inputSent, BAR_WIDTH, LABEL_WIDTH)),
		);
		lines.push(theme.fg("dim", `${"  ".padEnd(LABEL_WIDTH + 2)}cost   $${usage.cost.toFixed(4)}`));
	}

	// ── Footer ───────────────────────────────────────────────────────────
	lines.push(theme.fg("dim", "─".repeat(53)));

	const pct = ctxWindow > 0 ? Math.round((total / ctxWindow) * 100) : 0;
	const bar = renderBar(total, ctxWindow, BAR_WIDTH);
	const totalLine =
		`Total  ~${formatTokens(total)} / ${formatTokens(ctxWindow)}  (${pct}%)  ${bar}`;
	lines.push(theme.bold(totalLine));

	return lines;
}
