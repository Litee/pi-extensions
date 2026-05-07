/**
 * pi-skills-browser
 *
 * Registers a `/skills` command that opens an interactive TUI showing every
 * skill registered in the current pi session with its name and a compact
 * description token estimate.
 *
 * Keybindings inside the browser:
 *   ↑ / ↓          Navigate the list
 *   s               Toggle sort: name (alphabetical) ↔ tokens desc
 *   type anything   Filter by skill name (case-insensitive substring)
 *   ⌫ Backspace     Remove last character from the filter query
 *   Esc             Close
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

import {
	estimateDescriptionTokens,
	filterAndSort,
	formatTokens,
	type SkillEntry,
	type SortMode,
} from "./helpers.js";

const MAX_VISIBLE_ROWS = 15;
// Token badge column: wide enough for "[9.9k tok]" plus a leading space
const TOKEN_COL_WIDTH = 12;
// Arrow + space prefix per row
const ARROW_COL_WIDTH = 2;

export default function skillsBrowserExtension(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description:
			"Browse registered skills by name and description token count; type to filter, s to toggle sort",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Skills browser requires an interactive terminal", "warning");
				return;
			}

			// Collect all skill commands registered in this session.
			const skills: SkillEntry[] = pi
				.getCommands()
				.filter((c) => c.source === "skill")
				.map((c) => ({
					name: c.name,
					description: c.description ?? "",
					tokens: estimateDescriptionTokens(c.description ?? ""),
					path: c.sourceInfo.path,
				}));

			if (skills.length === 0) {
				ctx.ui.notify("No skills registered in this session", "warning");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let query = "";
				let sortMode: SortMode = "name";
				let selectedIndex = 0;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;

				function getFiltered(): SkillEntry[] {
					return filterAndSort(skills, query, sortMode);
				}

				function clampIndex(len: number): void {
					if (len === 0) {
						selectedIndex = 0;
					} else {
						selectedIndex = Math.max(0, Math.min(selectedIndex, len - 1));
					}
				}

				function invalidate(): void {
					cachedWidth = undefined;
					cachedLines = undefined;
				}

				function render(width: number): string[] {
					if (cachedLines !== undefined && cachedWidth === width) return cachedLines;

					const filtered = getFiltered();
					clampIndex(filtered.length);

					const hr = theme.fg("accent", "─".repeat(width));
					const lines: string[] = [];

					// ── Title ──
					const countInfo = theme.fg("dim", ` (${filtered.length}/${skills.length})`);
					lines.push(
						truncateToWidth(
							theme.fg("accent", theme.bold("Skills Browser")) + countInfo,
							width,
						),
					);
					lines.push(hr);

					// ── Filter row ──
					const filterLabel = "Filter: ";
					const filterBody = query
						? theme.fg("accent", query) + theme.fg("dim", "│")
						: theme.fg("dim", "type to filter…");
					lines.push(truncateToWidth(filterLabel + filterBody, width));

					// ── Sort row ──
					const isNameSort = sortMode === "name";
					const namePart = isNameSort
						? theme.fg("accent", theme.bold("name"))
						: theme.fg("dim", "name");
					const tokensPart = !isNameSort
						? theme.fg("accent", theme.bold("tokens↓"))
						: theme.fg("dim", "tokens↓");
					lines.push(
						truncateToWidth(
							`Sort: ${namePart}  ${tokensPart}  ${theme.fg("dim", "(s to switch)")}`,
							width,
						),
					);
					lines.push("");

					// ── Skill list ──
					const nameColWidth = Math.max(4, width - ARROW_COL_WIDTH - TOKEN_COL_WIDTH);

					if (filtered.length === 0) {
						lines.push(
							truncateToWidth(theme.fg("warning", "  No skills match your filter"), width),
						);
					} else {
						// Window the list so we always show at most MAX_VISIBLE_ROWS rows and
						// keep the selected row roughly in the middle of the viewport.
						const windowStart = Math.max(
							0,
							Math.min(
								selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
								Math.max(0, filtered.length - MAX_VISIBLE_ROWS),
							),
						);
						const windowEnd = Math.min(filtered.length, windowStart + MAX_VISIBLE_ROWS);

						for (let i = windowStart; i < windowEnd; i++) {
							const skill = filtered[i]!;
							const isSelected = i === selectedIndex;

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
							const paddedBadge = badge.padStart(TOKEN_COL_WIDTH);
							const styledBadge = isSelected
								? theme.fg("accent", paddedBadge)
								: theme.fg("dim", paddedBadge);

							lines.push(
								truncateToWidth(`${arrow}${styledName}${padding}${styledBadge}`, width),
							);
						}

						// Show a scroll hint when the list is taller than the viewport.
						if (filtered.length > MAX_VISIBLE_ROWS) {
							const pct = Math.round((selectedIndex / (filtered.length - 1)) * 100);
							lines.push(
								truncateToWidth(
									theme.fg("dim", `  ··· ${filtered.length - MAX_VISIBLE_ROWS} more  (${pct}%)`),
									width,
								),
							);
						}
					}

					// ── Footer ──
					lines.push("");
					lines.push(hr);
					const pos =
						filtered.length > 0 ? `${selectedIndex + 1}/${filtered.length}` : "0/0";
					lines.push(
						truncateToWidth(
							theme.fg(
								"dim",
								`↑↓ navigate · s sort · type to filter · ⌫ clear · esc close   ${pos}`,
							),
							width,
						),
					);

					cachedLines = lines;
					cachedWidth = width;
					return lines;
				}

				return {
					render,
					invalidate,
					handleInput(data: string) {
						if (matchesKey(data, "escape")) {
							done(undefined);
							return;
						}

						if (matchesKey(data, "up")) {
							selectedIndex = Math.max(0, selectedIndex - 1);
							invalidate();
							tui.requestRender();
							return;
						}

						if (matchesKey(data, "down")) {
							const len = getFiltered().length;
							selectedIndex = Math.min(Math.max(0, len - 1), selectedIndex + 1);
							invalidate();
							tui.requestRender();
							return;
						}

						// "s" toggles sort mode — intentionally NOT added to the filter query.
						if (matchesKey(data, "s")) {
							sortMode = sortMode === "name" ? "tokens" : "name";
							selectedIndex = 0;
							invalidate();
							tui.requestRender();
							return;
						}

						// Backspace / Delete → remove last filter character.
						if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
							query = query.slice(0, -1);
							selectedIndex = 0;
							invalidate();
							tui.requestRender();
							return;
						}

						// Printable character (excluding "s" already handled above) → filter.
						if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
							query += data;
							selectedIndex = 0;
							invalidate();
							tui.requestRender();
							return;
						}
					},
				};
			});
		},
	});
}
