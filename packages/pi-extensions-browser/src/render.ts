import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { ExtPackageEntry } from "./helpers.js";

// ---------------------------------------------------------------------------
// TUI rendering constants
// ---------------------------------------------------------------------------

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

export type Theme = { fg: (color: ThemeColor, text: string) => string; bold: (text: string) => string };

// ---------------------------------------------------------------------------
// renderEntry
// ---------------------------------------------------------------------------

export function renderEntry(
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
	const pathPart = entry.health === "missing"
		? theme.fg("error", entry.spec)
		: theme.fg("dim", entry.spec);
	return truncateToWidth(`${arrow}${nameColored}${conflictBadge}${icon}${pathPart}`, width);
}
