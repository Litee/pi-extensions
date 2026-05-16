/**
 * Shared UI-surface primitives for pi watcher extensions.
 *
 * Exports:
 *   - `UiSurface`        — minimal interface for extension UI interaction.
 *   - `colorize`         — apply a theme colour alias to a text string.
 *   - `extractUiSurface` — pull the UiSurface from a session_start ctx object.
 */

/** Minimal UI surface shape required by all pi watcher extensions. */
export interface UiSurface {
	notify?: (msg: string, level?: string) => void;
	setStatus?: (key: string, text: string | undefined) => void;
	theme?: { fg?: (colorAlias: string, text: string) => string };
	hasUI?: boolean;
}

/**
 * Apply a theme colour alias to `text` via `theme.fg`.
 * Returns `text` unmodified when no theme is available.
 */
export function colorize(
	theme: UiSurface["theme"],
	alias: "accent" | "muted" | "warning",
	text: string,
): string {
	return theme?.fg ? theme.fg(alias, text) : text;
}

/**
 * Extract a {@link UiSurface} from a `session_start` (or command) context
 * object.
 *
 * The pi SDK does not expose a typed ctx at this layer, so three heuristics
 * are checked in priority order:
 *   1. `ctx.hasUI` — top-level flag added in newer SDK versions.
 *   2. `ctx.ui?.hasUI` — flag nested inside the ui bundle.
 *   3. `ctx.ui !== undefined` — bare existence of the ui property.
 *
 * Returns `null` when no UI is available (headless / test contexts).
 */
export function extractUiSurface(ctx: unknown): UiSurface | null {
	const any = ctx as { hasUI?: boolean; ui?: UiSurface } | null | undefined;
	if (!any) return null;
	const hasUI = any.hasUI ?? any.ui?.hasUI ?? any.ui !== undefined;
	return hasUI ? (any.ui ?? null) : null;
}
