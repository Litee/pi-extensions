/**
 * Minimal theme surface used by {@link decoratePickerValue}. A subset of the
 * pi theme API — declared locally so the helper and its tests don't need
 * to import the full `Theme` class.
 */
export interface PickerValueTheme {
	fg: (color: "success" | "error", text: string) => string;
	bold: (text: string) => string;
}

/**
 * Decide how a value cell (`"enabled"` / `"disabled"` / other) should be
 * rendered in the picker TUI. Pure — no IO, no TUI imports — so the
 * colour-decision logic is unit-testable without spinning up a live TUI.
 *
 * - `"enabled"` → theme `success` (green).
 * - `"disabled"` → theme `error` (red).
 * - Any other text (future values) delegates to `fallback`, preserving the
 *   default SettingsList value renderer (accent / muted) behaviour.
 * - Selection highlight: when `selected` is true and we are colouring
 *   enabled/disabled ourselves, wrap the coloured text in `theme.bold`. The
 *   row cursor (`"→ "`) and the label-accent behaviour come from the
 *   untouched parts of `getSettingsListTheme()`.
 */
export function decoratePickerValue(
	text: string,
	selected: boolean,
	t: PickerValueTheme,
	fallback: (text: string, selected: boolean) => string,
): string {
	if (text === "enabled") {
		const coloured = t.fg("success", text);
		return selected ? t.bold(coloured) : coloured;
	}
	if (text === "disabled") {
		const coloured = t.fg("error", text);
		return selected ? t.bold(coloured) : coloured;
	}
	return fallback(text, selected);
}
