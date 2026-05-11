import type { ToolInfo } from "@mariozechner/pi-coding-agent";

import { estimateToolTokens, sourceLabel } from "./helpers.js";

/**
 * Render the Markdown body shown in the per-tool detail view.
 *
 * Pure: no pi-tui or pi-coding-agent runtime imports, no file I/O.
 * Falls back gracefully on cyclic / non-serializable parameter shapes so a
 * weird third-party tool definition can't crash the `/tools` command.
 */
export function renderToolMarkdown(tool: ToolInfo, active: Set<string>): string {
	const status = active.has(tool.name) ? "✅ active" : "⛔ inactive";
	const desc = tool.description?.trim() || "_(no description)_";
	const tokens = estimateToolTokens(tool);
	let schema: string;
	try {
		schema = JSON.stringify(tool.parameters ?? {}, null, 2);
	} catch {
		schema = "[schema unavailable]";
	}
	return [
		`## ${tool.name}  ${status}`,
		`**Source:** ${sourceLabel(tool)}  ·  **Tokens:** ~${tokens}`,
		"",
		desc,
		"",
		"**Parameters:**",
		"```json",
		schema,
		"```",
	].join("\n");
}
