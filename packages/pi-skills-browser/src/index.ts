/**
 * pi-skills-browser
 *
 * Registers a `/skills` command that opens an interactive TUI showing every
 * skill registered in the current pi session with its name and a compact
 * description token estimate.
 *
 * Keybindings inside the browser:
 *   ↑ / ↓          Navigate the list
 *   Ctrl-S          Toggle sort: name (alphabetical) ↔ tokens desc
 *   type anything   Filter by skill name (case-insensitive substring)
 *   ⌫ Backspace     Remove last character from the filter query
 *   Esc             Close
 *
 * This file is intentionally a thin shell — all testable logic lives in
 * `helpers.ts` (filter/sort/token estimate), `viewport.ts` (window + scroll
 * percent), `row.ts` (row rendering), and `keys.ts` (keypress dispatch).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import {
	estimateDescriptionTokens,
	filterAndSort,
	type SkillEntry,
	type SortMode,
} from "./helpers.js";
import { dispatchKey } from "./keys.js";
import { TOKEN_COL_WIDTH, buildRowLine, computeNameColWidth } from "./row.js";
import { computeScrollPercent, computeWindow } from "./viewport.js";

const MAX_VISIBLE_ROWS = 15;

export default function skillsBrowserExtension(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description:
			"Browse registered skills by name and description token count; type to filter, Ctrl-S to toggle sort",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Skills browser requires an interactive terminal", "warning");
				return;
			}

			const ctxWithOpts = ctx as { getSystemPromptOptions?: () => { skills?: Array<{ name: string }> } };
			if (typeof ctxWithOpts.getSystemPromptOptions !== "function") {
				ctx.ui?.notify?.("This feature requires pi 0.78.0 or later", "error");
				return;
			}
			const opts = ctxWithOpts.getSystemPromptOptions();
			const skillsInPrompt = new Set((opts.skills ?? []).map((s) => s.name));

			// Collect all skill commands registered in this session.
			const skills: SkillEntry[] = pi
				.getCommands()
				.filter((c) => c.source === "skill")
				.map((c) => ({
					name: c.name,
					description: c.description ?? "",
					tokens: estimateDescriptionTokens(c.description ?? ""),
					path: c.sourceInfo.path,
					inPrompt: skillsInPrompt.has(c.name),
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
							`Sort: ${namePart}  ${tokensPart}`,
							width,
						),
					);
					lines.push("");

					// ── Skill list ──
					const nameColWidth = computeNameColWidth(width);

					if (filtered.length === 0) {
						lines.push(
							truncateToWidth(theme.fg("warning", "  No skills match your filter"), width),
						);
					} else {
						const { start, end } = computeWindow(
							selectedIndex,
							filtered.length,
							MAX_VISIBLE_ROWS,
						);

						for (let i = start; i < end; i++) {
							const skill = filtered[i]!;
							const isSelected = i === selectedIndex;
							lines.push(
								truncateToWidth(
									buildRowLine(skill, isSelected, nameColWidth, TOKEN_COL_WIDTH, theme),
									width,
								),
							);
						}

						// Show a scroll hint when the list is taller than the viewport.
						if (filtered.length > MAX_VISIBLE_ROWS) {
							const pct = computeScrollPercent(selectedIndex, filtered.length);
							const pctLabel = pct === null ? "" : `  (${pct}%)`;
							lines.push(
								truncateToWidth(
									theme.fg(
										"dim",
										`  ··· ${filtered.length - MAX_VISIBLE_ROWS} more${pctLabel}`,
									),
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
								`↑↓ navigate · Ctrl-S sort · type to filter · ⌫ clear · esc close   ${pos}`,
							) +
								" " +
								theme.fg("success", "●") +
								theme.fg("dim", " in prompt"),
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
						// Escape closes the overlay; handled before the pure dispatcher
						// because it terminates the ctx.ui.custom promise via done().
						if (matchesKey(data, "escape")) {
							done(undefined);
							return;
						}

						const action = dispatchKey(data, matchesKey);
						switch (action.kind) {
							case "up":
								selectedIndex = Math.max(0, selectedIndex - 1);
								break;
							case "down": {
								const len = getFiltered().length;
								selectedIndex = Math.min(Math.max(0, len - 1), selectedIndex + 1);
								break;
							}
							case "toggle-sort":
								sortMode = sortMode === "name" ? "tokens" : "name";
								selectedIndex = 0;
								break;
							case "backspace":
								query = query.slice(0, -1);
								selectedIndex = 0;
								break;
							case "filter-char":
								query += action.char;
								selectedIndex = 0;
								break;
							case "ignore":
								return;
						}

						invalidate();
						tui.requestRender();
					},
				};
			});
		},
	});
}
