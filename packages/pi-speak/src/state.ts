import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Prefixed with "pi-speak:" to avoid collisions with other extensions' session keys. */
export const SPEAK_STATE_CUSTOM_TYPE = "pi-speak:state";

export interface SpeakState {
	enabled: boolean;
	sessionVoice?: string;
	sessionLang?: string;
	sessionSpeed?: number;
	sessionSteps?: number;
}

/**
 * Walk branch entries in order; return the most recent valid pi-speak:state payload.
 * Used for within-session branch navigation only (NOT cross-session restore).
 *
 * Pure: no pi/session side effects.
 */
export function pickSavedState(branchEntries: readonly SessionEntry[]): SpeakState | undefined {
	let saved: SpeakState | undefined;
	for (const entry of branchEntries) {
		if (entry.type === "custom" && entry.customType === SPEAK_STATE_CUSTOM_TYPE) {
			const raw = (entry as { data?: unknown }).data;
			if (raw && typeof raw === "object") {
				const r = raw as Record<string, unknown>;
				if (typeof r["enabled"] === "boolean") {
					const state: SpeakState = { enabled: r["enabled"] };
					if (typeof r["sessionVoice"] === "string") state.sessionVoice = r["sessionVoice"];
					if (typeof r["sessionLang"] === "string") state.sessionLang = r["sessionLang"];
					if (typeof r["sessionSpeed"] === "number") state.sessionSpeed = r["sessionSpeed"];
					if (typeof r["sessionSteps"] === "number") state.sessionSteps = r["sessionSteps"];
					saved = state;
				}
			}
		}
	}
	return saved;
}
