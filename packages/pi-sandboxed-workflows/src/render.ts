/**
 * Message renderer for `pi-sandboxed-workflows:event` chat messages.
 *
 * pi's renderer API expects a TUI node (a `Box` containing `Text`), not a
 * raw string \u2014 see the `message-renderer.ts` example shipped with
 * pi-coding-agent. Returning a string compiled but rendered as nothing in
 * the TUI, which is why workflows looked silent before.
 *
 * The pure `formatEventLine` helper stays exported so unit tests can
 * assert on the formatted text without standing up a TUI; the real
 * renderer wraps it in a Box.
 */
import { Box, Text } from "@earendil-works/pi-tui";

export interface RenderableEvent {
	readonly customType: string;
	readonly content: string;
	readonly details?: Record<string, unknown> & {
		readonly kind?: unknown;
		readonly name?: unknown;
	};
}

/** Pure formatter \u2014 unit-testable, no TUI dependency. */
export function formatEventLine(event: RenderableEvent): string {
	const name = typeof event.details?.name === "string" ? event.details.name : "?";
	const kind = typeof event.details?.kind === "string" ? event.details.kind : "?";
	return `[workflow:${name}] ${kind} \u2014 ${event.content}`;
}

/**
 * Color hint for an event kind. Errors get the theme's `error` color so
 * they jump out of the chat; other lifecycle states are neutral.
 */
function kindColor(kind: unknown): "error" | "warning" | "success" | "accent" {
	if (kind === "error") return "error";
	if (kind === "startup-warning" || kind === "concurrent-rejected") {
		return "warning";
	}
	if (kind === "completed") return "success";
	return "accent";
}

/**
 * Renderer factory \u2014 builds the function pi's `registerMessageRenderer`
 * expects. Signature: `(message, options, theme) => Box | Text | string`.
 */
export function createMessageRenderer(): (
	message: RenderableEvent,
	options: { expanded?: boolean },
	theme: {
		fg: (color: string, text: string) => string;
		bg: (color: string, text: string) => string;
	},
) => Box {
	return (message, options, theme) => {
		const { expanded } = options;
		const kind =
			typeof message.details?.kind === "string" ? message.details.kind : "?";
		const name =
			typeof message.details?.name === "string" ? message.details.name : "?";

		const prefix = theme.fg(kindColor(kind), `[workflow:${name}]`);
		const kindLabel = theme.fg("dim", kind);
		let text = `${prefix} ${kindLabel} \u2014 ${message.content}`;

		if (expanded === true && message.details !== undefined) {
			// Show the structured payload (run id, args, stack, etc.) when the
			// user expands the message. We strip `kind` and `name` since they
			// already appear in the headline.
			const { kind: _k, name: _n, ...rest } = message.details;
			void _k;
			void _n;
			if (Object.keys(rest).length > 0) {
				text += `\n${theme.fg("dim", JSON.stringify(rest))}`;
			}
		}

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	};
}
