/**
 * Tool-call and tool-result renderers used by pi's interactive tool listing.
 *
 * Both functions return a `Text` TUI component. They intentionally stay thin
 * so the interesting behaviour (result kind ➜ styled summary) is easy to
 * cover with a fake theme in unit tests.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

import type { Result } from "./format.js";
import type { TParams } from "./schema.js";

/**
 * Minimal theme surface the renderers need. The real `Theme` class satisfies
 * it; tests can pass a tiny stub with `fg`, `bold`, and (optionally) `bg`.
 */
export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	bg?(color: string, text: string): string;
}

export function renderCall(args: TParams | undefined, theme: RenderTheme): Text {
	const qs = Array.isArray(args?.questions) ? (args.questions) : [];
	const count = qs.length;
	const labels = qs.map((_q, i) => `Q${i + 1}`).join(", ");
	let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
	text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
	if (labels !== "") text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
	return new Text(text, 0, 0);
}

export function renderResult(
	result: AgentToolResult<Result | undefined>,
	expanded: boolean,
	theme: RenderTheme,
): Text {
	const details = result.details;
	if (!details || (details.error !== undefined && details.error !== "") || !Array.isArray((details as { answers?: unknown }).answers)) {
		const first = result.content[0];
		const msg = first !== undefined && first.type === "text" ? first.text : "error";
		if (!expanded) {
			const firstLine = msg.split("\n")[0] ?? msg;
			const truncated = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
			return new Text(theme.fg("error", truncated) + "  … ctrl-o to expand", 0, 0);
		}
		return new Text(theme.fg("error", msg), 0, 0);
	}
	if (details.cancelled) {
		const chat = details.chat !== undefined && details.chat !== "" ? ` (chat: ${details.chat})` : "";
		return new Text(theme.fg("warning", `Cancelled${chat}`), 0, 0);
	}
	const first = result.content[0];
	const msg = first !== undefined && first.type === "text" ? first.text : "";
	return new Text(msg, 0, 0);
}
