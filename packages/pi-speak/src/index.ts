/**
 * pi-speak — extension entrypoint.
 *
 * Registers a `speak` tool that synthesises text via the Supertone TTS engine
 * (ONNX, in-process) and plays audio through the OS device.
 *
 * The tool **returns immediately** with a queue position.  A single background
 * worker processes items sequentially: synthesise → play → next item.  The LLM
 * can call `speak` multiple times; all calls enqueue and the tool never blocks.
 *
 * The `/speak` slash command opens an interactive TUI menu to toggle it on/off,
 * pick a voice, and test speech.  If model assets are missing the menu shows a
 * download hint.
 *
 * Security notes
 * --------------
 * - No network calls from the extension itself.
 * - No dynamic eval / Function(...).
 * - APIs touched: pi.registerTool, pi.registerCommand, pi.on, pi.getActiveTools,
 *   pi.setActiveTools, pi.appendEntry.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { assetsReady, discoverAssetsDir, loadConfig, saveConfig } from "./config.js";
import { runSpeakMenu, LANG_PHRASES } from "./menu.js";
import type { MenuCtx } from "./menu.js";
import { renderCall, renderResult } from "./render.js";
import { MAX_TEXT_CHARS, SpeakParams, VOICES, type LangCode, type SpeakParamsT, type VoiceId } from "./schema.js";
import { SPEAK_STATE_CUSTOM_TYPE, type SpeakState, pickSavedState } from "./state.js";
import { playAudioFile } from "./audio.js";
import { synthesise, writeWav } from "./tts.js";
import { SpeechQueue } from "./queue.js";

/** Minimal ambient type for the command context's ui surface. */
type CmdUi = {
	ui: {
		select?: (title: string, items: string[]) => Promise<string | null | undefined>;
		notify: (msg: string, level?: "info" | "warning" | "error") => void;
		custom?: <T>(
			factory: (tui: { requestRender: () => void }, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
		) => Promise<T>;
	};
};

export default function speakExtension(pi: ExtensionAPI): void {
	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	const queue = new SpeechQueue();

	let enabled = false;
	let sessionVoice: string | undefined;
	let sessionLang: string | undefined;
	let sessionSpeed: number | undefined;
	let sessionSteps: number | undefined;
	let resolvedAssetsDir: string | undefined;

	function getAssetsDir(): string {
		// Only cache once assets are confirmed ready — so a download in the same
		// session is picked up automatically on the next /speak enable call.
		if (!resolvedAssetsDir || !assetsReady(resolvedAssetsDir)) {
			const dir = discoverAssetsDir(loadConfig());
			if (assetsReady(dir)) resolvedAssetsDir = dir;
			return dir;
		}
		return resolvedAssetsDir;
	}

	function persist(): void {
		const state: SpeakState = {
			enabled,
			...(sessionVoice   !== undefined ? { sessionVoice }   : {}),
			...(sessionLang    !== undefined ? { sessionLang }    : {}),
			...(sessionSpeed   !== undefined ? { sessionSpeed }   : {}),
			...(sessionSteps   !== undefined ? { sessionSteps }   : {}),
		};
		pi.appendEntry<SpeakState>(SPEAK_STATE_CUSTOM_TYPE, state);
	}

	function syncActive(): void {
		const active = pi.getActiveTools();
		const has = active.includes("speak");
		if (enabled && !has) pi.setActiveTools([...active, "speak"]);
		else if (!enabled && has) pi.setActiveTools(active.filter((t) => t !== "speak"));
	}

	// ---------------------------------------------------------------------------
	// Session event handlers
	// ---------------------------------------------------------------------------

	/** Restores persisted state — enabled flag and session overrides survive session resume. */
	pi.on("session_start", (_event, ctx) => {
		queue.clear();
		const saved = pickSavedState(ctx.sessionManager.getBranch());
		enabled        = saved?.enabled        ?? false;
		sessionVoice   = saved?.sessionVoice;
		sessionLang    = saved?.sessionLang;
		sessionSpeed   = saved?.sessionSpeed;
		sessionSteps   = saved?.sessionSteps;
		resolvedAssetsDir = undefined;
		syncActive();
	});

	/** Restores within-session branch state. */
	pi.on("session_tree", (_event, ctx) => {
		const saved = pickSavedState(ctx.sessionManager.getBranch());
		enabled        = saved?.enabled        ?? false;
		sessionVoice   = saved?.sessionVoice;
		sessionLang    = saved?.sessionLang;
		sessionSpeed   = saved?.sessionSpeed;
		sessionSteps   = saved?.sessionSteps;
		syncActive();
	});

	/** Reconciles if LLM toggled `speak` via `manage_tools`. */
	pi.on("turn_end", () => {
		const isActive = pi.getActiveTools().includes("speak");
		if (isActive !== enabled) {
			enabled = isActive;
			persist();
		}
	});

	// ---------------------------------------------------------------------------
	// Tool registration
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "speak",
		label: "Speak",
		description:
			"Synthesise text via the Supertone TTS engine and play it through the system audio. Only usable after /speak enables it. Returns immediately — speech plays in the background queue.",
		parameters: SpeakParams,
		renderCall(args, theme) {
			return renderCall(args, theme);
		},
		renderResult,
		// eslint-disable-next-line @typescript-eslint/require-await
		async execute(_id, params: SpeakParamsT) {
			const text = params.text;
			const shortText = text.slice(0, 80);

			if (text.length > MAX_TEXT_CHARS) {
				return {
					content: [{ type: "text" as const, text: `speak: text too long (${text.length} chars). Maximum is ${MAX_TEXT_CHARS} chars (~60 s of speech).` }],
					details: { ok: false, voice: "M1", lang: "en", text: shortText, message: `text too long: ${text.length} > ${MAX_TEXT_CHARS} chars` },
				};
			}

			const cfg = loadConfig();
			const assetsDir = getAssetsDir();

			if (!assetsReady(assetsDir)) {
				return {
					content: [{ type: "text" as const, text: "speak: assets not downloaded. Run /speak to install." }],
					details: { ok: false, voice: "M1", lang: "en", text: shortText, message: "assets not downloaded" },
				};
			}

			// Priority: session override → tool param → config default → fallback
			const rawVoice = sessionVoice ?? params.voice ?? cfg.defaultVoice ?? "M1";
			const voice = (VOICES as readonly string[]).includes(rawVoice)
				? rawVoice as VoiceId
				: "M1" as const;
			const lang  = (sessionLang  ?? params.lang   ?? cfg.defaultLang    ?? "en")  as LangCode;
			const speed = sessionSpeed  ?? params.speed  ?? cfg.defaultSpeed   ?? 1.05;
			const steps = sessionSteps  ?? params.steps  ?? cfg.defaultSteps   ?? 8;

			const pos = queue.enqueue({
				text, voice, lang, speed, steps, assetsDir,
				...(params.trigger_turn ? {
					onDone: () => pi.sendMessage(
						{ customType: "pi-speak:continue", content: "", display: false },
						{ triggerTurn: true, deliverAs: "followUp" },
					),
				} : {}),
			});

			return {
				content: [{ type: "text" as const, text: `Queued (#${pos}): ${shortText}${text.length > 80 ? "…" : ""}` }],
				details: { ok: true, voice, lang, text: shortText, queuePosition: pos },
			};
		},
	});

	// ---------------------------------------------------------------------------
	// /speak command — opens TUI menu
	// ---------------------------------------------------------------------------

	pi.registerCommand("speak", {
		description: "Open the speak settings menu (toggle on/off, pick voice/language/speed, test speech).",
		handler: async (_args, ctx) => {
			const cmdUi = ctx as unknown as CmdUi;
			if (!cmdUi.ui.select) {
				cmdUi.ui.notify("speak: requires an interactive UI.", "warning");
				return;
			}

			const menuCtx: MenuCtx = {
				ui: {
					select: cmdUi.ui.select,
					notify: cmdUi.ui.notify,
					...(cmdUi.ui.custom ? { custom: cmdUi.ui.custom.bind(cmdUi.ui) } : {}),
				},
			};

			await runSpeakMenu(menuCtx, {
				enabled,
				sessionVoice,
				sessionLang,
				sessionSpeed,
				sessionSteps,
				getAssetsDir,
				assetsReady,
				loadConfig,
				saveConfig,
				getQueueLength: () => queue.length,
				onToggle: (): Promise<boolean> => {
					if (enabled) {
						enabled = false;
						syncActive();
						persist();
						return Promise.resolve(false);
					} else {
						const assetsDir = getAssetsDir();
						if (!assetsReady(assetsDir)) {
							cmdUi.ui.notify(
								`speak: assets not found.\n\nDownload the Supertone models with:\n  huggingface-cli download Supertone/supertonic-3\n\nThen run /speak enable again.`,
								"warning",
							);
							return Promise.resolve(false);
						}
						enabled = true;
						syncActive();
						persist();
						return Promise.resolve(true);
					}
				},
				onTest: async () => {
					if (!enabled) {
						cmdUi.ui.notify("speak: disabled — enable first", "warning");
						return;
					}
					const voice = sessionVoice ?? loadConfig().defaultVoice ?? "M1";
					const lang  = sessionLang  ?? loadConfig().defaultLang  ?? "en";
					const assetsDir = getAssetsDir();
					const tmpPath = join(tmpdir(), `pi-speak-test-${Date.now()}.wav`);
					const text = LANG_PHRASES[lang] ?? "Hello from pi-speak.";
					try {
						const result = await synthesise(text, { voice: voice as VoiceId, lang: lang as LangCode }, assetsDir);
						await writeWav(tmpPath, result.wav, result.sampleRate);
						await playAudioFile(tmpPath);
					} catch (err) {
						cmdUi.ui.notify(`speak: test failed — ${(err as Error).message}`, "error");
					} finally {
						try { unlinkSync(tmpPath); } catch { /* ignore */ }
					}
				},
				onSetSessionVoice: (voice: string) => {
					sessionVoice = voice;
				},
				onSetSessionLang: (v: string) => {
					sessionLang = v;
				},
				onSetSessionSpeed: (v: number) => {
					sessionSpeed = v;
				},
				onSetSessionSteps: (v: number) => {
					sessionSteps = v;
				},
				onSpeakHello: async (voice: string) => {
					if (!enabled) return;
					const assetsDir = getAssetsDir();
					const tmpPath = join(tmpdir(), `pi-speak-hello-${Date.now()}.wav`);
					const lang = sessionLang ?? loadConfig().defaultLang ?? "en";
					const text = LANG_PHRASES[lang] ?? "Hello.";
					try {
						const result = await synthesise(text, {
							voice: voice as VoiceId,
							lang: lang as LangCode,
						}, assetsDir);
						await writeWav(tmpPath, result.wav, result.sampleRate);
						await playAudioFile(tmpPath);
					} catch { /* best-effort — don't surface errors for preview */ } finally {
						try { unlinkSync(tmpPath); } catch { /* ignore */ }
					}
				},
				onPreview: async (text: string, voice: string, lang: string, signal: AbortSignal, synthOpts?: { speed?: number; steps?: number }) => {
					if (signal.aborted) return;
					const assetsDir = getAssetsDir();
					const tmpPath = join(tmpdir(), `pi-speak-preview-${Date.now()}.wav`);
					try {
						const result = await synthesise(text, {
							voice: voice as VoiceId,
							lang:  lang  as LangCode,
							...(synthOpts?.speed !== undefined ? { speed: synthOpts.speed } : {}),
							...(synthOpts?.steps !== undefined ? { steps: synthOpts.steps } : {}),
						}, assetsDir);
						if (signal.aborted) return;   // synthesis done but user moved on
						await writeWav(tmpPath, result.wav, result.sampleRate);
						if (signal.aborted) return;
						await playAudioFile(tmpPath, signal);
					} catch {
						// swallow — aborts and synthesis errors are both expected
					} finally {
						try { unlinkSync(tmpPath); } catch { /* ignore */ }
					}
				},
			});
		},
	});
}
