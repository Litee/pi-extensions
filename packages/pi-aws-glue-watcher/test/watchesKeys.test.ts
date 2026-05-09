import { describe, expect, it } from "vitest";

import { dispatchKey, type KeyMatcher, type WatchesAction } from "../src/ui/watchesKeys.js";

/**
 * Deterministic matcher that compares the raw input to the key name
 * directly. This lets tests drive `dispatchKey` without pulling the
 * pi-tui key-parsing logic in.
 */
const exactMatch: KeyMatcher = (data, key) => data === String(key);

function act(inConfirmMode: boolean, data: string): WatchesAction {
	return dispatchKey(inConfirmMode, data, exactMatch);
}

describe("dispatchKey — normal mode", () => {
	it.each<[string, WatchesAction["kind"]]>([
		["q", "quit"],
		["escape", "quit"],
		["up", "move-up"],
		["down", "move-down"],
		["r", "refresh"],
		["t", "toggle-display"],
		["x", "begin-stop"],
		["d", "begin-unwatch"],
	])("maps %s → %s", (data, expected) => {
		expect(act(false, data).kind).toBe(expected);
	});

	it("ignores unknown keys", () => {
		expect(act(false, "zzz").kind).toBe("ignore");
	});

	it("ignores confirm keys (y/n) outside confirm-mode", () => {
		expect(act(false, "y").kind).toBe("ignore");
		expect(act(false, "n").kind).toBe("ignore");
	});
});

describe("dispatchKey — confirm mode", () => {
	it("maps y → confirm", () => {
		expect(act(true, "y").kind).toBe("confirm");
	});

	it("maps n → cancel", () => {
		expect(act(true, "n").kind).toBe("cancel");
	});

	it("maps Escape → cancel", () => {
		expect(act(true, "escape").kind).toBe("cancel");
	});

	it.each(["up", "down", "r", "t", "x", "d", "q", "zzz"])(
		"ignores %s in confirm-mode",
		(data) => {
			expect(act(true, data).kind).toBe("ignore");
		},
	);
});
