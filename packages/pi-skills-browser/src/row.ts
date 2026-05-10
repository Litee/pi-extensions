/**
 * Pure row builder for the skills browser list.
 *
 * Extracted from `index.ts` so column-budget / truncation / selection styling
 * can be unit-tested without a live pi-tui runtime.
 *
 * NOTE: the caller is still responsible for outer `truncateToWidth` wrapping
 * — this module only produces the inner `arrow + name + padding + badge`
 * string.
 */

import { formatTokens, type SkillEntry } from "./helpers.js";

/** Minimal theme surface used by the row builder. Kept structural so tests can
 * supply a plain object without depending on pi-coding-agent's `Theme` class. */
export interface RowTheme {
	fg(color: string, text: string): string;
}

/** Arrow + space prefix per row ("  " or "> "). */
export const ARROW_COL_WIDTH = 2;
/** Token badge column: wide enough for "[9.9k tok]" plus a leading space. */
export const TOKEN_COL_WIDTH = 12;

/**
 * Compute the name column width given the total available width.
 * Guaranteed to be at least 4 so that `slice(0, nameColWidth - 1) + "…"`
 * always produces a non-empty truncated label.
 */
export function computeNameColWidth(width: number): number {
	return Math.max(4, width - ARROW_COL_WIDTH - TOKEN_COL_WIDTH);
}

/**
 * Build a single list row: `"{arrow}{styledName}{padding}{styledBadge}"`.
 *
 * - Name is truncated with a trailing `…` if it exceeds `nameColWidth`.
 * - Selected rows get the `"accent"` colour; unselected badges get `"dim"`.
 * - The badge is `.padStart(tokenColWidth)` so badges right-align under the
 *   column.
 */
export function buildRowLine(
	skill: SkillEntry,
	isSelected: boolean,
	nameColWidth: number,
	tokenColWidth: number,
	theme: RowTheme,
): string {
	const arrow = isSelected ? theme.fg("accent", "> ") : "  ";

	// Truncate the plain name first so we can measure its visible width
	// without ANSI codes, then apply colours.
	const plainName =
		skill.name.length > nameColWidth
			? `${skill.name.slice(0, nameColWidth - 1)}…`
			: skill.name;
	const padding = " ".repeat(Math.max(0, nameColWidth - plainName.length));
	const styledName = isSelected ? theme.fg("accent", plainName) : plainName;

	const badge = `[${formatTokens(skill.tokens)} tok]`;
	const paddedBadge = badge.padStart(tokenColWidth);
	const styledBadge = isSelected
		? theme.fg("accent", paddedBadge)
		: theme.fg("dim", paddedBadge);

	return `${arrow}${styledName}${padding}${styledBadge}`;
}
