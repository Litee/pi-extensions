/**
 * pi-skills-browser
 *
 * Registers a `/skills` command that opens an interactive TUI showing every
 * skill registered in the current pi session with its name and a compact
 * description token estimate.
 *
 * Keybindings inside the browser:
 *   ↑ / ↓          Navigate the list
 *   ctrl-s          Toggle sort: name (alphabetical) ↔ tokens desc
 *   type anything   Filter by skill name (case-insensitive substring)
 *   ⌫ Backspace     Remove last character from the filter query
 *   Esc             Close
 *
 * This file is intentionally a thin shell — all testable logic lives in
 * `helpers.ts` (filter/sort/token estimate), `row.ts` (row rendering), and
 * `keys.ts` (keypress dispatch).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import {
	detectPathDisplay,
	detectScope,
	estimateDescriptionTokens,
	filterAndSort,
	type SkillEntry,
	type SortMode,
} from "./helpers.js";
import { dispatchKey } from "./keys.js";
import { TOKEN_COL_WIDTH, buildRowLine, computeNameColWidth, computePathColWidth } from "./row.js";

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

			// Collect all skill commands registered in this session.
			const skills: SkillEntry[] = pi
				.getCommands()
				.filter((c) => c.source === "skill")
				.map((c) => {
					const displayName = c.name.startsWith("skill:") ? c.name.slice("skill:".length) : c.name;
					return {
						name: `${displayName}  ${detectPathDisplay(c.sourceInfo.path, process.cwd())}`,
					description: c.description ?? "",
					tokens: estimateDescriptionTokens(c.description ?? ""),
						path: c.sourceInfo.path,
						pathDisplay: detectPathDisplay(c.sourceInfo.path, process.cwd()),
						scope: detectScope(c.sourceInfo.path),
					};
				});

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

					// ── Skill list (grouped by source directory) ──
					const nameColWidth = computeNameColWidth(width);

					function renderSection(
						sectionItems: SkillEntry[],
						title: string,
						globalOffset: number,
					): void {
						if (sectionItems.length === 0) return;
						const bar = "─".repeat(Math.max(0, width - title.length - 7));
						lines.push(
							truncateToWidth(
								theme.fg("dim", `── ${title} (${sectionItems.length}) `) +
									theme.fg("accent", bar),
								width,
							),
						);

						const selInSection =
							selectedIndex >= globalOffset &&
							selectedIndex < globalOffset + sectionItems.length
								? selectedIndex - globalOffset
								: -1;

						const visStart =
							selInSection < 0
								? 0
								: Math.max(
										0,
										Math.min(
											selInSection - Math.floor(MAX_VISIBLE_ROWS / 2),
											sectionItems.length - MAX_VISIBLE_ROWS,
										),
									);
						const visEnd = Math.min(sectionItems.length, visStart + MAX_VISIBLE_ROWS);

						for (let i = visStart; i < visEnd; i++) {
							lines.push(
								truncateToWidth(
									buildRowLine(
										sectionItems[i]!,
										globalOffset + i === selectedIndex,
										nameColWidth,
														computePathColWidth(width, nameColWidth),
										TOKEN_COL_WIDTH,
										theme,
									),
									width,
								),
							);
						}

						if (sectionItems.length > MAX_VISIBLE_ROWS) {
							lines.push(
								truncateToWidth(
									theme.fg("dim", `  ··· ${sectionItems.length - MAX_VISIBLE_ROWS} more`),
									width,
								),
							);
						}
					}

					if (filtered.length === 0) {
						lines.push(
							truncateToWidth(theme.fg("warning", "  No skills match your filter"), width),
						);
					} else {
						// Group by scope: user-skills first, then project
						const userSkills = filtered.filter((s) => s.scope === "user-skills");
						const projectSkills = filtered.filter((s) => s.scope === "project");

						let offset = 0;

						if (userSkills.length > 0) {
							renderSection(userSkills, "USER-SKILLS", offset);
							offset += userSkills.length;
						}
						if (projectSkills.length > 0) {
							if (offset > 0) lines.push("");
							renderSection(projectSkills, "PROJECT", offset);
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
								`↑↓ navigate · ctrl-s sort · type to filter · ⌫ clear · esc close   ${pos}`,
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
