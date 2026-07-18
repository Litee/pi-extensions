/**
 * Tests for the extension's user-level config file (tracker issues
 * #0005 + #0006).
 *
 * New canonical location: `<agentDir>/pi-session-recap.json` (flat, NOT
 * under `extensions-data/`). The `$PI_SESSION_RECAP_CONFIG` env var, when
 * set to a non-empty string, replaces the default path outright.
 *
 * Covers the test matrix spelled out in the tracker:
 *   - Reader happy-path / absent / missing key / bad type / whitespace /
 *     malformed JSON.
 *   - Env override resolution + write/read roundtrip against it.
 *   - Migration leg 1: extensions-data/ legacy file.
 *   - Migration leg 2: settings.json → sessionRecap.model.
 *   - Both-legacy precedence (extensions-data/ wins; settings.json left
 *     alone and NOT consumed).
 *   - New-path-wins when new + any legacy coexist.
 *   - Atomic-write semantics: rename failure does not corrupt an existing
 *     file; temp file is cleaned up.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock('node:fs', …)` hoists above imports. We route `renameSync` through
// a test-controlled trampoline so individual tests can stub it to simulate
// rename failure / EXDEV without resorting to filesystem trickery. When the
// trampoline's `fn` is null the real `renameSync` runs unchanged — this is
// the default for every other test in the file.
const renameStub = vi.hoisted(
	() => ({ fn: null as ((from: string, to: string) => void) | null }),
);
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		renameSync: (from: string, to: string) => {
			if (renameStub.fn) return renameStub.fn(from, to);
			return actual.renameSync(from, to);
		},
	};
});

import {
	CONFIG_FILENAME,
	defaultConfigFile,
	migrateLegacyConfig,
	readUserRecapConfig,
	readUserRecapModel,
	writeUserRecapConfig,
} from "../src/settings.js";

// ---------------------------------------------------------------------------
// Shared per-test temp-dir fixture.
// ---------------------------------------------------------------------------

let agentDir: string;
let prevAgentDir: string | undefined;
let prevConfigOverride: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-session-recap-cfg-"));
	prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
	prevConfigOverride = process.env["PI_SESSION_RECAP_CONFIG"];
	// Route the back-compat `readUserRecapModel(agentDir?)` wrapper through
	// the same temp dir so neither the user's real `~/.pi/agent/` nor a
	// stray `PI_SESSION_RECAP_CONFIG` can leak into the test.
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	delete process.env["PI_SESSION_RECAP_CONFIG"];
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
	if (prevConfigOverride === undefined) delete process.env["PI_SESSION_RECAP_CONFIG"];
	else process.env["PI_SESSION_RECAP_CONFIG"] = prevConfigOverride;
	rmSync(agentDir, { recursive: true, force: true });
	vi.restoreAllMocks();
	renameStub.fn = null;
});

function newPath(): string {
	return join(agentDir, CONFIG_FILENAME);
}

function legacyExtDataPath(): string {
	return join(agentDir, "extensions-data", CONFIG_FILENAME);
}

function settingsJsonPath(): string {
	return join(agentDir, "settings.json");
}

function writeJson(file: string, body: unknown): void {
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dirnameOf(file), { recursive: true });
	writeFileSync(file, JSON.stringify(body), "utf8");
}

function dirnameOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "." : p.slice(0, i);
}

// ---------------------------------------------------------------------------
// defaultConfigFile — path resolution
// ---------------------------------------------------------------------------

describe("defaultConfigFile", () => {
	it("returns `<agentDir>/pi-session-recap.json` (flat, NOT extensions-data/) when the env override is unset", () => {
		expect(defaultConfigFile({}, agentDir)).toBe(join(agentDir, "pi-session-recap.json"));
	});

	it("honours $PI_SESSION_RECAP_CONFIG when set to a non-empty string, verbatim", () => {
		const abs = "/tmp/custom-pi-session-recap.json";
		expect(defaultConfigFile({ PI_SESSION_RECAP_CONFIG: abs }, agentDir)).toBe(abs);
	});

	it("ignores an empty / whitespace-only $PI_SESSION_RECAP_CONFIG", () => {
		expect(defaultConfigFile({ PI_SESSION_RECAP_CONFIG: "" }, agentDir)).toBe(newPath());
		expect(defaultConfigFile({ PI_SESSION_RECAP_CONFIG: "   " }, agentDir)).toBe(newPath());
	});
});

// ---------------------------------------------------------------------------
// readUserRecapConfig / readUserRecapModel — parse + validation
// ---------------------------------------------------------------------------

describe("readUserRecapConfig / readUserRecapModel", () => {
	it("returns the trimmed model when the new file has a valid model string", () => {
		writeJson(newPath(), { model: "  anthropic/claude-haiku-4-5  " });
		expect(readUserRecapConfig(newPath())).toEqual({ model: "anthropic/claude-haiku-4-5" });
		expect(readUserRecapModel(agentDir)).toBe("anthropic/claude-haiku-4-5");
	});

	it("returns undefined when the new file is absent", () => {
		expect(readUserRecapConfig(newPath())).toBeUndefined();
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("strips `model` when the key is absent (file exists, but no model) — readUserRecapModel undefined", () => {
		writeJson(newPath(), { otherKey: "ignored" });
		expect(readUserRecapConfig(newPath())).toEqual({});
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("strips `model` silently when it is not a string", () => {
		writeJson(newPath(), { model: 42 });
		expect(readUserRecapConfig(newPath())).toEqual({});
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("strips `model` silently when it is whitespace-only", () => {
		writeJson(newPath(), { model: "   " });
		expect(readUserRecapConfig(newPath())).toEqual({});
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("returns undefined on malformed JSON", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(newPath(), "{ not json", "utf8");
		expect(readUserRecapConfig(newPath())).toBeUndefined();
		expect(readUserRecapModel(agentDir)).toBeUndefined();
	});

	it("returns undefined when the top-level JSON is an array (not an object)", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(newPath(), JSON.stringify(["anthropic/claude-haiku-4-5"]), "utf8");
		expect(readUserRecapConfig(newPath())).toBeUndefined();
	});

	it("ignores unknown top-level keys so new config fields can be added without breaking older clients", () => {
		writeJson(newPath(), {
			model: "anthropic/claude-haiku-4-5",
			idleSeconds: 60,
			futureKnob: true,
		});
		expect(readUserRecapConfig(newPath())).toEqual({ model: "anthropic/claude-haiku-4-5" });
	});
});

// ---------------------------------------------------------------------------
// writeUserRecapConfig — atomic semantics
// ---------------------------------------------------------------------------

describe("writeUserRecapConfig", () => {
	it("creates the parent directory and writes the config as JSON with a trailing newline", () => {
		const nested = join(agentDir, "nested", "dir", "file.json");
		writeUserRecapConfig(nested, { model: "anthropic/claude-haiku-4-5" });
		const body = readFileSync(nested, "utf8");
		expect(body.endsWith("\n")).toBe(true);
		expect(JSON.parse(body)).toEqual({ model: "anthropic/claude-haiku-4-5" });
	});

	it("write/read roundtrip through $PI_SESSION_RECAP_CONFIG uses the override path exclusively (the default flat path is NOT touched)", () => {
		const absPath = join(agentDir, "custom", "my-recap.json");
		const env = { PI_SESSION_RECAP_CONFIG: absPath };
		writeUserRecapConfig(defaultConfigFile(env, agentDir), { model: "anthropic/claude-haiku-4-5" });
		expect(readUserRecapConfig(defaultConfigFile(env, agentDir))?.model).toBe(
			"anthropic/claude-haiku-4-5",
		);
		expect(existsSync(newPath())).toBe(false);
	});

	it("rename failure does not corrupt an existing file and does not leave a temp file behind", () => {
		// Seed the target with a known-good value.
		writeUserRecapConfig(newPath(), { model: "anthropic/claude-haiku-4-5" });
		const before = readFileSync(newPath(), "utf8");

		// Stub renameSync to fail so the write path has to bail after the
		// temp file is written but before it commits.
		renameStub.fn = () => {
			throw Object.assign(new Error("simulated rename failure"), { code: "EPERM" });
		};

		expect(() => writeUserRecapConfig(newPath(), { model: "other/new" })).toThrow();

		// Existing file is untouched — this is the whole point of the
		// temp-file + rename dance.
		expect(readFileSync(newPath(), "utf8")).toBe(before);

		// And no leftover `*.tmp-*` dropping in the parent directory.
		const leftovers = readdirSync(agentDir).filter((name) => name.includes(".tmp-"));
		expect(leftovers).toEqual([]);
	});

	it("falls back to copy-then-delete when rename yields EXDEV (temp and target on different filesystems)", () => {
		// Simulate EXDEV exactly once — the fallback then uses copyFileSync +
		// unlinkSync to commit. We let the real rename run thereafter so the
		// broader test fixture (mkdtempSync cleanup, etc.) stays consistent.
		let thrown = false;
		renameStub.fn = (from, to) => {
			if (!thrown) {
				thrown = true;
				throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
			}
			renameSync(from, to);
		};

		writeUserRecapConfig(newPath(), { model: "anthropic/claude-haiku-4-5" });
		expect(readUserRecapConfig(newPath())?.model).toBe("anthropic/claude-haiku-4-5");

		// Temp file cleaned up after the copy.
		const leftovers = readdirSync(agentDir).filter((name) => name.includes(".tmp-"));
		expect(leftovers).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// migrateLegacyConfig — the two-leg migration chain
// ---------------------------------------------------------------------------

describe("migrateLegacyConfig", () => {
	it("does nothing and reports `migrated: false` when the new flat path already exists", () => {
		writeJson(newPath(), { model: "keep/me" });
		const before = readFileSync(newPath(), "utf8");
		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: false });
		expect(readFileSync(newPath(), "utf8")).toBe(before);
	});

	it("leg 1: moves `<agentDir>/extensions-data/pi-session-recap.json` to the flat path when the new path is absent", () => {
		const legacyBody = { model: "anthropic/claude-haiku-4-5" };
		writeJson(legacyExtDataPath(), legacyBody);

		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: true });

		// Legacy file has been renamed away; new flat file holds the contents.
		expect(existsSync(legacyExtDataPath())).toBe(false);
		expect(readUserRecapConfig(newPath())).toEqual({ model: "anthropic/claude-haiku-4-5" });
	});

	it("leg 1 wins over leg 2: when BOTH legacy sources exist (extensions-data/ file AND settings.json key), extensions-data/ is moved and settings.json is left untouched", () => {
		writeJson(legacyExtDataPath(), { model: "extdata/win" });
		writeJson(settingsJsonPath(), { sessionRecap: { model: "settings/should-not-be-read" } });

		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: true });

		expect(readUserRecapConfig(newPath())).toEqual({ model: "extdata/win" });
		expect(existsSync(legacyExtDataPath())).toBe(false);
		// Critical: the settings.json payload is NOT consumed or modified.
		// User may have been mid-upgrade; defensively leave their pi config
		// alone.
		expect(JSON.parse(readFileSync(settingsJsonPath(), "utf8"))).toEqual({
			sessionRecap: { model: "settings/should-not-be-read" },
		});
	});

	it("leg 2: writes the new flat file from settings.json when new path and extensions-data/ both absent; settings.json itself is not modified", () => {
		writeJson(settingsJsonPath(), {
			defaultModel: "openai/gpt-5",
			sessionRecap: { model: "anthropic/claude-haiku-4-5" },
			theme: "dark",
		});
		const settingsBefore = readFileSync(settingsJsonPath(), "utf8");

		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: true });

		expect(readUserRecapConfig(newPath())).toEqual({ model: "anthropic/claude-haiku-4-5" });
		// Legacy key stays put; the extension just stops reading it.
		expect(readFileSync(settingsJsonPath(), "utf8")).toBe(settingsBefore);
	});

	it("leg 2: no new file created when neither legacy source is present", () => {
		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: false });
		expect(existsSync(newPath())).toBe(false);
	});

	it("leg 2: ignores settings.json when sessionRecap.model is whitespace-only", () => {
		writeJson(settingsJsonPath(), { sessionRecap: { model: "   " } });
		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: false });
		expect(existsSync(newPath())).toBe(false);
	});

	it("new-wins: when the new flat path AND the legacy extensions-data/ file both exist, both are left untouched (new wins, legacy ignored)", () => {
		writeJson(newPath(), { model: "new/wins" });
		writeJson(legacyExtDataPath(), { model: "legacy/ignored" });
		const legacyBefore = readFileSync(legacyExtDataPath(), "utf8");

		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: false });

		expect(readUserRecapConfig(newPath())).toEqual({ model: "new/wins" });
		// Legacy file is deliberately NOT deleted — user may have edited it.
		expect(readFileSync(legacyExtDataPath(), "utf8")).toBe(legacyBefore);
	});

	it("swallows I/O errors on write (e.g. rename fails) and leaves readUserRecapConfig returning undefined", () => {
		writeJson(settingsJsonPath(), { sessionRecap: { model: "anthropic/claude-haiku-4-5" } });

		// Force writeUserRecapConfig's rename to fail. migrateLegacyConfig
		// catches this silently — the feature is best-effort.
		renameStub.fn = () => {
			throw Object.assign(new Error("simulated rename failure"), { code: "EPERM" });
		};

		expect(() => migrateLegacyConfig(agentDir, {})).not.toThrow();
		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: false });

		// New file does not exist / cannot be read — reader returns undefined.
		expect(readUserRecapConfig(newPath())).toBeUndefined();
	});

	it("honours $PI_SESSION_RECAP_CONFIG: when the override path is absent, legacy settings.json is migrated to the override path and the default flat path stays empty", () => {
		const absPath = join(agentDir, "overridden", "recap.json");
		writeJson(settingsJsonPath(), { sessionRecap: { model: "anthropic/claude-haiku-4-5" } });

		expect(migrateLegacyConfig(agentDir, { PI_SESSION_RECAP_CONFIG: absPath })).toEqual({
			migrated: true,
		});

		expect(readUserRecapConfig(absPath)).toEqual({ model: "anthropic/claude-haiku-4-5" });
		expect(existsSync(newPath())).toBe(false);
	});
});

// Kept out of a describe so it's obvious at-a-glance this is the one case
// that still exercises `renameSync` WITHOUT mocking — defensive belt-and-
// braces to make sure the real fs path works end to end.
it("end-to-end: write → read roundtrip through the real fs", () => {
	writeUserRecapConfig(newPath(), { model: "anthropic/claude-haiku-4-5" });
	renameSync(newPath(), newPath()); // no-op rename; asserts path resolves
	expect(readUserRecapConfig(newPath())?.model).toBe("anthropic/claude-haiku-4-5");
});

// ---------------------------------------------------------------------------
// Additional coverage: readLegacySettingsJsonModel invalid JSON + leg-1 EXDEV
// ---------------------------------------------------------------------------

describe("migrateLegacyConfig — additional edge cases", () => {
	it("leg 2: treats malformed JSON in settings.json as 'no model' (returns {migrated:false})", () => {
		// readLegacySettingsJsonModel must return undefined on JSON.parse failure.
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsJsonPath(), "{ not valid json ", "utf8");
		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: false });
		expect(existsSync(newPath())).toBe(false);
	});

	it("leg 1 EXDEV: falls back to copy-then-delete when migration rename throws EXDEV", () => {
		writeJson(legacyExtDataPath(), { model: "anthropic/claude-haiku-4-5" });

		// Throw EXDEV on the rename; migrateLegacyConfig leg 1 then falls back to
		// copyFileSync + unlinkSync (no second renameSync call from leg 1).
		renameStub.fn = (_from: string, _to: string) => {
			throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
		};

		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: true });
		expect(existsSync(legacyExtDataPath())).toBe(false);
		expect(readUserRecapConfig(newPath())).toEqual({ model: "anthropic/claude-haiku-4-5" });
	});

	it("leg 1: I/O error other than EXDEV in rename causes outer catch to return {migrated:false}", () => {
		writeJson(legacyExtDataPath(), { model: "anthropic/claude-haiku-4-5" });

		// A non-EXDEV error is re-thrown from the inner catch to the outer catch.
		renameStub.fn = () => {
			throw Object.assign(new Error("permission denied"), { code: "EPERM" });
		};

		expect(() => migrateLegacyConfig(agentDir, {})).not.toThrow();
		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: false });
		expect(existsSync(newPath())).toBe(false);
	});

	it("outer catch (line 230) fires when existsSync throws on the new path check", () => {
		// Mock existsSync to throw on the first call (checking newPath).
		// This bypasses all inner try-catch blocks and hits the outer catch.
		const existsSyncSpy = vi.spyOn(nodeFs, "existsSync");
		existsSyncSpy.mockImplementationOnce(() => {
			throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
		});

		expect(() => migrateLegacyConfig(agentDir, {})).not.toThrow();
		expect(migrateLegacyConfig(agentDir, {})).toEqual({ migrated: false });
	});
});
