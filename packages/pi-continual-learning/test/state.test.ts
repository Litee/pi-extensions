/**
 * Tests for state.ts: loadState defaults, round-trip save/load, and error swallowing.
 *
 * Strategy: override process.env.HOME to an os.tmpdir() sub-directory so the
 * tests never touch the real ~/.pi/agent directory. Clean up in afterEach.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadState, saveState, statePath, type PersistedState } from "../src/state.js";

// ---------------------------------------------------------------------------
// Temp-home isolation
// ---------------------------------------------------------------------------

const TMP_HOME = join(tmpdir(), `pi-cl-state-test-${process.pid}`);
let savedHome: string | undefined;

beforeEach(() => {
	savedHome = process.env["HOME"];
	mkdirSync(TMP_HOME, { recursive: true });
	process.env["HOME"] = TMP_HOME;
});

afterEach(() => {
	rmSync(TMP_HOME, { recursive: true, force: true });
	if (savedHome !== undefined) {
		process.env["HOME"] = savedHome;
	} else {
		delete process.env["HOME"];
	}
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// loadState — defaults
// ---------------------------------------------------------------------------

describe("loadState", () => {
	it("returns sane defaults when the file does not exist", () => {
		const state = loadState();
		expect(state.lastRunAt).toBeNull();
		expect(state.turnsSinceLastRun).toBe(0);
		expect(state.processedMarker).toBeNull();
		expect(state.trialStartedAt).toBeNull();
	});

	it("returns sane defaults when the file contains garbage JSON", () => {
		const dir = join(TMP_HOME, ".pi", "agent");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pi-continual-learning.json"), "not valid json {{");
		const state = loadState();
		expect(state.turnsSinceLastRun).toBe(0);
		expect(state.lastRunAt).toBeNull();
	});

	it("returns sane defaults when the file contains an empty object", () => {
		const dir = join(TMP_HOME, ".pi", "agent");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pi-continual-learning.json"), "{}");
		const state = loadState();
		expect(state.turnsSinceLastRun).toBe(0);
		expect(state.lastRunAt).toBeNull();
		expect(state.processedMarker).toBeNull();
		expect(state.trialStartedAt).toBeNull();
	});

	it("preserves turnsSinceLastRun = 0 (not treated as missing)", () => {
		const dir = join(TMP_HOME, ".pi", "agent");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "pi-continual-learning.json"),
			JSON.stringify({ turnsSinceLastRun: 0, lastRunAt: 12345 }),
		);
		const state = loadState();
		expect(state.turnsSinceLastRun).toBe(0);
		expect(state.lastRunAt).toBe(12345);
	});
});

// ---------------------------------------------------------------------------
// saveState + loadState — round-trip
// ---------------------------------------------------------------------------

describe("saveState / loadState round-trip", () => {
	it("persists and restores the full state object", () => {
		const toSave: PersistedState = {
			lastRunAt: 1_700_000_000_000,
			turnsSinceLastRun: 7,
			processedMarker: "sess-abc:leaf-xyz",
			trialStartedAt: 1_699_000_000_000,
		};
		saveState(toSave);
		expect(loadState()).toEqual(toSave);
	});

	it("overwrites a previous save correctly", () => {
		saveState({
			lastRunAt: 100,
			turnsSinceLastRun: 3,
			processedMarker: "a:b",
			trialStartedAt: null,
		});
		saveState({
			lastRunAt: 200,
			turnsSinceLastRun: 0,
			processedMarker: "c:d",
			trialStartedAt: 999,
		});
		const state = loadState();
		expect(state.lastRunAt).toBe(200);
		expect(state.processedMarker).toBe("c:d");
		expect(state.trialStartedAt).toBe(999);
	});

	it("creates the directory hierarchy automatically if absent", () => {
		// TMP_HOME exists but .pi/agent sub-dirs do not
		saveState({
			lastRunAt: 42,
			turnsSinceLastRun: 1,
			processedMarker: null,
			trialStartedAt: null,
		});
		expect(loadState().lastRunAt).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// saveState — error swallowing
// ---------------------------------------------------------------------------

describe("saveState — error swallowing", () => {
	it("does not throw when writeFileSync fails (target path is a directory)", () => {
		// Create the state file path as a *directory* so writeFileSync fails with EISDIR
		const dir = join(TMP_HOME, ".pi", "agent");
		mkdirSync(dir, { recursive: true });
		// Make the json file path a directory instead of a file
		mkdirSync(join(dir, "pi-continual-learning.json"), { recursive: true });
		expect(() => {
			saveState({
				lastRunAt: null,
				turnsSinceLastRun: 0,
				processedMarker: null,
				trialStartedAt: null,
			});
		}).not.toThrow();
	});

	it("does not throw when mkdirSync fails (parent is a file, not a directory)", () => {
		// Place a *file* where the agent directory should be so mkdirSync fails
		mkdirSync(join(TMP_HOME, ".pi"), { recursive: true });
		writeFileSync(join(TMP_HOME, ".pi", "agent"), "I am a file");
		expect(() => {
			saveState({
				lastRunAt: null,
				turnsSinceLastRun: 0,
				processedMarker: null,
				trialStartedAt: null,
			});
		}).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// statePath
// ---------------------------------------------------------------------------

describe("statePath", () => {
	it("returns a path under HOME/.pi/agent/", () => {
		const p = statePath();
		expect(p).toContain(".pi");
		expect(p).toContain("agent");
		expect(p).toContain("pi-continual-learning.json");
		expect(p.startsWith(TMP_HOME)).toBe(true);
	});

	it("falls back to USERPROFILE when HOME is not set", () => {
		delete process.env["HOME"];
		process.env["USERPROFILE"] = TMP_HOME;
		try {
			const p = statePath();
			expect(p.startsWith(TMP_HOME)).toBe(true);
		} finally {
			delete process.env["USERPROFILE"];
			// HOME will be restored by afterEach
		}
	});

	it("falls back to empty string when neither HOME nor USERPROFILE is set", () => {
		delete process.env["HOME"];
		delete process.env["USERPROFILE"];
		try {
			const p = statePath();
			// Path starts from relative root — just check the filename is present
			expect(p).toContain("pi-continual-learning.json");
		} finally {
			// HOME will be restored by afterEach
		}
	});
});
