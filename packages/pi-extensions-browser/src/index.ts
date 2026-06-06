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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface ExtPackageEntry {
	/** Display name: package.json#name for local paths, spec for npm/git */
	name: string;
	/** Raw string from settings.json (may start with _ for disabled entries) */
	raw: string;
	/** Path or spec with leading _ stripped */
	spec: string;
	scope: "project" | "user";
	kind: "local" | "npm" | "other";
	health: "ok" | "missing" | "unverified";
	/** True when the raw entry starts with _ (explicitly disabled by user) */
	disabled: boolean;
	/** True when the same package name appears in both user and project scope */
	conflict: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testability)
// ---------------------------------------------------------------------------

export function detectKind(spec: string): "local" | "npm" | "other" {
	if (spec.startsWith("npm:")) return "npm";
	if (
		spec.startsWith("/") ||
		spec.startsWith("./") ||
		spec.startsWith("~/") ||
		spec.startsWith("~\\") ||
		/^[a-zA-Z]:[\\/]/.test(spec)
	)
		return "local";
	return "other";
}

export function resolveHome(spec: string): string {
	if (spec.startsWith("~/") || spec.startsWith("~\\")) {
		return join(homedir(), spec.slice(2));
	}
	return spec;
}

export function checkHealth(spec: string, kind: "local" | "npm" | "other"): "ok" | "missing" | "unverified" {
	if (kind === "local") {
		return existsSync(resolveHome(spec)) ? "ok" : "missing";
	}
	return "unverified";
}

export function readPackageName(dir: string): string | undefined {
	try {
		const pkgPath = join(dir, "package.json");
		if (!existsSync(pkgPath)) return undefined;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
		return typeof pkg.name === "string" ? pkg.name : undefined;
	} catch {
		return undefined;
	}
}

export function deriveName(
	spec: string,
	kind: "local" | "npm" | "other",
	health: "ok" | "missing" | "unverified",
): string {
	if (kind === "npm") {
		const bare = spec.replace(/^npm:/, "");
		const atIdx = bare.startsWith("@") ? bare.indexOf("@", 1) : bare.indexOf("@");
		return atIdx > 0 ? bare.slice(0, atIdx) : bare;
	}
	if (kind === "local") {
		if (health === "missing") return spec.split("/").at(-1) ?? spec;
		return readPackageName(resolveHome(spec)) ?? spec.split("/").at(-1) ?? spec;
	}
	return spec;
}

function readPackageList(settingsPath: string): string[] {
	try {
		if (!existsSync(settingsPath)) return [];
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			packages?: unknown[];
			extensions?: unknown[];
		};
		const raw: string[] = [];
		for (const entry of settings.packages ?? []) {
			if (typeof entry === "string") {
				raw.push(entry);
			} else if (entry && typeof entry === "object" && "source" in entry && typeof entry.source === "string") {
				raw.push(entry.source);
			}
		}
		for (const entry of settings.extensions ?? []) {
			if (typeof entry === "string") raw.push(entry);
		}
		return raw;
	} catch {
		return [];
	}
}

export function markConflicts(entries: ExtPackageEntry[]): ExtPackageEntry[] {
	// A conflict is the same name present in both user and project scope.
	const scopes = new Map<string, Set<string>>();
	for (const e of entries) {
		if (!scopes.has(e.name)) scopes.set(e.name, new Set());
		scopes.get(e.name)!.add(e.scope);
	}
	return entries.map((e) => ({
		...e,
		conflict: (scopes.get(e.name)?.size ?? 0) > 1,
	}));
}

export function loadEntries(cwd: string): ExtPackageEntry[] {
	const agentDir = join(homedir(), ".pi", "agent");
	const sources: [string, "user" | "project"][] = [
		[join(agentDir, "settings.json"), "user"],
		[join(cwd, ".pi", "settings.json"), "project"],
	];

	const entries: ExtPackageEntry[] = [];
	for (const [settingsPath, scope] of sources) {
		for (const raw of readPackageList(settingsPath)) {
			const disabled = raw.startsWith("_");
			const cleanSpec = disabled ? raw.slice(1) : raw;
			const spec = raw; // keep underscore for display
			const kind = detectKind(cleanSpec);
			const health = checkHealth(cleanSpec, kind);
			const name = deriveName(cleanSpec, kind, health);
			entries.push({ name, raw, spec, scope, kind, health, disabled, conflict: false });
		}
	}
	return markConflicts(entries);
}

export function filterEntries(entries: ExtPackageEntry[], query: string): ExtPackageEntry[] {
	if (!query) return entries;
	const q = query.toLowerCase();
	return entries.filter(
		(e) => e.name.toLowerCase().includes(q) || e.spec.toLowerCase().includes(q),
	);
}

// ---------------------------------------------------------------------------
// TUI rendering
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ROWS = 20;

const HEALTH_ICON: Record<ExtPackageEntry["health"], string> = {
	ok: "✓",
	missing: "⚠",
	unverified: "~",
};

const HEALTH_COLOR: Record<ExtPackageEntry["health"], ThemeColor> = {
	ok: "success",
	missing: "error",
	unverified: "dim",
};

type Theme = { fg: (color: ThemeColor, text: string) => string; bold: (text: string) => string };

function renderEntry(
	entry: ExtPackageEntry,
	isSelected: boolean,
	nameColWidth: number,
	width: number,
	theme: Theme,
): string {
	const arrow = isSelected ? theme.fg("accent", "> ") : "  ";
	const isWarning = entry.conflict || entry.health === "missing";
	const healthColor = HEALTH_COLOR[entry.health];
	const icon = theme.fg(entry.disabled ? "dim" : healthColor, ` ${HEALTH_ICON[entry.health]} `);
	const conflictBadge = entry.conflict ? theme.fg(isSelected ? "accent" : "error", "⚡ ") : "   ";
	const plainName =
		entry.name.length > nameColWidth
			? `${entry.name.slice(0, nameColWidth - 1)}…`
			: entry.name;
	const paddedName = plainName.padEnd(nameColWidth);
	const nameColored = isSelected
		? theme.fg("accent", paddedName)
		: isWarning
			? theme.fg("error", paddedName)
			: entry.disabled
				? theme.fg("dim", paddedName)
				: paddedName;
	const pathPart = !isSelected && isWarning
		? theme.fg("error", entry.spec)
		: theme.fg("dim", entry.spec);
	return truncateToWidth(`${arrow}${nameColored}${conflictBadge}${icon}${pathPart}`, width);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

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
					const okCount = filtered.filter((e) => e.health === "ok").length;
					const missingCount = filtered.filter((e) => e.health === "missing").length;
					const unverifiedCount = filtered.filter((e) => e.health === "unverified").length;
					const conflictCount = filtered.filter((e) => e.conflict).length;
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
								`↑↓ navigate · type to filter · ⌫ clear · esc close   ${pos}   ⚡ conflict`,
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
