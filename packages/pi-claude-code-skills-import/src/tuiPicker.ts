import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { CcSkillsPicker } from "./index.js";
import { decoratePickerValue } from "./pickerValue.js";

/**
 * TUI-backed picker for `/cc-skills-info`. Lazily imports `@mariozechner/pi-tui` so
 * the rest of the package is loadable in unit tests without a live TUI
 * runtime.
 *
 * This module is intentionally excluded from coverage in vitest.config.ts —
 * it is integration code whose behavior only surfaces under a real pi session.
 * The pure colour-decision helper (`decoratePickerValue`) lives in
 * `./pickerValue.ts` and is fully covered there.
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
				 
			});

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
					// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- SettingsList internals: no public handleInput in @mariozechner/pi-tui
					(settingsList as any).handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	};
}
