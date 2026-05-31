import { type Static, Type } from "typebox";

/** Max text length before the tool rejects the call (~60 s of speech at 140 wpm). */
export const MAX_TEXT_CHARS = 700;

export const VOICES = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"] as const;
export type VoiceId = (typeof VOICES)[number];

export const LANGS = [
	"en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es",
	"et", "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv",
	"nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na",
] as const;
export type LangCode = (typeof LANGS)[number];

export const SpeakParams = Type.Object({
	text: Type.String({ minLength: 1, maxLength: MAX_TEXT_CHARS, description: `Text to speak aloud. Maximum ${MAX_TEXT_CHARS} characters (~60 s of speech at normal tempo).` }),
	voice: Type.Optional(Type.Union(
		[...VOICES].map(v => Type.Literal(v)),
		{ description: "Voice ID. M1–M5 male, F1–F5 female. Default M1." },
	)),
	lang: Type.Optional(Type.Union(
		[...LANGS].map(l => Type.Literal(l)),
		{ description: "Language code. Default en." },
	)),
	speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2.0, description: "Rate multiplier. Default 1.05." })),
	steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, description: "Diffusion steps. Default 8." })),
	wait: Type.Optional(Type.Boolean({ description: "Block until playback finishes (default true)." })),
});
export type SpeakParamsT = Static<typeof SpeakParams>;
