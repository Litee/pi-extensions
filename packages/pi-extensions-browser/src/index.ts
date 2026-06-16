/**
 * pi-extensions-browser
 *
 * Registers a `/extensions` command that opens an interactive TUI listing all
 * extension packages configured in pi settings — both user-level
 * (~/.pi/agent/settings.json) and project-level (.pi/settings.json).
 *
 * Each entry shows:
 *   • Package name (from package.json) or npm/git spec
 *   • Source path / spec
 *   • Health signal: ✓ path resolves  ⚠ path missing  ~ npm/git (unverified)
 *
 * Keybindings:
 *   ↑ / ↓          Navigate
 *   type anything   Filter by name or path (case-insensitive substring)
 *   ⌫ Backspace     Remove last filter character
 *   Esc             Close
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import {
	type ExtPackageEntry,
	buildSummary,
	filterEntries,
	loadEntries,
} from "./helpers.js";
import { renderEntry } from "./render.js";

export type { ExtPackageEntry };
export { buildSummary, filterEntries, loadEntries };
export {
	checkHealth,
	deriveName,
	detectKind,
	isLocalPathMissing,
	markConflicts,
	readPackageName,
	resolveHome,
	type SummaryStats,
} from "./helpers.js";
export { renderEntry } from "./render.js";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ROWS = 20;

export default function extensionsBrowserExtension(pi: ExtensionAPI): void {
	pi.registerCommand("extensions", {
		description:
			"Browse extension packages configured in pi settings, grouped by user and project scope",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Extensions browser requires an interactive terminal", "warning");
				return;
			}

			const all = loadEntries(process.cwd());

			if (all.length === 0) {
				ctx.ui.notify("No extension packages found in pi settings", "warning");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let query = "";
				let selectedIndex = 0;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;

				function invalidate(): void {
					cachedWidth = undefined;
					cachedLines = undefined;
				}

				function render(width: number): string[] {
					if (cachedLines !== undefined && cachedWidth === width) return cachedLines;

					const filtered = filterEntries(all, query);
					if (filtered.length === 0) {
						selectedIndex = 0;
					} else {
						selectedIndex = Math.max(0, Math.min(selectedIndex, filtered.length - 1));
					}

					const user = filtered.filter((e) => e.scope === "user");
					const project = filtered.filter((e) => e.scope === "project");
					const orderedItems: ExtPackageEntry[] = [...user, ...project];

					const hr = theme.fg("accent", "─".repeat(width));
					const lines: string[] = [];

					// Title + health summary
					const { ok: okCount, missing: missingCount, unverified: unverifiedCount, conflict: conflictCount } = buildSummary(filtered);
					const summary = [
						theme.fg("success", `${okCount} ✓ ok`),
						...(missingCount > 0 ? [theme.fg("error", `${missingCount} ⚠ missing`)] : []),
						...(unverifiedCount > 0 ? [theme.fg("dim", `${unverifiedCount} ~ npm/git`)] : []),
						...(conflictCount > 0 ? [theme.fg("warning", `${conflictCount} ⚡ conflict`)] : []),
					].join(theme.fg("dim", "  "));
					const totalLabel = theme.fg("dim", ` / ${all.length} total`);
					lines.push(
						truncateToWidth(
							theme.fg("accent", theme.bold("Extensions")) +
								theme.fg("dim", "  (") +
								summary +
								totalLabel +
								theme.fg("dim", ")"),
							width,
						),
					);
					lines.push(hr);

					// Filter row
					const filterBody = query
						? theme.fg("accent", query) + theme.fg("dim", "│")
						: theme.fg("dim", "type to filter…");
					lines.push(truncateToWidth(`Filter: ${filterBody}`, width));
					lines.push("");

					const maxNameLen = Math.max(...orderedItems.map((e) => e.name.length), 8);
					const nameColWidth = Math.min(maxNameLen + 1, Math.floor(width * 0.4));

					function renderSection(
						sectionItems: ExtPackageEntry[],
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
								renderEntry(
									sectionItems[i]!,
									globalOffset + i === selectedIndex,
									nameColWidth,
									width,
									theme,
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

					if (orderedItems.length === 0) {
						lines.push(
							truncateToWidth(theme.fg("warning", "  No extensions match your filter"), width),
						);
					} else {
						renderSection(user, "USER", 0);
						if (user.length > 0 && project.length > 0) lines.push("");
						renderSection(project, "PROJECT", user.length);
					}

					lines.push("");
					lines.push(hr);
					const pos =
						orderedItems.length > 0 ? `${selectedIndex + 1}/${orderedItems.length}` : "0/0";
					lines.push(
						truncateToWidth(
							theme.fg(
								"dim",
								`↑↓ navigate · type to filter · ⌫ clear · esc close   ${pos}`,		// ⚡ conflict count is shown in the header summary legend
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

						const filtered = filterEntries(all, query);
						const len = filtered.length;

						if (matchesKey(data, "up")) {
							selectedIndex = Math.max(0, selectedIndex - 1);
						} else if (matchesKey(data, "down")) {
							selectedIndex = Math.min(Math.max(0, len - 1), selectedIndex + 1);
						} else if (matchesKey(data, "backspace")) {
							query = query.slice(0, -1);
							selectedIndex = 0;
						} else if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
							query += data;
							selectedIndex = 0;
						} else {
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
