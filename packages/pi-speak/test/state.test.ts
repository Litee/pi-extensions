import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { SPEAK_STATE_CUSTOM_TYPE, pickSavedState } from "../src/state.js";

describe("SPEAK_STATE_CUSTOM_TYPE", () => {
	it("is prefixed with pi-speak:", () => {
		expect(SPEAK_STATE_CUSTOM_TYPE).toBe("pi-speak:state");
	});
});

function makeCustomEntry(customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		customType,
		data,
		id: Math.random().toString(36),
		timestamp: Date.now(),
	} as unknown as SessionEntry;
}

describe("pickSavedState", () => {
	it("returns undefined for empty entries", () => {
		expect(pickSavedState([])).toBeUndefined();
	});

	it("returns undefined when no pi-speak:state entry exists", () => {
		const entries = [makeCustomEntry("other:type", { enabled: true })];
		expect(pickSavedState(entries)).toBeUndefined();
	});

	it("returns the single matching entry", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: true })];
		expect(pickSavedState(entries)).toEqual({ enabled: true });
	});

	it("returns the last matching entry when there are multiple", () => {
		const entries = [
			makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: true }),
			makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: false }),
		];
		expect(pickSavedState(entries)).toEqual({ enabled: false });
	});

	it("returns undefined for malformed payload (missing enabled)", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { foo: "bar" })];
		expect(pickSavedState(entries)).toBeUndefined();
	});

	it("returns undefined when enabled is not boolean", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: "yes" })];
		expect(pickSavedState(entries)).toBeUndefined();
	});

	it("ignores wrong customType entries mixed in", () => {
		const entries = [
			makeCustomEntry("wrong:type", { enabled: true }),
			makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: false }),
			makeCustomEntry("another:type", { enabled: true }),
		];
		expect(pickSavedState(entries)).toEqual({ enabled: false });
	});

	it("restores sessionVoice when present alongside enabled", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: true, sessionVoice: "F3" })];
		expect(pickSavedState(entries)).toEqual({ enabled: true, sessionVoice: "F3" });
	});

	it("omits sessionVoice when not present in payload", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: true })];
		const result = pickSavedState(entries);
		expect(result).toEqual({ enabled: true });
		expect(result?.sessionVoice).toBeUndefined();
	});

	it("restores all five session fields when all are present", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, {
			enabled: true,
			sessionVoice: "F3",
			sessionLang: "fr",
			sessionSpeed: 0.8,
			sessionSteps: 16,
		})];
		expect(pickSavedState(entries)).toEqual({
			enabled: true,
			sessionVoice: "F3",
			sessionLang: "fr",
			sessionSpeed: 0.8,
			sessionSteps: 16,
		});
	});

	it("restores sessionLang when present, omits when absent", () => {
		const withLang = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: false, sessionLang: "ko" })];
		expect(pickSavedState(withLang)?.sessionLang).toBe("ko");

		const withoutLang = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: false })];
		expect(pickSavedState(withoutLang)?.sessionLang).toBeUndefined();
	});

	it("restores sessionSpeed including value 0.8", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: true, sessionSpeed: 0.8 })];
		expect(pickSavedState(entries)?.sessionSpeed).toBe(0.8);
	});

	it("restores sessionSteps including value 4", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, { enabled: true, sessionSteps: 4 })];
		expect(pickSavedState(entries)?.sessionSteps).toBe(4);
	});

	it("ignores non-string sessionLang and non-number sessionSpeed/Steps", () => {
		const entries = [makeCustomEntry(SPEAK_STATE_CUSTOM_TYPE, {
			enabled: true,
			sessionLang: 42,
			sessionSpeed: "fast",
			sessionSteps: true,
		})];
		const result = pickSavedState(entries);
		expect(result?.sessionLang).toBeUndefined();
		expect(result?.sessionSpeed).toBeUndefined();
		expect(result?.sessionSteps).toBeUndefined();
	});
});
