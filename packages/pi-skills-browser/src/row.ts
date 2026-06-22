/**
 * Pure row builder for the skills browser list.
 *
 * Extracted from `index.ts` so column-budget / truncation / selection styling
 * can be unit-tested without a live pi-tui runtime.
 *
 * NOTE: the caller is still responsible for outer `truncateToWidth` wrapping
 * — this module only produces the inner `arrow + name + path + padding + badge`
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

/** Separator between skill name and embedded path display. */
const NAME_PATH_SEP = "  ";

/**
 * Name column width: fixed (40 — enough for ~38 char names with
 * room to grow). Two spaces separate name and path columns.
 * The path column takes all remaining space.
 */
export function computeNameColWidth(_width: number): number {
	return 40;
}

/**
 * Compute the path column width: everything left after arrow, name,
 * and badge columns.
 */
export function computePathColWidth(width: number, nameColWidth: number): number {
	return width - ARROW_COL_WIDTH - nameColWidth - 2 - TOKEN_COL_WIDTH;
}

/**
 * Truncate a string to `maxLen` characters, appending "…" if truncated.
 */
function truncate(str: string, maxLen: number): string {
	return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}

/**
 * Build a single list row:
 * `"{arrow}{nameCol}{pathCol}{badge}"`.
 *
 * - The name column is left-aligned, truncated at `nameColWidth`.
 * - The path column is left-aligned, truncated at `pathColWidth`, dimmed.
 * - Selected rows get the `"accent"` colour; unselected badges get `"dim"`.
 * - The badge is `.padStart(tokenColWidth)` so badges right-align under the
 *   column.
 */
export function buildRowLine(
	skill: SkillEntry,
	isSelected: boolean,
	nameColWidth: number,
	pathColWidth: number,
	tokenColWidth: number,
	theme: RowTheme,
): string {
	const arrow = isSelected ? theme.fg("accent", "> ") : "  ";

	// Split the combined name into skill-name and path-display parts.
	const rawName = skill.name;
	const sepIndex = rawName.indexOf(NAME_PATH_SEP);
	const namePart = sepIndex !== -1 ? rawName.slice(0, sepIndex) : rawName;
	const pathPart = sepIndex !== -1 ? rawName.slice(sepIndex + NAME_PATH_SEP.length) : "";

	// Truncate each part to its column width.
	const visibleName = truncate(namePart, nameColWidth);
	const visiblePath = pathPart.length > 0 ? truncate(pathPart, pathColWidth) : "";

	// Right-pad each column to its fixed width, then style.
	const paddedName = visibleName + " ".repeat(Math.max(0, nameColWidth - visibleName.length));
	const paddedPath = visiblePath + " ".repeat(Math.max(0, pathColWidth - visiblePath.length));

	const styledName = isSelected
		? theme.fg("accent", paddedName)
		: paddedName;
	const styledPath = pathPart.length > 0
		? theme.fg("dim", paddedPath)
		: paddedPath;

	const badge = `[${formatTokens(skill.tokens)} tok]`;
	const paddedBadge = badge.padStart(tokenColWidth);
	const styledBadge = isSelected
		? theme.fg("accent", paddedBadge)
		: theme.fg("dim", paddedBadge);

	return `${arrow}${styledName}  ${styledPath}${styledBadge}`;
}
