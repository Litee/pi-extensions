import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { truncate } from "./helpers.js";

/**
 * Maximum visible-width budget (in characters) for the description shown
 * alongside a tool name in the argument-autocomplete popup. Tight by design
 * — completions live in a small popover, not the main list view.
 */
export const COMPLETION_DESC_WIDTH = 80;

/**
 * Build the autocomplete suggestion list for `/tools <prefix>`.
 *
 * Pure: depends only on `prefix` and the provided tool list; no side effects.
 *
 * Returns `null` (not `[]`) when nothing matches, matching the convention
 * expected by `ExtensionCommand.getArgumentCompletions`.
 */
export function getToolArgumentCompletions(prefix: string, tools: ToolInfo[]): AutocompleteItem[] | null {
	const candidates = ["--all", ...tools.map((t) => t.name)];
	const filtered = candidates.filter((c) => c.startsWith(prefix));
	if (filtered.length === 0) return null;
	return filtered.map((value) => {
		const tool = tools.find((t) => t.name === value);
		const first = tool?.description?.split("\n")[0] ?? "";
		return first
			? { value, label: value, description: truncate(first, COMPLETION_DESC_WIDTH) }
			: { value, label: value };
	});
}
