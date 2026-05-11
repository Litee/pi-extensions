import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { estimateToolTokens, formatTokens, truncate } from "./helpers.js";

/**
 * Minimal surface of the pi `Theme` class that `buildToolRows` actually uses.
 *
 * Declaring it as a structural type keeps the module free of a pi-coding-agent
 * runtime dependency, which lets tests pass a pass-through stub instead of
 * instantiating a real Theme.
 */
export interface RowTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Layout budget for the selector list. */
export interface RowLayout {
	/** Total visible-width target for a list row. */
	listRowWidth: number;
	/** Floor for the description tail after subtracting fixed-width prefix chunks. */
	minDescWidth: number;
}

/** One row in the interactive tool selector. */
export interface Row {
	label: string;
	/** Present on rows that map to a concrete tool; absent on group-header rows. */
	toolName?: string;
}

/** Fixed display order of known tool sources. Unknown sources are appended in first-seen order. */
const SOURCE_ORDER: readonly string[] = ["builtin", "sdk", "extension", "skill", "unknown"];

/**
 * Group tools by `sourceInfo.source` and render group headers + per-tool
 * rows. Deterministic: group order is fixed, intra-group order is by name.
 *
 * Layout math is parameterised so tests can exercise edge cases (tiny row
 * widths, generous `minDescWidth` floors) without patching module globals.
 */
export function buildToolRows(
	tools: ToolInfo[],
	active: Set<string>,
	theme: RowTheme,
	layout: RowLayout,
): Row[] {
	const grouped = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		const key = tool.sourceInfo?.source ?? "unknown";
		const list = grouped.get(key) ?? [];
		list.push(tool);
		grouped.set(key, list);
	}

	const orderedKeys = [
		...SOURCE_ORDER.filter((k) => grouped.has(k)),
		...[...grouped.keys()].filter((k) => !SOURCE_ORDER.includes(k)),
	];

	const rows: Row[] = [];
	for (const key of orderedKeys) {
		const list = grouped.get(key)!.slice().sort((a, b) => a.name.localeCompare(b.name));
		rows.push({ label: theme.fg("dim", `── ${key} (${list.length}) ──`) });
		for (const tool of list) {
			rows.push(buildToolRow(tool, active, theme, layout));
		}
	}
	return rows;
}

function buildToolRow(tool: ToolInfo, active: Set<string>, theme: RowTheme, layout: RowLayout): Row {
	const mark = active.has(tool.name) ? theme.fg("accent", "●") : theme.fg("dim", "○");
	const tokenPlain = `[${formatTokens(estimateToolTokens(tool))} tok]`;
	const name = theme.bold(tool.name);
	const tokens = theme.fg("dim", tokenPlain);

	const firstLine = tool.description?.split("\n")[0]?.trim() ?? "";
	let desc = "";
	if (firstLine) {
		// Fixed visible-width chunks: mark(1) + 2sp + name + 1sp + tokenPlain + " — " (3).
		const fixed = 1 + 2 + tool.name.length + 1 + tokenPlain.length + 3;
		const budget = Math.max(layout.minDescWidth, layout.listRowWidth - fixed);
		desc = ` ${theme.fg("dim", `— ${truncate(firstLine, budget)}`)}`;
	}
	return { label: `${mark}  ${name} ${tokens}${desc}`, toolName: tool.name };
}
