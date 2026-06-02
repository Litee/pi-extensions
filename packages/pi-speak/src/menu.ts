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
import { LANGS, VOICES, type LangCode, type VoiceId } from "./schema.js";

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
	/**
	 * Synthesise `text` with the given `voice` + `lang` and play it.
	 * Honour `signal` — check it before starting playback; pass it to
	 * the player so it can be aborted mid-stream.
	 */
	onPreview: (text: string, voice: string, lang: string, signal: AbortSignal, synthOpts?: { speed?: number; steps?: number }) => Promise<void>;
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
// Language name map
// ---------------------------------------------------------------------------

const LANG_NAMES: Readonly<Record<string, string>> = {
	en: "English",   ko: "Korean",     ja: "Japanese",  ar: "Arabic",
	bg: "Bulgarian", cs: "Czech",      da: "Danish",    de: "German",
	el: "Greek",     es: "Spanish",    et: "Estonian",  fi: "Finnish",
	fr: "French",    hi: "Hindi",      hr: "Croatian",  hu: "Hungarian",
	id: "Indonesian",it: "Italian",    lt: "Lithuanian",lv: "Latvian",
	nl: "Dutch",     pl: "Polish",     pt: "Portuguese",ro: "Romanian",
	ru: "Russian",   sk: "Slovak",     sl: "Slovenian", sv: "Swedish",
	tr: "Turkish",   uk: "Ukrainian",  vi: "Vietnamese",na: "Neutral",
};

/** Native-language preview phrases for the language picker. Exported for use in index.ts. */
export const LANG_PHRASES: Readonly<Record<string, string>> = {
	en: "Hello, I speak English.",
	ko: "안녕하세요, 저는 한국어를 말합니다.",
	ja: "こんにちは、私は日本語を話します。",
	ar: "مرحباً، أنا أتحدث العربية.",
	bg: "Здравейте, говоря български.",
	cs: "Dobrý den, mluvím česky.",
	da: "Hej, jeg taler dansk.",
	de: "Hallo, ich spreche Deutsch.",
	el: "Γεια σας, μιλάω ελληνικά.",
	es: "Hola, hablo español.",
	et: "Tere, ma räägin eesti keelt.",
	fi: "Hei, puhun suomea.",
	fr: "Bonjour, je parle français.",
	hi: "नमस्ते, मैं हिंदी बोलता हूँ।",
	hr: "Bok, govorim hrvatski.",
	hu: "Helló, magyarul beszélek.",
	id: "Halo, saya berbicara bahasa Indonesia.",
	it: "Ciao, parlo italiano.",
	lt: "Labas, aš kalbu lietuviškai.",
	lv: "Sveiki, es runāju latviski.",
	nl: "Hallo, ik spreek Nederlands.",
	pl: "Cześć, mówię po polsku.",
	pt: "Olá, eu falo português.",
	ro: "Bună ziua, vorbesc română.",
	ru: "Привет, я говорю по-русски.",
	sk: "Ahoj, hovorím po slovensky.",
	sl: "Zdravo, govorim slovensko.",
	sv: "Hej, jag talar svenska.",
	tr: "Merhaba, Türkçe konuşuyorum.",
	uk: "Привіт, я розмовляю українською.",
	vi: "Xin chào, tôi nói tiếng Việt.",
	na: "Hello, I speak neutral.",
};

// ---------------------------------------------------------------------------
// Sub-menu pickers
// ---------------------------------------------------------------------------

async function pickVoice(
	ctx: MenuCtx,
	current: string,
	effLang: string,
	options: Pick<MenuOptions, "onPreview" | "onSpeakHello">,
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

		let previewAc: AbortController | undefined;
		let isPlaying = false;

		const abortPreview = () => {
			previewAc?.abort();
			previewAc = undefined;
		};

		sl.onSelect = (item) => {
			clearTimeout(debounceTimer);
			abortPreview();
			done(item.value);
		};
		sl.onCancel = () => {
			clearTimeout(debounceTimer);
			abortPreview();
			done(null);
		};

		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		sl.onSelectionChange = (item) => {
			clearTimeout(debounceTimer);
			abortPreview();
			isPlaying = false;
			debounceTimer = setTimeout(() => {
				const ac = new AbortController();
				previewAc = ac;
				isPlaying = true;
				tui.requestRender();
				const text = `Hello, I'm voice ${item.value}.`;
				void options.onPreview(text, item.value, effLang, ac.signal)
					.catch(() => {})
					.finally(() => {
						if (previewAc === ac) {
							isPlaying = false;
							tui.requestRender();
						}
					});
			}, 400);
			tui.requestRender();
		};

		return {
			render: (w: number) => [
				theme.bold(`Select voice  (current: ${current})${isPlaying ? "  🔊" : ""}`),
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

async function pickLang(
	ctx: MenuCtx,
	current: string,
	effVoice: string,
	options: Pick<MenuOptions, "onPreview">,
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
		const items: string[] = [...LANGS, "─────", "Cancel"];
		const choice = await ctx.ui.select(`Select language  (current: ${current})`, items);
		if (!choice || choice === "Cancel" || choice.startsWith("─")) return null;
		return choice;
	}

	return (ctxWithCustom.ui.custom<string | null>((tui, theme, _kb, done) => {
		const items: SelectItem[] = LANGS.map((l) => ({ value: l, label: l === current ? `${l} ◀` : l }));
		const sl = new SelectList(items, Math.min(items.length + 2, 15), getSelectListTheme());

		const currentIdx = LANGS.indexOf(current as LangCode);
		if (currentIdx >= 0) sl.setSelectedIndex(currentIdx);

		let previewAc: AbortController | undefined;
		let isPlaying = false;

		const abortPreview = () => {
			previewAc?.abort();
			previewAc = undefined;
		};

		sl.onSelect = (item) => {
			clearTimeout(debounceTimer);
			abortPreview();
			done(item.value);
		};
		sl.onCancel = () => {
			clearTimeout(debounceTimer);
			abortPreview();
			done(null);
		};

		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		sl.onSelectionChange = (item) => {
			clearTimeout(debounceTimer);
			abortPreview();
			isPlaying = false;
			debounceTimer = setTimeout(() => {
				const ac = new AbortController();
				previewAc = ac;
				isPlaying = true;
				tui.requestRender();
				const text = LANG_PHRASES[item.value] ?? `Hello, I'm ${LANG_NAMES[item.value] ?? item.value}.`;
				void options.onPreview(text, effVoice, item.value, ac.signal)
					.catch(() => {})
					.finally(() => {
						if (previewAc === ac) {
							isPlaying = false;
							tui.requestRender();
						}
					});
			}, 400);
			tui.requestRender();
		};

		return {
			render: (w: number) => [
				theme.bold(`Select language  (current: ${current})${isPlaying ? "  🔊" : ""}`),
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

async function pickSpeed(
	ctx: MenuCtx,
	current: number,
	effVoice: string,
	effLang: string,
	options: Pick<MenuOptions, "onPreview">,
): Promise<number | null> {
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
		const items: string[] = [...SPEED_PRESETS.map((p) => p.label), "─────", "Cancel"];
		const choice = await ctx.ui.select(`Select speed  (current: ${current})`, items);
		if (!choice || choice === "Cancel" || choice.startsWith("─")) return null;
		return SPEED_PRESETS.find((p) => p.label === choice)?.value ?? null;
	}

	const result = await ctxWithCustom.ui.custom<string | null>((tui, theme, _kb, done) => {
		const items: SelectItem[] = SPEED_PRESETS.map((p) => ({ value: String(p.value), label: p.label }));
		const sl = new SelectList(items, Math.min(items.length + 2, 15), getSelectListTheme());

		const currentIdx = SPEED_PRESETS.findIndex((p) => p.value === current);
		if (currentIdx >= 0) sl.setSelectedIndex(currentIdx);

		let previewAc: AbortController | undefined;
		let isPlaying = false;

		const abortPreview = () => {
			previewAc?.abort();
			previewAc = undefined;
		};

		sl.onSelect = (item) => {
			clearTimeout(debounceTimer);
			abortPreview();
			done(item.value);
		};
		sl.onCancel = () => {
			clearTimeout(debounceTimer);
			abortPreview();
			done(null);
		};

		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		sl.onSelectionChange = (item) => {
			clearTimeout(debounceTimer);
			abortPreview();
			isPlaying = false;
			debounceTimer = setTimeout(() => {
				const ac = new AbortController();
				previewAc = ac;
				isPlaying = true;
				tui.requestRender();
				const text = LANG_PHRASES[effLang] ?? "Hello.";
				const speed = parseFloat(item.value);
				void options.onPreview(text, effVoice, effLang, ac.signal, { speed })
					.catch(() => {})
					.finally(() => {
						if (previewAc === ac) {
							isPlaying = false;
							tui.requestRender();
						}
					});
			}, 400);
			tui.requestRender();
		};

		return {
			render: (w: number) => [
				theme.bold(`Select speed  (current: ${current})${isPlaying ? "  🔊" : ""}`),
				theme.fg("dim", "↑↓ navigate to preview · Enter to select · Esc to cancel"),
				...sl.render(w),
			],
			invalidate: () => sl.invalidate(),
			handleInput: (data: string) => {
				sl.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return result !== null ? parseFloat(result) : null;
}

async function pickSteps(
	ctx: MenuCtx,
	current: number,
	effVoice: string,
	effLang: string,
	options: Pick<MenuOptions, "onPreview">,
): Promise<number | null> {
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
		const items: string[] = [...STEPS_PRESETS.map((p) => p.label), "─────", "Cancel"];
		const choice = await ctx.ui.select(`Select steps  (current: ${current})`, items);
		if (!choice || choice === "Cancel" || choice.startsWith("─")) return null;
		return STEPS_PRESETS.find((p) => p.label === choice)?.value ?? null;
	}

	const result = await ctxWithCustom.ui.custom<string | null>((tui, theme, _kb, done) => {
		const items: SelectItem[] = STEPS_PRESETS.map((p) => ({ value: String(p.value), label: p.label }));
		const sl = new SelectList(items, Math.min(items.length + 2, 15), getSelectListTheme());

		const currentIdx = STEPS_PRESETS.findIndex((p) => p.value === current);
		if (currentIdx >= 0) sl.setSelectedIndex(currentIdx);

		let previewAc: AbortController | undefined;
		let isPlaying = false;

		const abortPreview = () => {
			previewAc?.abort();
			previewAc = undefined;
		};

		sl.onSelect = (item) => {
			clearTimeout(debounceTimer);
			abortPreview();
			done(item.value);
		};
		sl.onCancel = () => {
			clearTimeout(debounceTimer);
			abortPreview();
			done(null);
		};

		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		sl.onSelectionChange = (item) => {
			clearTimeout(debounceTimer);
			abortPreview();
			isPlaying = false;
			debounceTimer = setTimeout(() => {
				const ac = new AbortController();
				previewAc = ac;
				isPlaying = true;
				tui.requestRender();
				const text = LANG_PHRASES[effLang] ?? "Hello.";
				const steps = parseInt(item.value, 10);
				void options.onPreview(text, effVoice, effLang, ac.signal, { steps })
					.catch(() => {})
					.finally(() => {
						if (previewAc === ac) {
							isPlaying = false;
							tui.requestRender();
						}
					});
			}, 400);
			tui.requestRender();
		};

		return {
			render: (w: number) => [
				theme.bold(`Select steps  (current: ${current})${isPlaying ? "  🔊" : ""}`),
				theme.fg("dim", "↑↓ navigate to preview · Enter to select · Esc to cancel"),
				...sl.render(w),
			],
			invalidate: () => sl.invalidate(),
			handleInput: (data: string) => {
				sl.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return result !== null ? parseInt(result, 10) : null;
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
	opts?: {
		/** Called during render; return a string to show above the list, undefined to show nothing. */
		extraHeader?: () => string | undefined;
		/** Called once with tui.requestRender so the caller can trigger re-renders. */
		bindRender?: (fn: () => void) => void;
	},
): Promise<{ choice: string; index: number } | null> {
	if (!ctx.ui.custom) {
		const choice = await ctx.ui.select(title, items);
		if (!choice) return null;
		return { choice, index: items.indexOf(choice) };
	}

	type TuiLike = { requestRender: () => void };

	const result = await ctx.ui.custom<{ value: string; index: number } | null>(
		(tui: TuiLike, _theme: unknown, _kb: unknown, done: (v: { value: string; index: number } | null) => void) => {
			opts?.bindRender?.(tui.requestRender.bind(tui));
			const selectItems: SelectItem[] = items.map((label) => ({ value: label, label }));
			const sl = new SelectList(selectItems, Math.min(items.length, 18), getSelectListTheme());
			sl.setSelectedIndex(Math.max(0, Math.min(initialIndex, items.length - 1)));
			sl.onSelect = (item) => done({ value: item.value, index: selectItems.indexOf(item) });
			sl.onCancel = () => done(null);
			return {
				render: (w: number) => {
					const extra = opts?.extraHeader?.();
					return [
						...(extra ? [extra] : []),
						...sl.render(w),
					];
				},
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
	let isTestPlaying = false;
	let requestMainMenuRender: (() => void) | undefined;

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
		const result = await selectAt(ctx, "speak", items, lastIndex, {
			extraHeader: () => isTestPlaying ? "  🔊 testing…" : undefined,
			bindRender: (fn) => { requestMainMenuRender = fn; },
		});
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
			isTestPlaying = true;
			void options.onTest()
				.catch(() => {})
				.finally(() => {
					isTestPlaying = false;
					requestMainMenuRender?.();
				});
			continue;
		}

		// ── Session settings ────────────────────────────────────────────────

		if (choice.startsWith("Voice: ")) {
			const v = await pickVoice(ctx, effVoice, effLang, options);
			if (v) {
				sessionVoice = v;
				options.onSetSessionVoice(v);
				void options.onSpeakHello(v).catch(() => {});
			}
			continue;
		}

		if (choice.startsWith("Language: ")) {
			const l = await pickLang(ctx, effLang, effVoice, options);
			if (l) {
				sessionLang = l;
				options.onSetSessionLang(l);
				void options.onSpeakHello(effectiveValue(sessionVoice, config.defaultVoice, "M1")).catch(() => {});
			}
			continue;
		}

		if (choice.startsWith("Speed: ")) {
			const v = await pickSpeed(ctx, effSpeed, effVoice, effLang, options);
			if (v !== null) {
				sessionSpeed = v;
				options.onSetSessionSpeed(v);
				void options.onSpeakHello(effectiveValue(sessionVoice, config.defaultVoice, "M1")).catch(() => {});
			}
			continue;
		}

		if (choice.startsWith("Steps: ")) {
			const v = await pickSteps(ctx, effSteps, effVoice, effLang, options);
			if (v !== null) {
				sessionSteps = v;
				options.onSetSessionSteps(v);
				void options.onSpeakHello(effectiveValue(sessionVoice, config.defaultVoice, "M1")).catch(() => {});
			}
			continue;
		}

		// ── Default settings (no hello playback) ───────────────────────────

		if (choice.startsWith("Default voice: ")) {
			const v = await pickVoice(ctx, defaultVoice, effLang, options);
			if (v) {
				options.saveConfig({ defaultVoice: v });
			}
			continue;
		}

		if (choice.startsWith("Default language: ")) {
			const l = await pickLang(ctx, defaultLang, effVoice, options);
			if (l) {
				options.saveConfig({ defaultLang: l });
			}
			continue;
		}

		if (choice.startsWith("Default speed: ")) {
			const v = await pickSpeed(ctx, defaultSpeed, defaultVoice, defaultLang, options);
			if (v !== null) {
				options.saveConfig({ defaultSpeed: v });
			}
			continue;
		}

		if (choice.startsWith("Default steps: ")) {
			const v = await pickSteps(ctx, defaultSteps, defaultVoice, defaultLang, options);
			if (v !== null) {
				options.saveConfig({ defaultSteps: v });
			}
			continue;
		}
	}
}
