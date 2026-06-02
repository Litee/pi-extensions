/**
 * `/speak` TUI menu.
 *
 * `runSpeakMenu` is pure of the pi API — it only needs `ctx.ui.select` and
 * `ctx.ui.notify`. All state mutations are delegated to callbacks supplied by
 * the caller (index.ts), which makes this module unit-testable in isolation.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";

import type { SpeakConfig } from "./config.js";
import { LANGS, VOICES, type VoiceId } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MenuCtx {
	ui: {
		select: (title: string, items: string[]) => Promise<string | null | undefined>;
		notify: (msg: string, level?: "info" | "warning" | "error") => void;
		custom?: <T>(
			factory: (tui: { requestRender: () => void }, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
		) => Promise<T>;
	};
}

export interface MenuOptions {
	/** Current enabled state at menu open time. */
	enabled: boolean;
	/** Current session-scoped voice override, if any. */
	sessionVoice: string | undefined;
	/** Current session-scoped language override, if any. */
	sessionLang: string | undefined;
	/** Current session-scoped speed override, if any. */
	sessionSpeed: number | undefined;
	/** Current session-scoped steps override, if any. */
	sessionSteps: number | undefined;
	/** Returns the resolved assets directory (may or may not exist). */
	getAssetsDir: () => string;
	/** Returns true when the model files are fully downloaded. */
	assetsReady: (dir: string) => boolean;
	/** Reads the persisted config. Called each iteration so changes are live. */
	loadConfig: () => SpeakConfig;
	/** Writes a partial update to the persisted config. */
	saveConfig: (partial: Partial<SpeakConfig>) => boolean;
	/**
	 * Attempts to toggle enabled state.
	 * - Disabled → ready     : enables, returns `true`.
	 * - Disabled → not ready : notifies the user, returns `false`.
	 * - Enabled              : disables, returns `false`.
	 */
	onToggle: () => Promise<boolean>;
	/** Speaks the test phrase when enabled; shows a warning when not. */
	onTest: () => Promise<void>;
	/**
	 * Called after the user picks a voice from the Session voice sub-menu.
	 * The menu will immediately speak a hello using the new voice.
	 */
	onSetSessionVoice: (voice: string) => void;
	/** Called after the user picks a language from the Session language sub-menu. */
	onSetSessionLang: (lang: string) => void;
	/** Called after the user picks a speed from the Session speed sub-menu. */
	onSetSessionSpeed: (speed: number) => void;
	/** Called after the user picks a steps value from the Session steps sub-menu. */
	onSetSessionSteps: (steps: number) => void;
	/** Speaks a hello phrase with the given voice. Used after any session setting change. */
	onSpeakHello: (voice: string) => Promise<void>;
	/** Returns the current number of items waiting in the speech queue. */
	getQueueLength: () => number;
}

// ---------------------------------------------------------------------------
// Preset constants (exported for tests)
// ---------------------------------------------------------------------------

export const SPEED_PRESETS: { label: string; value: number }[] = [
	{ label: "Slow (0.8)",       value: 0.8 },
	{ label: "Normal (1.05)",    value: 1.05 },
	{ label: "Fast (1.3)",       value: 1.3 },
	{ label: "Very fast (1.6)", value: 1.6 },
];

export const STEPS_PRESETS: { label: string; value: number }[] = [
	{ label: "Draft — 4 steps",         value: 4 },
	{ label: "Default — 8 steps",       value: 8 },
	{ label: "Quality — 16 steps",      value: 16 },
	{ label: "High quality — 32 steps", value: 32 },
];

// ---------------------------------------------------------------------------
// Helpers (exported for direct unit tests)
// ---------------------------------------------------------------------------

/**
 * Returns the label of the preset whose value is closest to `value`.
 */
export function nearestPresetLabel<T extends { label: string; value: number }>(
	presets: T[],
	value: number,
): string {
	return presets.reduce((a, b) =>
		Math.abs(b.value - value) < Math.abs(a.value - value) ? b : a,
	).label;
}

function effectiveValue<T>(
	session: T | undefined,
	configDefault: T | undefined,
	fallback: T,
): T {
	return session ?? configDefault ?? fallback;
}

export function dirSize(dir: string): number {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) total += dirSize(p);
		else total += statSync(p).size;
	}
	return total;
}

export function modelInfo(assetsDir: string): string {
	if (!existsSync(assetsDir)) return "Model: not downloaded";
	const bytes = dirSize(assetsDir);
	const mb = Math.round(bytes / 1024 / 1024);
	return `Model: ${assetsDir}  (${mb} MB)`;
}

// ---------------------------------------------------------------------------
// Sub-menu pickers
// ---------------------------------------------------------------------------

async function pickVoice(
	ctx: MenuCtx,
	current: string,
	onPreview: (voice: string) => Promise<void>,
): Promise<string | null> {
	type TuiLike = { requestRender: () => void };
	type ThemeLike = { fg: (r: string, s: string) => string; bold: (s: string) => string };
	type ComponentLike = { render: (w: number) => string[]; invalidate: () => void; handleInput: (d: string) => void };

	const ctxWithCustom = ctx as {
		ui: {
			custom?: <T>(
				factory: (tui: TuiLike, theme: ThemeLike, kb: unknown, done: (v: T) => void) => ComponentLike,
			) => Promise<T>;
		};
	};

	if (!ctxWithCustom.ui.custom) {
		const items: string[] = [...VOICES, "─────", "Cancel"];
		const choice = await ctx.ui.select(`Select voice  (current: ${current})`, items);
		if (!choice || choice === "Cancel" || choice.startsWith("─")) return null;
		return choice;
	}

	return (ctxWithCustom.ui.custom<string | null>((tui, theme, _kb, done) => {
		const items: SelectItem[] = VOICES.map((v) => ({ value: v, label: v === current ? `${v} ◀` : v }));
		const sl = new SelectList(items, Math.min(items.length + 2, 15), getSelectListTheme());

		const currentIdx = VOICES.indexOf(current as VoiceId);
		if (currentIdx >= 0) sl.setSelectedIndex(currentIdx);

		sl.onSelect = (item) => done(item.value);
		sl.onCancel = () => done(null);

		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		sl.onSelectionChange = (item) => {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				void onPreview(item.value).catch(() => {});
			}, 400);
			tui.requestRender();
		};

		return {
			render: (w: number) => [
				theme.bold(`Select voice  (current: ${current})`),
				theme.fg("dim", "↑↓ navigate to preview · Enter to select · Esc to cancel"),
				...sl.render(w),
			],
			invalidate: () => sl.invalidate(),
			handleInput: (data: string) => {
				sl.handleInput(data);
				tui.requestRender();
			},
		};
	})) ?? null;
}

async function pickLang(ctx: MenuCtx, current: string): Promise<string | null> {
	const items: string[] = [...LANGS, "─────", "Cancel"];
	const choice = await ctx.ui.select(`Select language  (current: ${current})`, items);
	if (!choice || choice === "Cancel" || choice.startsWith("─")) return null;
	return choice;
}

async function pickSpeed(ctx: MenuCtx, current: number): Promise<number | null> {
	const items = [...SPEED_PRESETS.map((p) => p.label), "─────", "Cancel"];
	const choice = await ctx.ui.select(`Select speed  (current: ${current})`, items);
	if (!choice || choice === "Cancel" || choice.startsWith("─")) return null;
	return SPEED_PRESETS.find((p) => p.label === choice)?.value ?? null;
}

async function pickSteps(ctx: MenuCtx, current: number): Promise<number | null> {
	const items = [...STEPS_PRESETS.map((p) => p.label), "─────", "Cancel"];
	const choice = await ctx.ui.select(`Select steps  (current: ${current})`, items);
	if (!choice || choice === "Cancel" || choice.startsWith("─")) return null;
	return STEPS_PRESETS.find((p) => p.label === choice)?.value ?? null;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// selectAt — ctx.ui.select with remembered cursor position
// ---------------------------------------------------------------------------

/**
 * Like `ctx.ui.select` but restores the cursor to `initialIndex` when the
 * menu opens. Returns `{ choice, index }` so the caller can persist the
 * position for the next iteration.
 *
 * Falls back to plain `ctx.ui.select` (cursor always resets to 0) when
 * `ctx.ui.custom` is unavailable.
 */
async function selectAt(
	ctx: MenuCtx,
	title: string,
	items: string[],
	initialIndex: number,
): Promise<{ choice: string; index: number } | null> {
	if (!ctx.ui.custom) {
		const choice = await ctx.ui.select(title, items);
		if (!choice) return null;
		return { choice, index: items.indexOf(choice) };
	}

	type TuiLike = { requestRender: () => void };

	const result = await ctx.ui.custom<{ value: string; index: number } | null>(
		(tui: TuiLike, _theme: unknown, _kb: unknown, done: (v: { value: string; index: number } | null) => void) => {
			const selectItems: SelectItem[] = items.map((label) => ({ value: label, label }));
			const sl = new SelectList(selectItems, Math.min(items.length, 18), getSelectListTheme());
			sl.setSelectedIndex(Math.max(0, Math.min(initialIndex, items.length - 1)));
			sl.onSelect = (item) => done({ value: item.value, index: selectItems.indexOf(item) });
			sl.onCancel = () => done(null);
			return {
				render: (w: number) => sl.render(w),
				invalidate: () => sl.invalidate(),
				handleInput: (data: string) => { sl.handleInput(data); tui.requestRender(); },
			};
		},
	);

	if (!result) return null;
	return { choice: result.value, index: result.index };
}

// ---------------------------------------------------------------------------
// Cursor persistence helper
// ---------------------------------------------------------------------------

/**
 * Find the best index to restore the cursor to after the menu items array
 * has been rebuilt (queue row may have appeared/disappeared).
 *
 * Strategy:
 * 1. Exact match — the label is unchanged.
 * 2. Prefix match up to the first colon — handles dynamic labels such as
 *    "speak: enabled" ↔ "speak: disabled", "Voice: M1" ↔ "Voice: M2", etc.
 * 3. Fallback to 0.
 */
function findMenuIndex(items: string[], lastChoice: string): number {
	if (!lastChoice) return 0;
	const exact = items.indexOf(lastChoice);
	if (exact >= 0) return exact;
	const colon = lastChoice.indexOf(":");
	if (colon >= 0) {
		const prefix = lastChoice.slice(0, colon + 1);
		const prefixMatch = items.findIndex((item) => item.startsWith(prefix));
		if (prefixMatch >= 0) return prefixMatch;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Main menu loop
// ---------------------------------------------------------------------------

export async function runSpeakMenu(
	ctx: MenuCtx,
	options: MenuOptions,
): Promise<void> {
	// Track mutable state locally so the menu reflects live values each iteration.
	let enabled = options.enabled;
	let sessionVoice = options.sessionVoice;
	let sessionLang = options.sessionLang;
	let sessionSpeed = options.sessionSpeed;
	let sessionSteps = options.sessionSteps;
	let lastChoice = "";

	while (true) {
		const config = options.loadConfig();
		const defaultVoice   = config.defaultVoice   ?? "M1";
		const defaultLang    = config.defaultLang    ?? "en";
		const defaultSpeed   = config.defaultSpeed   ?? 1.05;
		const defaultSteps   = config.defaultSteps   ?? 8;

		const effVoice   = effectiveValue(sessionVoice,   config.defaultVoice,   "M1");
		const effLang    = effectiveValue(sessionLang,    config.defaultLang,    "en");
		const effSpeed   = effectiveValue(sessionSpeed,   config.defaultSpeed,   1.05);
		const effSteps   = effectiveValue(sessionSteps,   config.defaultSteps,   8);

		const assetsDir = options.getAssetsDir();

		const queueLen = options.getQueueLength();

		const items: string[] = [
			`speak: ${enabled ? "enabled" : "disabled"}`,
			"Test speech",
			...(queueLen > 0 ? [`Queue: ${queueLen} item${queueLen === 1 ? "" : "s"} pending`] : []),
			"───────────────────────────────────",
			`Voice: ${effVoice}`,
			`Language: ${effLang}`,
			`Speed: ${nearestPresetLabel(SPEED_PRESETS, effSpeed)}`,
			`Steps: ${nearestPresetLabel(STEPS_PRESETS, effSteps)}`,
			"───────────────────────────────────",
			`Default voice: ${defaultVoice}`,
			`Default language: ${defaultLang}`,
			`Default speed: ${nearestPresetLabel(SPEED_PRESETS, defaultSpeed)}`,
			`Default steps: ${nearestPresetLabel(STEPS_PRESETS, defaultSteps)}`,
			"───────────────────────────────────",
			modelInfo(assetsDir),
			"───────────────────────────────────",
			"Close",
		];

		const lastIndex = findMenuIndex(items, lastChoice);
		const result = await selectAt(ctx, "speak", items, lastIndex);
		if (!result || result.choice === "Close") return;
		const { choice } = result;
		lastChoice = choice;

		// Separator lines and read-only display items are non-selectable.
		if (choice.startsWith("─")) continue;
		if (choice.startsWith("Queue:")) continue;

		if (choice.startsWith("speak:")) {
			enabled = await options.onToggle();
			continue;
		}

		if (choice === "Test speech") {
			void options.onTest().catch(() => {});
			continue;
		}

		// ── Session settings ────────────────────────────────────────────────

		if (choice.startsWith("Voice: ")) {
			const v = await pickVoice(ctx, effVoice, options.onSpeakHello);
			if (v) {
				sessionVoice = v;
				options.onSetSessionVoice(v);
				void options.onSpeakHello(v).catch(() => {});
			}
			continue;
		}

		if (choice.startsWith("Language: ")) {
			const v = await pickLang(ctx, effLang);
			if (v) {
				sessionLang = v;
				options.onSetSessionLang(v);
				void options.onSpeakHello(effectiveValue(sessionVoice, config.defaultVoice, "M1")).catch(() => {});
			}
			continue;
		}

		if (choice.startsWith("Speed: ")) {
			const v = await pickSpeed(ctx, effSpeed);
			if (v !== null) {
				sessionSpeed = v;
				options.onSetSessionSpeed(v);
				void options.onSpeakHello(effectiveValue(sessionVoice, config.defaultVoice, "M1")).catch(() => {});
			}
			continue;
		}

		if (choice.startsWith("Steps: ")) {
			const v = await pickSteps(ctx, effSteps);
			if (v !== null) {
				sessionSteps = v;
				options.onSetSessionSteps(v);
				void options.onSpeakHello(effectiveValue(sessionVoice, config.defaultVoice, "M1")).catch(() => {});
			}
			continue;
		}

		// ── Default settings (no hello playback) ───────────────────────────

		if (choice.startsWith("Default voice: ")) {
			const v = await pickVoice(ctx, defaultVoice, options.onSpeakHello);
			if (v) {
				options.saveConfig({ defaultVoice: v });
			}
			continue;
		}

		if (choice.startsWith("Default language: ")) {
			const v = await pickLang(ctx, defaultLang);
			if (v) {
				options.saveConfig({ defaultLang: v });
			}
			continue;
		}

		if (choice.startsWith("Default speed: ")) {
			const v = await pickSpeed(ctx, defaultSpeed);
			if (v !== null) {
				options.saveConfig({ defaultSpeed: v });
			}
			continue;
		}

		if (choice.startsWith("Default steps: ")) {
			const v = await pickSteps(ctx, defaultSteps);
			if (v !== null) {
				options.saveConfig({ defaultSteps: v });
			}
			continue;
		}
	}
}
