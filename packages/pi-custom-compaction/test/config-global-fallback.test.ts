/**
 * config-global-fallback.test.ts
 *
 * Tests the GLOBAL_CONFIG_PATH fallback branch in readProjectPolicyPatch —
 * the branch that is reached when the project-level config does not exist
 * but a global config at homedir()/.pi/agent/compaction-policy.json does.
 *
 * We mock node:fs so we can control existsSync/readFileSync behaviour
 * without touching the real filesystem.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readProjectPolicyPatch } from "../src/policy/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const GLOBAL_PATH = join(homedir(), ".pi", "agent", "compaction-policy.json");

describe("readProjectPolicyPatch — global config fallback", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads global config when no project config exists", () => {
		// project config does NOT exist, global DOES exist
		mockExistsSync.mockImplementation((p) => p === GLOBAL_PATH);
		mockReadFileSync.mockReturnValue(JSON.stringify({ enabled: true }));

		const result = readProjectPolicyPatch("/fake/cwd");
		assert.deepEqual(result, { ok: true, value: { enabled: true } });
		// readFileSync must have been called with the global path
		expect(mockReadFileSync).toHaveBeenCalledWith(GLOBAL_PATH, "utf8");
	});

	it("project config takes precedence over global config", () => {
		// Both exist — project wins (global should never be touched)
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify({ enabled: true }));

		const result = readProjectPolicyPatch("/fake/cwd");
		assert.deepEqual(result, { ok: true, value: { enabled: true } });
		// Called exactly once for the project config
		expect(mockReadFileSync).toHaveBeenCalledOnce();
	});

	it("returns parse error when global config contains invalid JSON", () => {
		mockExistsSync.mockImplementation((p) => p === GLOBAL_PATH);
		mockReadFileSync.mockReturnValue("{ bad json");

		const result = readProjectPolicyPatch("/fake/cwd");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /Invalid .+compaction-policy\.json/);
		}
	});

	it("returns empty patch when neither project nor global config exists", () => {
		mockExistsSync.mockReturnValue(false);

		const result = readProjectPolicyPatch("/fake/cwd");
		assert.deepEqual(result, { ok: true, value: {} });
	});
});
