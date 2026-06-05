/**
 * Tests for the new runs/run-detail screens added to browseTui.ts.
 * Kept separate from the existing browseTui.test.ts to avoid churn on
 * passing tests.
 */
import { describe, expect, it } from "vitest";

import {
	dispatchBrowseKey,
	initialBrowseState,
	reduceBrowse,
	type BrowseState,
} from "../src/browseTui.js";

// Same key-matching stub as browseTui.test.ts.
const matchesKey = (data: string, key: string): boolean => data === key;

const listScreen: BrowseState = {
	screen: "list",
	menuIndex: 0,
	listIndex: 1,
	runsIndex: 0,
	runDetailIndex: 0,
};

const runsScreen: BrowseState = {
	screen: "runs",
	menuIndex: 0,
	listIndex: 1,
	runsIndex: 2,
	runDetailIndex: 0,
};

const runDetailScreen: BrowseState = {
	screen: "run-detail",
	menuIndex: 0,
	listIndex: 1,
	runsIndex: 2,
	runDetailIndex: 0,
};

// ── dispatchBrowseKey ─────────────────────────────────────────────────────────

describe("dispatchBrowseKey — runs key", () => {
	it("maps 'r' to { kind: 'runs' }", () => {
		expect(dispatchBrowseKey("r", matchesKey)).toEqual({ kind: "runs" });
	});
});

// ── initialBrowseState ────────────────────────────────────────────────────────

describe("initialBrowseState — new fields", () => {
	it("has runsIndex defaulting to 0", () => {
		expect(initialBrowseState.runsIndex).toBe(0);
	});

	it("has runDetailIndex defaulting to 0", () => {
		expect(initialBrowseState.runDetailIndex).toBe(0);
	});
});

// ── list screen + 'r' key ─────────────────────────────────────────────────────

describe("reduceBrowse — list screen with 'r' key", () => {
	it("navigates to runs screen when 'runs' action fired from list", () => {
		const step = reduceBrowse(listScreen, { kind: "runs" }, 3, 5);
		expect(step.state.screen).toBe("runs");
		expect(step.state.runsIndex).toBe(0);
		expect(step.effect.kind).toBe("render");
	});

	it("ignores 'runs' action from menu screen (stays on menu)", () => {
		const menu = { ...initialBrowseState, screen: "menu" as const };
		const step = reduceBrowse(menu, { kind: "runs" }, 3, 5);
		expect(step.state.screen).toBe("menu");
		expect(step.effect.kind).toBe("render");
	});
});

// ── runs screen ───────────────────────────────────────────────────────────────

describe("reduceBrowse — runs screen", () => {
	it("up clamps at 0", () => {
		const step = reduceBrowse({ ...runsScreen, runsIndex: 0 }, { kind: "up" }, 3, 5);
		expect(step.state.runsIndex).toBe(0);
	});

	it("up decrements runsIndex", () => {
		const step = reduceBrowse(runsScreen, { kind: "up" }, 3, 5);
		expect(step.state.runsIndex).toBe(1);
	});

	it("down increments runsIndex", () => {
		const step = reduceBrowse({ ...runsScreen, runsIndex: 2 }, { kind: "down" }, 3, 5);
		expect(step.state.runsIndex).toBe(3);
	});

	it("down clamps at runsLength - 1", () => {
		const step = reduceBrowse({ ...runsScreen, runsIndex: 4 }, { kind: "down" }, 3, 5);
		expect(step.state.runsIndex).toBe(4);
	});

	it("up/down with empty runs list stays at 0", () => {
		const u = reduceBrowse({ ...runsScreen, runsIndex: 0 }, { kind: "up" }, 3, 0);
		expect(u.state.runsIndex).toBe(0);
		const d = reduceBrowse({ ...runsScreen, runsIndex: 0 }, { kind: "down" }, 3, 0);
		expect(d.state.runsIndex).toBe(0);
	});

	it("back returns to list screen", () => {
		const step = reduceBrowse(runsScreen, { kind: "back" }, 3, 5);
		expect(step.state.screen).toBe("list");
		expect(step.effect.kind).toBe("render");
	});

	it("close exits", () => {
		const step = reduceBrowse(runsScreen, { kind: "close" }, 3, 5);
		expect(step.effect.kind).toBe("close");
	});

	it("activate transitions to run-detail screen and resets runDetailIndex", () => {
		const step = reduceBrowse(
			{ ...runsScreen, runDetailIndex: 99 },
			{ kind: "activate" },
			3,
			5,
		);
		expect(step.state.screen).toBe("run-detail");
		expect(step.state.runDetailIndex).toBe(0);
		expect(step.effect.kind).toBe("render");
	});
});

// ── run-detail screen ─────────────────────────────────────────────────────────

describe("reduceBrowse — run-detail screen", () => {
	it("back returns to runs screen", () => {
		const step = reduceBrowse(runDetailScreen, { kind: "back" }, 3, 5);
		expect(step.state.screen).toBe("runs");
		expect(step.effect.kind).toBe("render");
	});

	it("close exits", () => {
		const step = reduceBrowse(runDetailScreen, { kind: "close" }, 3, 5);
		expect(step.effect.kind).toBe("close");
	});

	it("up decrements runDetailIndex", () => {
		const step = reduceBrowse(
			{ ...runDetailScreen, runDetailIndex: 3 },
			{ kind: "up" },
			3,
			5,
		);
		expect(step.state.runDetailIndex).toBe(2);
	});

	it("down increments runDetailIndex", () => {
		const step = reduceBrowse(runDetailScreen, { kind: "down" }, 3, 5);
		expect(step.state.runDetailIndex).toBe(1);
	});

	it("runDetailIndex clamps at 0 on up when already at 0", () => {
		const step = reduceBrowse(runDetailScreen, { kind: "up" }, 3, 5);
		expect(step.state.runDetailIndex).toBe(0);
	});
});

// ── Regression: r key on runs/run-detail screens ─────────────────────────────
// Bug 9: r was a no-op on runs and run-detail screens because those screens
// had no dedicated renderers — they fell through to renderList. The fix adds
// renderRuns/renderRunDetail to index.ts; the reducer behaviour (render, no
// state change) was already correct.

describe("reduceBrowse — 'r' key on runs screen (regression: Bug 9)", () => {
	it("stays on runs screen and returns render effect", () => {
		const step = reduceBrowse(runsScreen, { kind: "runs" }, 3, 5);
		expect(step.state.screen).toBe("runs");
		expect(step.effect.kind).toBe("render");
	});

	it("does not change runsIndex", () => {
		const step = reduceBrowse(runsScreen, { kind: "runs" }, 3, 5);
		expect(step.state.runsIndex).toBe(runsScreen.runsIndex);
	});
});

describe("reduceBrowse — 'r' key on run-detail screen (regression: Bug 9)", () => {
	it("stays on run-detail screen and returns render effect", () => {
		const step = reduceBrowse(runDetailScreen, { kind: "runs" }, 3, 5);
		expect(step.state.screen).toBe("run-detail");
		expect(step.effect.kind).toBe("render");
	});

	it("does not change runDetailIndex", () => {
		const step = reduceBrowse(runDetailScreen, { kind: "runs" }, 3, 5);
		expect(step.state.runDetailIndex).toBe(runDetailScreen.runDetailIndex);
	});
});
