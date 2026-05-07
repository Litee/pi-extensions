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

// ─────────────────────────────────────────────────────────────────────────────
// Simple (no-bar) row renderer
// ─────────────────────────────────────────────────────────────────────────────

const SIMPLE_LABEL_WIDTH = 46;
const INDENT = "  ";

/**
 * Truncate a string from the left, preserving the tail.
 * Used so the end of a path (the filename) stays visible.
 */
function truncateLeft(s: string, max: number): string {
	if (s.length <= max) return s;
	return "\u2026" + s.slice(-(max - 1));
}

/**
 * Truncate a string from the right, preserving the head.
 * Used so a meaningful label prefix stays visible.
 */
function truncateRight(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "\u2026";
}

/**
 * Compress a file-system path to fit within `maxLen` characters.
 *
 * Strategy (applied in order until the path fits):
 *   1. Replace the home directory prefix with `~`.
 *   2. Keep the last two path segments:  `…/parent/file.md`
 *   3. Keep only the filename:           `…/file.md`
 *   4. Hard left-truncate as a last resort.
 *
 * @param inputPath  Absolute or relative path to compress.
 * @param maxLen     Maximum number of characters in the result.
 * @param homeDir    Optional home directory string (e.g. `/Users/alice`).
 *                   When provided, a leading match is replaced with `~`.
 */
export function compressPath(inputPath: string, maxLen: number, homeDir?: string): string {
	if (inputPath.length <= maxLen) return inputPath;

	// 1. Replace home directory with ~
	let p = inputPath;
	if (homeDir && p.startsWith(homeDir)) {
		p = "~" + p.slice(homeDir.length);
	}
	if (p.length <= maxLen) return p;

	// Detect path separator
	const sep = p.includes("/") ? "/" : "\\";
	const parts = p.split(sep).filter(Boolean);

	// 2. Keep last two segments: …/parent/file.md
	if (parts.length >= 2) {
		const candidate = "\u2026" + sep + parts.slice(-2).join(sep);
		if (candidate.length <= maxLen) return candidate;
	}

	// 3. Keep just the filename: …/file.md
	const last = parts[parts.length - 1];
	if (last !== undefined) {
		const candidate = "\u2026" + sep + last;
		if (candidate.length <= maxLen) return candidate;
	}

	// 4. Hard left-truncate
	return truncateLeft(p, maxLen);
}

/**
 * Render a label + token-count row with no bar or percentage.
 *
 * Layout: `<label padded/truncated to labelWidth>  ~<tokens>`
 */
export function renderSimpleRow(label: string, tokens: number, labelWidth: number): string {
	const paddedLabel = truncateLeft(label, labelWidth).padEnd(labelWidth);
	return `${paddedLabel}  ~${formatTokens(tokens)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Widget line builders
// ─────────────────────────────────────────────────────────────────────────────

/** Horizontal rule sized to match the widget width. */
function rule(label: string): string {
	const total = SIMPLE_LABEL_WIDTH + 8; // label col + "  ~" + token
	const dashes = Math.max(0, total - label.length - 6); // 6 = "──── " + " "
	return `\u2500\u2500\u2500\u2500 ${label} ${"\u2500".repeat(dashes)}`;
}

import type { SystemPromptBreakdown, ConversationBreakdown } from "./breakdown.js";

/**
 * Build the full widget line array.
 *
 * @param sp        System prompt breakdown.
 * @param conv      Conversation breakdown.
 * @param ctxWindow Context window size (from getContextUsage).
 * @param theme     Colour theme (pass NO_THEME for plain text).
 * @param homeDir   Home directory for path compression (e.g. from `os.homedir()`).
 */
export function buildWidgetLines(
	sp: SystemPromptBreakdown,
	conv: ConversationBreakdown,
	ctxWindow: number,
	theme: RenderTheme,
	homeDir?: string,
): string[] {
	const total = sp.total + conv.total;
	const W = SIMPLE_LABEL_WIDTH;
	const lines: string[] = [];

	const dim = (s: string) => theme.fg("dim", s);
	const row = (label: string, tokens: number) => renderSimpleRow(label, tokens, W);

	// Max chars available for a path after the indent
	const maxPathLen = W - INDENT.length;

	// ── Context Breakdown ────────────────────────────────────────────────────
	lines.push(theme.fg("accent", rule("Context Window Breakdown")));

	// System prompt section
	lines.push(theme.bold(row("System prompt", sp.total)));
	lines.push(dim(row(`${INDENT}core instructions`, sp.core)));

	const toolsLabel = sp.toolCount > 0 ? `${INDENT}tools (${sp.toolCount})` : `${INDENT}tools`;
	lines.push(dim(row(toolsLabel, sp.tools)));

	if (sp.guidelines > 0) {
		lines.push(dim(row(`${INDENT}guidelines`, sp.guidelines)));
	}

	for (const cf of sp.contextFiles) {
		const compressed = compressPath(cf.path, maxPathLen, homeDir);
		lines.push(dim(row(`${INDENT}${compressed}`, cf.tokens)));
	}

	if (sp.appendSystemPrompt > 0) {
		const paths = sp.appendSystemPromptPaths;
		let label: string;
		if (paths && paths.length === 1) {
			// Single file: show path like a context file row
			const compressed = compressPath(paths[0]!, maxPathLen, homeDir);
			label = `${INDENT}${compressed}`;
		} else if (paths && paths.length > 1) {
			// Multiple files: list count; individual paths would exceed one row
			label = `${INDENT}appended (${paths.length} files)`;
		} else if (sp.appendSystemPromptPreview) {
			// No file found (e.g. --append-system-prompt CLI flag): show content preview
			const prefix = `${INDENT}appended: "`;
			const suffix = `"`;
			const maxPreview = W - prefix.length - suffix.length;
			const preview = truncateRight(sp.appendSystemPromptPreview, maxPreview);
			label = `${prefix}${preview}${suffix}`;
		} else {
			label = `${INDENT}appended prompt`;
		}
		lines.push(dim(row(label, sp.appendSystemPrompt)));
	}

	if (sp.skillsCatalog > 0) {
		const skillsLabel =
			sp.skillCount > 0 ? `${INDENT}skills catalog (${sp.skillCount})` : `${INDENT}skills catalog`;
		lines.push(dim(row(skillsLabel, sp.skillsCatalog)));
	}

	// Conversation section
	lines.push(theme.bold(row("Conversation", conv.total)));
	lines.push(dim(row(`${INDENT}user messages`, conv.userMessages)));
	lines.push(dim(row(`${INDENT}assistant output`, conv.assistantOutput)));
	lines.push(dim(row(`${INDENT}tool results`, conv.toolResults)));

	// Footer
	lines.push(dim("\u2500".repeat(W + 8)));
	lines.push(theme.bold(`Total  ~${formatTokens(total)} / ${formatTokens(ctxWindow)}`));

	return lines;
}
