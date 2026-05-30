/**
 * Tests for the pure helpers in `browseTui.ts`. The actual `ctx.ui.custom`
 * shell is a thin wrapper and is not unit-tested here.
 */
import { describe, expect, it } from "vitest";

import {
	buildRowParts,
	dispatchBrowseKey,
	initialBrowseState,
	MENU_ITEMS,
	reduceBrowse,
	tildify,
	type BrowseState,
} from "../src/browseTui.js";

// matchesKey stub: exact string match against a small whitelist.
const matchesKey = (data: string, key: string): boolean => data === key;

describe("dispatchBrowseKey", () => {
	it("classifies escape as back (soft back/cancel)", () => {
		expect(dispatchBrowseKey("escape", matchesKey)).toEqual({ kind: "back" });
	});

	it("classifies ctrl+c as close (hard abort, always exits the TUI)", () => {
		expect(dispatchBrowseKey("ctrl+c", matchesKey)).toEqual({ kind: "close" });
	});

	it("classifies up arrow as up", () => {
		expect(dispatchBrowseKey("up", matchesKey)).toEqual({ kind: "up" });
	});

	it("classifies down arrow as down", () => {
		expect(dispatchBrowseKey("down", matchesKey)).toEqual({ kind: "down" });
	});

	it("classifies enter as activate", () => {
		expect(dispatchBrowseKey("enter", matchesKey)).toEqual({ kind: "activate" });
	});

	it("returns ignore for unknown keys", () => {
		expect(dispatchBrowseKey("space", matchesKey)).toEqual({ kind: "ignore" });
		expect(dispatchBrowseKey("a", matchesKey)).toEqual({ kind: "ignore" });
	});
});

describe("MENU_ITEMS", () => {
	it("lists Browse first, Close second (so Browse is the default selection)", () => {
		expect(MENU_ITEMS).toEqual(["Browse", "Close"]);
	});
});

describe("initialBrowseState", () => {
	it("opens on the menu screen with Browse selected", () => {
		expect(initialBrowseState.screen).toBe("menu");
		expect(initialBrowseState.menuIndex).toBe(0);
		expect(initialBrowseState.listIndex).toBe(0);
	});
});

describe("reduceBrowse — menu screen", () => {
	const menu = initialBrowseState;

	it("up clamps at 0 (Browse)", () => {
		const r = reduceBrowse(menu, { kind: "up" }, 5);
		expect(r.state.menuIndex).toBe(0);
		expect(r.effect.kind).toBe("render");
	});

	it("down advances to Close, then clamps", () => {
		const a = reduceBrowse(menu, { kind: "down" }, 5);
		expect(a.state.menuIndex).toBe(1);
		const b = reduceBrowse(a.state, { kind: "down" }, 5);
		expect(b.state.menuIndex).toBe(1);
	});

	it("activate on Browse switches to list screen and resets listIndex", () => {
		const onBrowse = { ...menu, menuIndex: 0, listIndex: 99 };
		const r = reduceBrowse(onBrowse, { kind: "activate" }, 5);
		expect(r.state.screen).toBe("list");
		expect(r.state.listIndex).toBe(0);
		expect(r.effect.kind).toBe("render");
	});

	it("activate on Close exits the TUI", () => {
		const onClose = { ...menu, menuIndex: 1 };
		const r = reduceBrowse(onClose, { kind: "activate" }, 5);
		expect(r.effect.kind).toBe("close");
	});

	it("back (Esc) on the menu closes (the menu is the root)", () => {
		const r = reduceBrowse(menu, { kind: "back" }, 5);
		expect(r.effect.kind).toBe("close");
	});

	it("close (Ctrl+C) always closes from the menu", () => {
		const r = reduceBrowse(menu, { kind: "close" }, 5);
		expect(r.effect.kind).toBe("close");
	});

	it("ignore is a render-only no-op", () => {
		const r = reduceBrowse(menu, { kind: "ignore" }, 5);
		expect(r.state).toEqual(menu);
		expect(r.effect.kind).toBe("render");
	});
});

describe("reduceBrowse — list screen", () => {
	const list: BrowseState = {
		screen: "list",
		menuIndex: 0,
		listIndex: 2,
		runsIndex: 0,
		runDetailIndex: 0,
	};

	it("up clamps at 0", () => {
		const at0 = reduceBrowse({ ...list, listIndex: 0 }, { kind: "up" }, 5);
		expect(at0.state.listIndex).toBe(0);
		const moved = reduceBrowse(list, { kind: "up" }, 5);
		expect(moved.state.listIndex).toBe(1);
	});

	it("down clamps at length-1", () => {
		const r = reduceBrowse({ ...list, listIndex: 4 }, { kind: "down" }, 5);
		expect(r.state.listIndex).toBe(4);
		const moved = reduceBrowse(list, { kind: "down" }, 5);
		expect(moved.state.listIndex).toBe(3);
	});

	it("up/down with empty list stays at 0", () => {
		const u = reduceBrowse(list, { kind: "up" }, 0);
		expect(u.state.listIndex).toBe(0);
		const d = reduceBrowse(list, { kind: "down" }, 0);
		expect(d.state.listIndex).toBe(0);
	});

	it("back (Esc) returns to the menu without closing", () => {
		const r = reduceBrowse(list, { kind: "back" }, 5);
		expect(r.state.screen).toBe("menu");
		expect(r.effect.kind).toBe("render");
	});

	it("close (Ctrl+C) exits from the list too", () => {
		const r = reduceBrowse(list, { kind: "close" }, 5);
		expect(r.effect.kind).toBe("close");
	});

	it("activate on a list row is a no-op for now (no per-row action defined)", () => {
		const r = reduceBrowse(list, { kind: "activate" }, 5);
		expect(r.state).toEqual(list);
		expect(r.effect.kind).toBe("render");
	});
});

describe("tildify", () => {
	it("replaces a home prefix with ~", () => {
		expect(tildify("/Users/me/.pi/agent/sandboxed-workflows", "/Users/me")).toBe(
			"~/.pi/agent/sandboxed-workflows",
		);
	});
	it("returns ~ for the bare home dir", () => {
		expect(tildify("/Users/me", "/Users/me")).toBe("~");
	});
	it("returns the input unchanged when the path is not under home", () => {
		expect(tildify("/etc/hosts", "/Users/me")).toBe("/etc/hosts");
	});
	it("does not match a partial-prefix collision (e.g. /Users/me-other)", () => {
		expect(tildify("/Users/me-other/foo", "/Users/me")).toBe("/Users/me-other/foo");
	});
});

describe("buildRowParts", () => {
	it("composes the cursor, name, basename, and tildified source dir", () => {
		const out = buildRowParts(
			{
				name: "implement",
				path: "/Users/me/.pi/agent/sandboxed-workflows/implement.ts",
				sourceDir: "/Users/me/.pi/agent/sandboxed-workflows",
			},
			true,
			"/Users/me",
		);
		expect(out.cursor).toBe("\u203a");
		expect(out.name).toBe("implement");
		expect(out.file).toBe("implement.ts");
		expect(out.source).toBe("~/.pi/agent/sandboxed-workflows");
	});
	it("uses a blank cursor when not selected", () => {
		const out = buildRowParts(
			{
				name: "x",
				path: "/abs/x.ts",
				sourceDir: "/abs",
			},
			false,
			"/Users/me",
		);
		expect(out.cursor).toBe(" ");
		expect(out.source).toBe("/abs");
	});
});
