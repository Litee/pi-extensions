/**
 * Settings layering tests — project file overrides global; missing / malformed
 * files fall through to defaults; save() only writes the project file and
 * returns false on IO failure so the command handler can surface a toast.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, saveSettings } from "../src/settings.js";

const FILE = "schedule-prompts-settings.json";

let agentDir: string;
let cwd: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-prompt-scheduler-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "pi-prompt-scheduler-cwd-"));
	prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function writeGlobal(body: unknown): void {
	writeFileSync(join(agentDir, FILE), JSON.stringify(body), "utf-8");
}

function writeProject(body: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", FILE), JSON.stringify(body), "utf-8");
}

// ---------------------------------------------------------------------------
// loadSettings — layering + sanitization
// ---------------------------------------------------------------------------

describe("loadSettings", () => {
	it("returns an empty object when neither file exists", () => {
		expect(loadSettings(cwd)).toEqual({});
	});

	it("reads global settings when only the global file exists", () => {
		writeGlobal({ widgetVisible: false, defaultJobScope: "workdir" });
		expect(loadSettings(cwd)).toEqual({ widgetVisible: false, defaultJobScope: "workdir" });
	});

	it("reads project settings when only the project file exists", () => {
		writeProject({ widgetVisible: true, defaultJobScope: "session" });
		expect(loadSettings(cwd)).toEqual({ widgetVisible: true, defaultJobScope: "session" });
	});

	it("project file overrides matching keys in the global file (per-key merge)", () => {
		writeGlobal({ widgetVisible: false, defaultJobScope: "workdir" });
		writeProject({ widgetVisible: true });
		// `widgetVisible` from project wins; `defaultJobScope` from global shows through.
		expect(loadSettings(cwd)).toEqual({ widgetVisible: true, defaultJobScope: "workdir" });
	});

	it("sanitizes: non-boolean widgetVisible is dropped silently", () => {
		writeGlobal({ widgetVisible: "yes" });
		expect(loadSettings(cwd)).toEqual({});
	});

	it("sanitizes: defaultJobScope only accepts the two enum values", () => {
		writeGlobal({ defaultJobScope: "global" });
		expect(loadSettings(cwd)).toEqual({});
	});

	it("ignores unknown top-level keys (forward-compat for future knobs)", () => {
		writeProject({ widgetVisible: true, futureKnob: 42 });
		expect(loadSettings(cwd)).toEqual({ widgetVisible: true });
	});

	it("returns {} on malformed JSON (warns, doesn't throw)", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", FILE), "{ not json", "utf-8");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(loadSettings(cwd)).toEqual({});
		expect(warnSpy).toHaveBeenCalled();
	});

	it("returns {} when JSON is a non-object scalar", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", FILE), "42", "utf-8");
		expect(loadSettings(cwd)).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// saveSettings — project-file only, merges with existing project payload
// ---------------------------------------------------------------------------

describe("saveSettings", () => {
	it("writes a new project file with the partial change and returns true", () => {
		expect(saveSettings(cwd, { widgetVisible: false })).toBe(true);
		expect(JSON.parse(readFileSync(join(cwd, ".pi", FILE), "utf-8"))).toEqual({
			widgetVisible: false,
		});
	});

	it("merges into an existing project file without clobbering unrelated keys", () => {
		writeProject({ widgetVisible: false, defaultJobScope: "workdir" });
		saveSettings(cwd, { widgetVisible: true });
		expect(JSON.parse(readFileSync(join(cwd, ".pi", FILE), "utf-8"))).toEqual({
			widgetVisible: true,
			defaultJobScope: "workdir",
		});
	});

	it("does NOT touch the global file", () => {
		writeGlobal({ defaultJobScope: "workdir" });
		saveSettings(cwd, { widgetVisible: true });
		// Global file is unchanged.
		expect(JSON.parse(readFileSync(join(agentDir, FILE), "utf-8"))).toEqual({
			defaultJobScope: "workdir",
		});
	});

	it("auto-creates `.pi/` when missing", () => {
		expect(existsSync(join(cwd, ".pi"))).toBe(false);
		saveSettings(cwd, { widgetVisible: true });
		expect(existsSync(join(cwd, ".pi", FILE))).toBe(true);
	});

	it("returns false when the write fails (caller uses this to surface a toast)", () => {
		// Point cwd at a path whose parent directory doesn't exist AND can't
		// be created — the easiest cross-platform way is to make a file at
		// the spot we'd want to mkdir.
		const blockedCwd = mkdtempSync(join(tmpdir(), "pi-prompt-scheduler-blocked-"));
		writeFileSync(join(blockedCwd, ".pi"), "not a dir", "utf-8");
		try {
			expect(saveSettings(blockedCwd, { widgetVisible: true })).toBe(false);
		} finally {
			rmSync(blockedCwd, { recursive: true, force: true });
		}
	});

	it("round-trips through loadSettings", () => {
		saveSettings(cwd, { widgetVisible: false, defaultJobScope: "workdir" });
		expect(loadSettings(cwd)).toEqual({ widgetVisible: false, defaultJobScope: "workdir" });
	});
});
