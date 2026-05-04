import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { CcSkillsPicker } from "./index.js";

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

/**
 * TUI-backed picker for `/cc-skills-info`. Lazily imports `@mariozechner/pi-tui` so
 * the rest of the package is loadable in unit tests without a live TUI
 * runtime.
 *
 * This module is intentionally excluded from coverage in vitest.config.ts —
 * it is integration code whose behavior only surfaces under a real pi session.
 */
export function makeTuiPicker(
	ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
): CcSkillsPicker {
	return async ({ items, onToggle, collisions, skills }) => {
		const [{ getSettingsListTheme }, { Container, SettingsList, Text }] = await Promise.all([
			import("@mariozechner/pi-coding-agent"),
			import("@mariozechner/pi-tui"),
		]);

		await ctx.ui.custom((tui, _theme, _kb, done) => {
			const theme = ctx.ui.theme;
			const defaultSettingsListTheme = getSettingsListTheme();
			const settingsListTheme = {
				...defaultSettingsListTheme,
				value: (text: string, selected: boolean) =>
					decoratePickerValue(text, selected, theme, defaultSettingsListTheme.value),
			};
			const container = new Container();
			const headerLines = [
				theme.fg("accent", theme.bold("Claude Code Skills")),
				theme.fg(
					"dim",
					`${skills.length} total${
						collisions.size ? ` · ${collisions.size} name collision(s)` : ""
					}`,
				),
				theme.fg("dim", "Toggle to enable/disable. Changes persist globally; /reload to apply."),
				"",
			];
			container.addChild({
				render: () => headerLines,
				invalidate: () => {},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tui child shape
			} as any);

			if (items.length === 0) {
				container.addChild(new Text(theme.fg("dim", "No Claude Code skills found."), 1, 1));
				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (data === "\u001b" || data === "\r" || data === "\n" || data === "q") {
							done(undefined);
						}
					},
				};
			}

			const decorated = items.map((i) => ({
				id: i.id,
				label: i.isCollision
					? `${i.qualifiedName} ${theme.fg("warning", "(name collision)")}`
					: i.qualifiedName,
				currentValue: i.currentValue,
				values: i.values,
			}));

			const settingsList = new SettingsList(
				decorated,
				Math.min(decorated.length + 2, 20),
				settingsListTheme,
				(id, newValue) => {
					onToggle(id, newValue as "enabled" | "disabled");
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settingsList);

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime widget shape
					(settingsList as any).handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	};
}
