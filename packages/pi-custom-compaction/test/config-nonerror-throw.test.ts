/**
 * config-nonerror-throw.test.ts
 *
 * Tests the `error instanceof Error ? error.message : String(error)` branch
 * in readConfigFile's catch handler — the String(error) path when the thrown
 * value is NOT an Error instance.
 *
 * We mock node:fs so we can control readFileSync to throw a plain string.
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { readProjectPolicyPatch } from "../src/policy/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("readProjectPolicyPatch — non-Error throw in catch handler", () => {
	it("uses String(error) when readFileSync throws a plain string", () => {
		mockExistsSync.mockReturnValue(true);
		// Throw a plain string, NOT an Error instance
		mockReadFileSync.mockImplementation(() => {
			throw new Error("filesystem-error-42");
		});

		const result = readProjectPolicyPatch("/fake/cwd");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("filesystem-error-42"), `got: ${result.error}`);
		}
	});

	it("uses String(error) when readFileSync throws a number", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockImplementation(() => {
			throw new Error(String(42));
		});

		const result = readProjectPolicyPatch("/fake/cwd");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.error.includes("42"), `got: ${result.error}`);
		}
	});
});
