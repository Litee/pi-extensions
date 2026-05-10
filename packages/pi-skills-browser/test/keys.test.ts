import { describe, expect, it } from "vitest";

import { dispatchKey, type MatchesKey } from "../src/keys.js";

/**
 * Build a `matchesKey` stub that returns true only for the listed (data, keyId)
 * pairs. Simulates pi-tui's keybinding matcher without importing it.
 */
function stubMatcher(pairs: Array<[string, string]>): MatchesKey {
	return (data, keyId) =>
		pairs.some(([d, k]) => d === data && (k as string) === (keyId as string));
}

describe("dispatchKey", () => {
	it("returns { kind: 'up' } for the up arrow", () => {
		const match = stubMatcher([["\x1b[A", "up"]]);
		expect(dispatchKey("\x1b[A", match)).toEqual({ kind: "up" });
	});

	it("returns { kind: 'down' } for the down arrow", () => {
		const match = stubMatcher([["\x1b[B", "down"]]);
		expect(dispatchKey("\x1b[B", match)).toEqual({ kind: "down" });
	});

	it("returns { kind: 'toggle-sort' } for the 's' key (before filter-char)", () => {
		const match = stubMatcher([["s", "s"]]);
		// Critically: even though "s" is also a printable ASCII char, it must
		// dispatch to toggle-sort, NOT filter-char.
		expect(dispatchKey("s", match)).toEqual({ kind: "toggle-sort" });
	});

	it("returns { kind: 'backspace' } for backspace", () => {
		const match = stubMatcher([["\x7f", "backspace"]]);
		expect(dispatchKey("\x7f", match)).toEqual({ kind: "backspace" });
	});

	it("returns { kind: 'backspace' } for delete", () => {
		const match = stubMatcher([["\x1b[3~", "delete"]]);
		expect(dispatchKey("\x1b[3~", match)).toEqual({ kind: "backspace" });
	});

	it("returns { kind: 'filter-char' } for printable ASCII characters", () => {
		const match = stubMatcher([]); // nothing matches any keyId
		expect(dispatchKey("a", match)).toEqual({ kind: "filter-char", char: "a" });
		expect(dispatchKey("Z", match)).toEqual({ kind: "filter-char", char: "Z" });
		expect(dispatchKey("-", match)).toEqual({ kind: "filter-char", char: "-" });
		expect(dispatchKey(" ", match)).toEqual({ kind: "filter-char", char: " " });
	});

	it("returns { kind: 'ignore' } for non-printable single-byte input", () => {
		const match = stubMatcher([]);
		// NUL, ESC, DEL
		expect(dispatchKey("\x00", match)).toEqual({ kind: "ignore" });
		expect(dispatchKey("\x1b", match)).toEqual({ kind: "ignore" });
		expect(dispatchKey("\x7f", match)).toEqual({ kind: "ignore" });
	});

	it("returns { kind: 'ignore' } for multi-byte sequences that do not match any key", () => {
		const match = stubMatcher([]);
		expect(dispatchKey("\x1b[C", match)).toEqual({ kind: "ignore" }); // right arrow
		expect(dispatchKey("abc", match)).toEqual({ kind: "ignore" });
	});
});
