import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { assetsReady } from "./config.js";

// ---------------------------------------------------------------------------
// Re-export types / constants so callers only need one import
// ---------------------------------------------------------------------------

export const VOICES = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"] as const;
export type VoiceId = (typeof VOICES)[number];

export const LANGS = [
	"en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es",
	"et", "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv",
	"nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na",
] as const;
export type LangCode = (typeof LANGS)[number];

export interface SynthesisOptions {
	/** Voice ID, e.g. "M1" or "F3" (default: "M1") */
	voice?: VoiceId;
	/** Language code, e.g. "en" or "ko" (default: "en") */
	lang?: LangCode;
	/** Diffusion steps — higher = slightly better quality (default: 8) */
	steps?: number;
	/** Speaking rate multiplier (default: 1.05) */
	speed?: number;
	/** Silence padding in seconds (default: 0.3) */
	silenceDuration?: number;
}

export interface SynthesisResult {
	/** Raw PCM samples (float32, mono) */
	wav: number[];
	/** Sample rate in Hz (typically 44 100) */
	sampleRate: number;
	/** Per-segment durations in seconds */
	duration: number[];
}

// ---------------------------------------------------------------------------
// Helper path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the Supertone helper module.
 *
 * Primary: vendor copy bundled with this package (MIT-licensed verbatim copy).
 * Fallback: cloned repo at ~/.pi/agent/pi-speak/supertonic/nodejs/helper.js
 */
function resolveHelperPath(): string {
	const vendorPath = fileURLToPath(
		new URL("./vendor/supertonic-helper.js", import.meta.url),
	);
	if (existsSync(vendorPath)) return vendorPath;
	return join(getAgentDir(), "pi-speak", "supertonic", "nodejs", "helper.js");
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function assertVoice(v: string): asserts v is VoiceId {
	if (!(VOICES as readonly string[]).includes(v)) {
		throw new Error(`Invalid voice "${v}". Available voices: ${VOICES.join(", ")}`);
	}
}

function assertLang(l: string): asserts l is LangCode {
	if (!(LANGS as readonly string[]).includes(l)) {
		throw new Error(`Invalid language code "${l}". Available langs: ${LANGS.join(", ")}`);
	}
}

function assertAssetsExist(assetsDir: string): void {
	if (!assetsReady(assetsDir)) {
		throw new Error(
			`Supertone assets not found in: ${assetsDir}\n` +
			`Run /speak to download Supertonic models.`,
		);
	}
}

function assertHelperExists(helperPath: string): void {
	if (!existsSync(helperPath)) {
		throw new Error(
			`Supertone helper not found: ${helperPath}\n` +
			`Run /speak to download Supertonic models.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Voice-style path resolution
// ---------------------------------------------------------------------------

function resolveVoiceStylePaths(assetsDir: string, voice: VoiceId): string[] {
	const voiceFile = join(assetsDir, "voice_styles", `${voice}.json`);
	if (!existsSync(voiceFile)) {
		throw new Error(
			`Voice style file not found: ${voiceFile}\n` +
			`Run /speak to download Supertonic models.`,
		);
	}
	return [voiceFile];
}

// ---------------------------------------------------------------------------
// Helper import
// ---------------------------------------------------------------------------

async function importHelper(): Promise<typeof import("./vendor/supertonic-helper.js")> {
	const helperPath = resolveHelperPath();
	assertHelperExists(helperPath);
	const helperUrl = pathToFileURL(helperPath).href;
	return (await import(helperUrl)) as typeof import("./vendor/supertonic-helper.js");
}

// ---------------------------------------------------------------------------
// Engine + voice-style caches
// ---------------------------------------------------------------------------

/**
 * Cached TTS engine promise, keyed by onnxDir.
 * Loading four InferenceSession objects from disk costs 0.3–3 s — cache it
 * for the lifetime of the process so every subsequent call is free.
 */
let cachedEngineDir: string | null = null;
let cachedEnginePromise: Promise<Awaited<ReturnType<typeof import("./vendor/supertonic-helper.js")["loadTextToSpeech"]>>> | null = null;

async function getEngine(onnxDir: string): Promise<Awaited<ReturnType<typeof import("./vendor/supertonic-helper.js")["loadTextToSpeech"]>>> {
	if (cachedEngineDir !== onnxDir) {
		// Assets directory changed (e.g. config update) — invalidate.
		cachedEngineDir = null;
		cachedEnginePromise = null;
	}
	if (!cachedEnginePromise) {
		const { loadTextToSpeech } = await importHelper();
		cachedEnginePromise = loadTextToSpeech(onnxDir);
		cachedEngineDir = onnxDir;
	}
	return cachedEnginePromise;
}

/**
 * Cached voice-style objects, keyed by the voice-style file path.
 * Re-reading and parsing the JSON on every call wastes 5–30 ms.
 */
const voiceStyleCache = new Map<string, ReturnType<typeof import("./vendor/supertonic-helper.js")["loadVoiceStyle"]>>();

async function getVoiceStyle(
	voiceStylePaths: string[],
): Promise<ReturnType<typeof import("./vendor/supertonic-helper.js")["loadVoiceStyle"]>> {
	const key = voiceStylePaths.join("|");
	const cached = voiceStyleCache.get(key);
	if (cached) return cached;
	const { loadVoiceStyle } = await importHelper();
	const style = loadVoiceStyle(voiceStylePaths);
	voiceStyleCache.set(key, style);
	return style;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synthesise `text` and return raw PCM samples.
 *
 * @param text       Input text
 * @param options    Voice / lang / speed / steps / silenceDuration
 * @param assetsDir  Path to the downloaded Supertone assets directory
 */
export async function synthesise(
	text: string,
	options: SynthesisOptions = {},
	assetsDir: string,
): Promise<SynthesisResult> {
	const {
		voice = "M1",
		lang = "en",
		steps = 8,
		speed = 1.05,
		silenceDuration = 0.3,
	} = options;

	assertVoice(voice);
	assertLang(lang);
	assertAssetsExist(assetsDir);

	const onnxDir = join(assetsDir, "onnx");
	const voiceStylePaths = resolveVoiceStylePaths(assetsDir, voice);

	const tts = await getEngine(onnxDir);
	const style = await getVoiceStyle(voiceStylePaths);

	const result = await tts.call(text, lang, style, steps, speed, silenceDuration);

	return {
		wav: result.wav,
		sampleRate: tts.sampleRate,
		duration: result.duration,
	};
}

/**
 * Write PCM samples to a WAV file, delegating to helper.js's writeWavFile.
 */
export async function writeWav(
	filePath: string,
	wav: number[],
	sampleRate: number,
): Promise<void> {
	const { writeWavFile } = await importHelper();
	writeWavFile(filePath, wav, sampleRate);
}
