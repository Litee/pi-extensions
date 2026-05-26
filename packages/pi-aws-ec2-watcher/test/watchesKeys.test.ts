import { describe, expect, it } from "vitest";

import { dispatchKey, type KeyMatcher } from "../src/ui/watchesKeys.js";

const match: KeyMatcher = (data, key) => data === key;

describe("dispatchKey — normal mode", () => {
	it("q → quit", () => expect(dispatchKey(false, "q", match)).toEqual({ kind: "quit" }));
	it("escape → quit", () => expect(dispatchKey(false, "escape", match)).toEqual({ kind: "quit" }));
	it("up → move-up", () => expect(dispatchKey(false, "up", match)).toEqual({ kind: "move-up" }));
	it("down → move-down", () => expect(dispatchKey(false, "down", match)).toEqual({ kind: "move-down" }));
	it("r → refresh", () => expect(dispatchKey(false, "r", match)).toEqual({ kind: "refresh" }));
	it("t → toggle-display", () => expect(dispatchKey(false, "t", match)).toEqual({ kind: "toggle-display" }));
	it("x → begin-stop", () => expect(dispatchKey(false, "x", match)).toEqual({ kind: "begin-stop" }));
	it("s → begin-start", () => expect(dispatchKey(false, "s", match)).toEqual({ kind: "begin-start" }));
	it("d → begin-unwatch", () => expect(dispatchKey(false, "d", match)).toEqual({ kind: "begin-unwatch" }));
	it("D → begin-purge-terminal", () => expect(dispatchKey(false, "D", match)).toEqual({ kind: "begin-purge-terminal" }));
	it("unrecognised key → ignore", () => expect(dispatchKey(false, "z", match)).toEqual({ kind: "ignore" }));
});

describe("dispatchKey — confirm mode", () => {
	it("y → confirm", () => expect(dispatchKey(true, "y", match)).toEqual({ kind: "confirm" }));
	it("n → cancel", () => expect(dispatchKey(true, "n", match)).toEqual({ kind: "cancel" }));
	it("escape → cancel", () => expect(dispatchKey(true, "escape", match)).toEqual({ kind: "cancel" }));
	it("other key → ignore", () => expect(dispatchKey(true, "q", match)).toEqual({ kind: "ignore" }));
});
