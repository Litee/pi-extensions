/**
 * TUI rendering primitives shared across all pi watcher extensions.
 *
 * Exports:
 *   - `toolText`                   — wrap a string as tool-result content.
 *   - `collapsePreview`            — extract a 2-line preview from text (exported for testing).
 *   - `createWatcherMessageRenderer` — factory for a collapse/expand message renderer.
 */

import { getMarkdownTheme, keyHint, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// toolText
// ---------------------------------------------------------------------------

/** Wrap a string as a pi tool-result content array. */
export function toolText(text: string): Array<{ type: "text"; text: string }> {
	return [{ type: "text", text }];
}

// ---------------------------------------------------------------------------
// Preview helper (exported so tests can cover without mocking TUI)
// ---------------------------------------------------------------------------

/**
 * Extract a collapsed preview from a message content string.
 *
 * Takes the first 2 non-empty lines. Appends `"\n…"` when the original text
 * had more than 2 non-empty lines. Returns the full text when there are ≤ 2
 * non-empty lines (no truncation, no `…`).
 *
 * Plain text is intentional — collapsed mode avoids `Markdown` rendering
 * to prevent broken syntax from truncation mid-bold or mid-code-fence.
 */
export function collapsePreview(text: string): string {
	const nonEmpty = text.split("\n").filter((line) => line.trim() !== "");
	// Only collapse when more than 1 line would be hidden — a single hidden
	// line saves no meaningful space and forces an extra interaction.
	if (nonEmpty.length <= 3) return nonEmpty.join("\n");
	const preview = nonEmpty.slice(0, 2).join("\n");
	return `${preview}\n…`;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(c): c is { type: string; text?: string } =>
					c !== null && typeof c === "object",
			)
			.map((c) => (typeof c.text === "string" ? c.text : ""))
			.join("\n");
	}
	return "";
}

// ---------------------------------------------------------------------------
// Message renderer factory
// ---------------------------------------------------------------------------

/** Minimal message shape accepted by the renderer. */
export interface WatcherMessage {
	content: unknown;
	details?: unknown;
}

export interface WatcherMessageRendererOptions {
	/**
	 * When provided and `expanded === true`, this callback may return an
	 * alternative text string to render as Markdown instead of the message
	 * content. Return `undefined` to fall through to the default rendering.
	 */
	expandedTextOverride?: (message: WatcherMessage) => string | undefined;
}

/**
 * Create a `registerMessageRenderer` callback for a watcher extension.
 *
 * **Collapsed** (`expanded === false`):
 *   Bold label + first 2 non-empty lines of content as plain `Text` +
 *   `"\u2026"` suffix when more content exists. Plain text prevents broken
 *   markdown syntax from truncation mid-bold or mid-code-fence. When
 *   content was truncated, a dim `keyHint("app.tools.expand", "to expand")`
 *   hint is appended on a new line so users know how to see the full message.
 *
 * **Expanded** (`expanded === true`):
 *   Bold label + full content rendered as `Markdown`. When
 *   `opts.expandedTextOverride` is provided and returns a non-undefined
 *   string, that string is used instead of the message content.
 *
 * @param label - The bold label shown at the top of every message bubble,
 *   e.g. `"pi-ticket-watcher"`.
 * @param opts  - Optional rendering overrides.
 */
export function createWatcherMessageRenderer(
	label: string,
	opts: WatcherMessageRendererOptions = {},
): (
	message: WatcherMessage,
	options: { expanded: boolean },
	theme: Theme,
) => Component {
	return (message, { expanded }, theme) => {
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(
			new Text(theme.fg("customMessageLabel", `\x1b[1m${label}\x1b[22m`), 0, 0),
		);
		box.addChild(new Spacer(1));

		const text = extractText(message.content);

		if (expanded) {
			const override = opts.expandedTextOverride?.(message);
			const displayText = override ?? text;
			box.addChild(
				new Markdown(displayText, 0, 0, getMarkdownTheme(), {
					color: (t: string) => theme.fg("customMessageText", t),
				}),
			);
		} else {
			const preview = collapsePreview(text);
			const hint = preview.endsWith("\u2026")
				? " " + theme.fg("dim", keyHint("app.tools.expand", "to expand"))
				: "";
			box.addChild(
				new Text(
					theme.fg("customMessageText", preview) + hint,
					0,
					0,
				),
			);
		}

		return box;
	};
}
