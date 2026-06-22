/**
 * TUI settings menu for `/headroom`.
 *
 * Opens a SettingsList overlay that lets the user toggle compression,
 * adjust numeric thresholds, and reset to defaults — all persisted to
 * pi-headroom.json immediately on change.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SettingItem, SettingsList, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { deleteHeadroomSettings, isLocalHeadroomUrl, loadHeadroomConfig, saveHeadroomSettings } from "./config.ts";
import type { HeadroomRuntime } from "./types.ts";

export function createDefaultMenu(): { openHeadroomMenu(ctx: unknown, runtime: HeadroomRuntime): Promise<void> } {
	return { openHeadroomMenu: defaultOpenHeadroomMenu };
}

// ---------------------------------------------------------------------------
// Number input submenu factory
// ---------------------------------------------------------------------------

function makeNumberSubmenu(
	label: string,
	currentValue: string,
	min: number,
	done: (v?: string) => void,
) {
	const input = new Input();
	input.setValue(currentValue);
	input.onSubmit = (v) => {
		const n = Number.parseInt(v, 10);
		if (Number.isFinite(n) && n >= min) done(String(n));
		else done(); // invalid — cancel
	};
	input.onEscape = () => done();
	return {
		render: (width: number) => [
			truncateToWidth(`  ${label}:`, width),
			...input.render(width),
			truncateToWidth("  enter to save · esc to cancel", width),
		],
		handleInput: (data: string) => {
			input.handleInput(data);
		},
		invalidate: () => {
			input.invalidate();
		},
	};
}

// ---------------------------------------------------------------------------
// String input submenu factory
// ---------------------------------------------------------------------------

function makeStringSubmenu(
	label: string,
	currentValue: string,
	done: (v?: string) => void,
) {
	const input = new Input();
	input.setValue(currentValue);
	input.onSubmit = (v) => {
		const trimmed = v.trim();
		if (trimmed.length > 0) done(trimmed);
		else done(); // empty — cancel
	};
	input.onEscape = () => done();
	return {
		render: (width: number) => [
			truncateToWidth(`  ${label}:`, width),
			...input.render(width),
			truncateToWidth("  enter to save · esc to cancel", width),
		],
		handleInput: (data: string) => {
			input.handleInput(data);
		},
		invalidate: () => {
			input.invalidate();
		},
	};
}

// ---------------------------------------------------------------------------
// Settings persistence helper
// ---------------------------------------------------------------------------

function buildSettingsToSave(runtime: HeadroomRuntime) {
	const defaults = loadHeadroomConfig({});
	const s: { enabled?: boolean; baseUrl?: string; allowRemote?: boolean; minContextTokens?: number; minMessageChars?: number; timeoutMs?: number } = {};
	if (runtime.state.enabled !== defaults.enabled) s.enabled = runtime.state.enabled;
	if (runtime.config.baseUrl !== defaults.baseUrl) s.baseUrl = runtime.config.baseUrl;
	if (runtime.config.allowRemote !== defaults.allowRemote) s.allowRemote = runtime.config.allowRemote;
	if (runtime.config.minContextTokens !== defaults.minContextTokens) s.minContextTokens = runtime.config.minContextTokens;
	if (runtime.config.minMessageChars !== defaults.minMessageChars) s.minMessageChars = runtime.config.minMessageChars;
	if (runtime.config.timeoutMs !== defaults.timeoutMs) s.timeoutMs = runtime.config.timeoutMs;
	return s;
}

// ---------------------------------------------------------------------------
// Change handler
// ---------------------------------------------------------------------------

function handleChange(
	id: string,
	newValue: string,
	runtime: HeadroomRuntime,
	ctx: ExtensionContext,
	done: (v: void) => void,
	settingsList: SettingsList,
): void {
	if (id === "enabled") {
		runtime.state.enabled = newValue === "on";
		runtime.refreshStatus(ctx);
		saveHeadroomSettings(buildSettingsToSave(runtime));
		settingsList.updateValue("enabled", runtime.state.enabled ? "on" : "off");
		return;
	}

	if (id === "minContextTokens") {
		runtime.config.minContextTokens = Number.parseInt(newValue, 10);
		saveHeadroomSettings(buildSettingsToSave(runtime));
		settingsList.updateValue("minContextTokens", String(runtime.config.minContextTokens));
		return;
	}

	if (id === "minMessageChars") {
		runtime.config.minMessageChars = Number.parseInt(newValue, 10);
		saveHeadroomSettings(buildSettingsToSave(runtime));
		settingsList.updateValue("minMessageChars", String(runtime.config.minMessageChars));
		return;
	}

	if (id === "baseUrl") {
		runtime.config.baseUrl = newValue;
		if (!runtime.config.allowRemote && !isLocalHeadroomUrl(newValue)) {
			ctx.ui.notify("Warning: remote URL set but Allow remote is off — Headroom will be blocked", "warning");
		}
		runtime.refreshStatus(ctx);
		saveHeadroomSettings(buildSettingsToSave(runtime));
		settingsList.updateValue("baseUrl", runtime.config.baseUrl);
		return;
	}

	if (id === "allowRemote") {
		runtime.config.allowRemote = newValue === "on";
		runtime.refreshStatus(ctx);
		saveHeadroomSettings(buildSettingsToSave(runtime));
		settingsList.updateValue("allowRemote", runtime.config.allowRemote ? "on" : "off");
		return;
	}

	if (id === "timeoutMs") {
		runtime.config.timeoutMs = Number.parseInt(newValue, 10);
		saveHeadroomSettings(buildSettingsToSave(runtime));
		settingsList.updateValue("timeoutMs", String(runtime.config.timeoutMs));
		return;
	}

	if (id === "reset" && newValue === "confirm") {
		deleteHeadroomSettings();
		const fresh = loadHeadroomConfig(process.env);
		runtime.config.enabled = fresh.enabled;
		runtime.config.baseUrl = fresh.baseUrl;
		runtime.config.allowRemote = fresh.allowRemote;
		runtime.config.minContextTokens = fresh.minContextTokens;
		runtime.config.minMessageChars = fresh.minMessageChars;
		runtime.config.timeoutMs = fresh.timeoutMs;
		runtime.state.enabled = fresh.enabled;
		runtime.refreshStatus(ctx);
		ctx.ui.notify("Headroom settings reset to defaults", "info");
		done();
	}
}

// ---------------------------------------------------------------------------
// Main menu entry point
// ---------------------------------------------------------------------------

export async function defaultOpenHeadroomMenu(ctx: ExtensionContext, runtime: HeadroomRuntime): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Headroom Settings")), 1, 0));
		container.addChild(new Spacer(1));

		// Status block — static snapshot at menu open time
		const { proxyOnline, stats } = runtime.state;
		const proxyText =
			proxyOnline === true
				? theme.fg("success", "● online")
				: proxyOnline === false
					? theme.fg("dim", "○ offline")
					: theme.fg("dim", "○ unknown");
		const statusLines = [
			`  ${theme.fg("dim", "Proxy")}        ${proxyText}`,
			`  ${theme.fg("dim", "Attempts")}     ${stats.attempts}   applied: ${stats.applied}`,
			`  ${theme.fg("dim", "Tokens saved")} ${stats.tokensSaved.toLocaleString()}`,
		];
		if (stats.last !== undefined) {
			const pct = Math.round((1 - stats.last.compressionRatio) * 100);
			statusLines.push(
				`  ${theme.fg("dim", "Last call")}         ${stats.last.tokensBefore.toLocaleString()} → ${stats.last.tokensAfter.toLocaleString()}  (-${pct}%)`,
			);
		}
		container.addChild({
			render: (w: number) => statusLines.map((l) => truncateToWidth(l, w)),
			invalidate: () => {},
		});
		container.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "enabled",
				label: "Compression",
				description: "Enable or disable Headroom token compression",
				currentValue: runtime.state.enabled ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "minContextTokens",
				label: "Min context tokens",
				description: "Compress only when context exceeds this many tokens",
				currentValue: String(runtime.config.minContextTokens),
				submenu: (currentValue, submenuDone) =>
					makeNumberSubmenu("Min context tokens", currentValue, 0, submenuDone),
			},
			{
				id: "minMessageChars",
				label: "Min message chars",
				description: "Skip messages shorter than this many characters",
				currentValue: String(runtime.config.minMessageChars),
				submenu: (currentValue, submenuDone) =>
					makeNumberSubmenu("Min message chars", currentValue, 1, submenuDone),
			},
			{
				id: "baseUrl",
				label: "Proxy URL",
				description: "URL of the Headroom proxy server",
				currentValue: runtime.config.baseUrl,
				submenu: (currentValue, submenuDone) =>
					makeStringSubmenu("Proxy URL", currentValue, submenuDone),
			},
			{
				id: "allowRemote",
				label: "Allow remote",
				description: "Allow connecting to non-localhost Headroom servers",
				currentValue: runtime.config.allowRemote ? "on" : "off",
				values: ["off", "on"],
			},
			{
				id: "timeoutMs",
				label: "Timeout (ms)",
				description: "Request timeout in milliseconds (min 100)",
				currentValue: String(runtime.config.timeoutMs),
				submenu: (currentValue, submenuDone) =>
					makeNumberSubmenu("Timeout (ms)", currentValue, 100, submenuDone),
			},
			{
				id: "reset",
				label: "Reset to defaults",
				description: "Delete pi-headroom.json — press Enter to confirm",
				currentValue: "",
				values: ["confirm"],
			},
		];

		const settingsTheme = getSettingsListTheme();
		const settingsList = new SettingsList(
			items,
			items.length + 2,
			settingsTheme,
			(id, newValue) => {
				handleChange(id, newValue, runtime, ctx, done, settingsList);
			},
			() => done(),
		);

		container.addChild(settingsList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc close"), 1, 0));
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}
