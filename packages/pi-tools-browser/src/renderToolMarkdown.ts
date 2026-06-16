import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { estimateToolTokens, sourceLabel } from "./helpers.js";

/**
 * Render the Markdown body shown in the per-tool detail view.
 *
 * Pure: no pi-tui or pi-coding-agent runtime imports, no file I/O.
 * Falls back gracefully on cyclic / non-serializable parameter shapes so a
 * weird third-party tool definition can't crash the `/tools` command.
 *
 * @param inPrompt  Optional set of tool names that are currently included in the
 *                  system prompt (from `ctx.getSystemPromptOptions().selectedTools`).
 *                  When provided, an **In prompt:** annotation is appended to the
 *                  source/tokens metadata line. When omitted, the annotation is
 *                  suppressed entirely (graceful fallback for older pi versions).
 */
export function renderToolMarkdown(tool: ToolInfo, active: Set<string>, inPrompt?: Set<string>): string {
	const status = active.has(tool.name) ? "✅ active" : "⛔ inactive";
	const desc = tool.description?.trim() || "_(no description)_";
	const tokens = estimateToolTokens(tool);
	let schema: string;
	try {
		schema = JSON.stringify(tool.parameters ?? {}, null, 2);
	} catch {
		schema = "[schema unavailable]";
	}

	// Build the metadata line, optionally including the "in prompt" annotation.
	const inPromptPart = inPrompt !== undefined
		? `  ·  **In prompt:** ${inPrompt.has(tool.name) ? "✓ yes" : "✗ no"}`
		: "";
	const metaLine = `**Source:** ${sourceLabel(tool)}  ·  **Tokens:** ~${tokens}${inPromptPart}`;

	return [
		`## ${tool.name}  ${status}`,
		metaLine,
		"",
		desc,
		"",
		"**Parameters:**",
		"```json",
		schema,
		"```",
	].join("\n");
}
