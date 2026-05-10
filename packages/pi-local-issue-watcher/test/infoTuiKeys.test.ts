/**
 * Pure-unit tests for the input-dispatch helpers extracted from
 * `infoTui.ts`. The TUI shell is excluded from coverage; these
 * helpers are covered.
 */

import { describe, expect, it } from "vitest";

import { dispatchKey, isListNavKey } from "../src/infoTuiKeys.js";

/**
 * Stand-in for `matchesKey` from `@mariozechner/pi-tui` sized to what
 * `dispatchKey` actually asks about: `escape`, `ctrl+c`, `left`.
 * Accepts both the legacy byte forms and a couple of Kitty-encoded
 * CSI variants so the tests double as a regression guard for #0026.
 */
function fakeMatchesKey(data: string, keyId: string): boolean {
	switch (keyId) {
		case "escape":
			return data === "\x1b" || data === "\x1b[27u";
		case "ctrl+c":
			return data === "\x03" || data === "\x1b[99;5u";
		case "left":
			return data === "\x1b[D" || data === "\x1b[1;2D";
		default:
			return false;
	}
}

describe("isListNavKey", () => {
	it.each([
		["\x1b[A", "up arrow"],
		["\x1b[B", "down arrow"],
		["\x1b[C", "right arrow"],
		["\x1b[D", "left arrow"],
		["\x1b[H", "Home"],
		["\x1b[F", "End"],
		["\x1b[5~", "PageUp"],
		["\x1b[6~", "PageDown"],
		["\r", "CR"],
		["\n", "LF"],
	])("returns true for %j (%s)", (data) => {
		expect(isListNavKey(data)).toBe(true);
	});

	it.each([
		["a", "letter"],
		["/", "slash"],
		["\x7f", "DEL/backspace"],
		["\x03", "Ctrl-C"],
		["\x1b", "bare Esc"],
		["", "empty"],
	])("returns false for %j (%s)", (data) => {
		expect(isListNavKey(data)).toBe(false);
	});
});

describe("dispatchKey — shared", () => {
	it.each([
		["list" as const, "\x03", "Ctrl-C legacy"],
		["detail" as const, "\x03", "Ctrl-C legacy"],
		["list" as const, "\x1b[99;5u", "Ctrl-C kitty"],
		["detail" as const, "\x1b[99;5u", "Ctrl-C kitty"],
	])("Ctrl-C in %s mode (%s) → quit", (mode, data, _label) => {
		expect(dispatchKey(mode, data, fakeMatchesKey)).toEqual({ kind: "quit" });
	});
});

describe("dispatchKey — detail mode", () => {
	it.each([
		["\x1b", "Esc legacy"],
		["\x1b[27u", "Esc kitty"],
		["\x1b[D", "Left legacy"],
		["\x1b[1;2D", "Left kitty"],
	])("%j (%s) → back-to-list", (data) => {
		expect(dispatchKey("detail", data, fakeMatchesKey)).toEqual({
			kind: "back-to-list",
		});
	});

	it.each([
		["a", "letter"],
		["q", "q (would conflict with search in list)"],
		["/", "slash"],
		["\r", "Enter"],
		["\x1b[A", "up arrow"],
		["\x7f", "backspace"],
	])("%j (%s) → ignore (detail view is read-only)", (data) => {
		expect(dispatchKey("detail", data, fakeMatchesKey)).toEqual({
			kind: "ignore",
		});
	});
});

describe("dispatchKey — list mode", () => {
	it.each([
		["\x1b", "Esc legacy"],
		["\x1b[27u", "Esc kitty"],
	])("Esc %j (%s) → quit", (data) => {
		expect(dispatchKey("list", data, fakeMatchesKey)).toEqual({ kind: "quit" });
	});

	it.each([
		["\x1b[A", "up"],
		["\x1b[B", "down"],
		["\x1b[5~", "PageUp"],
		["\r", "Enter"],
		["\n", "LF"],
	])("%j (%s) → list-nav", (data) => {
		expect(dispatchKey("list", data, fakeMatchesKey)).toEqual({
			kind: "list-nav",
		});
	});

	it.each([
		["a", "letter"],
		["q", "letter q"],
		["Z", "capital Z"],
		["/", "slash"],
		["\x7f", "backspace"],
		["\x17", "Ctrl-W"],
		["\x15", "Ctrl-U"],
	])("%j (%s) → filter-input", (data) => {
		expect(dispatchKey("list", data, fakeMatchesKey)).toEqual({
			kind: "filter-input",
		});
	});
});
