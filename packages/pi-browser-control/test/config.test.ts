/**
 * Tests for src/config.ts (slimmed — no secret/port/DEFAULT_PORT/saveConfig).
 *
 * Env isolation: tempDir is passed explicitly to configFilePath/loadConfig.
 * No global env mutation.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-bc-cfg-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

import { configFilePath, loadConfig } from "../src/config.js";

describe("configFilePath", () => {
	it("returns <agentDir>/pi-browser-control.json", () => {
		expect(configFilePath(tempDir)).toBe(join(tempDir, "pi-browser-control.json"));
	});

	it("returns a valid path when called without agentDir (covers ?? getAgentDir() branch)", () => {
		// No agentDir → exercises the ?? getAgentDir() null branch
		const p = configFilePath();
		expect(p.endsWith("pi-browser-control.json")).toBe(true);
	});
});

describe("loadConfig", () => {
	it("returns {} when the config file is missing", () => {
		expect(loadConfig(tempDir)).toEqual({});
	});

	it("returns {} when the file contains invalid JSON", () => {
		writeFileSync(configFilePath(tempDir), "not json", "utf-8");
		expect(loadConfig(tempDir)).toEqual({});
	});
});

describe("BrowserControlConfig shape", () => {
	it("is an empty interface (no secret/port fields)", () => {
		// The config object returned has no mandatory keys
		const cfg = loadConfig(tempDir);
		expect(Object.keys(cfg)).toHaveLength(0);
	});
});

describe("loadConfig — valid JSON object", () => {
	it("returns {} when the file contains a valid JSON object", () => {
		writeFileSync(configFilePath(tempDir), '{"future":"field"}', "utf-8");
		expect(loadConfig(tempDir)).toEqual({});
	});
});

describe("loadConfig — non-object JSON returns {}", () => {
	it("returns {} when file contains a JSON array", () => {
		writeFileSync(configFilePath(tempDir), "[]", "utf-8");
		expect(loadConfig(tempDir)).toEqual({});
	});

	it("returns {} when file contains a JSON null", () => {
		writeFileSync(configFilePath(tempDir), "null", "utf-8");
		expect(loadConfig(tempDir)).toEqual({});
	});

	it("returns {} when file contains a JSON number", () => {
		writeFileSync(configFilePath(tempDir), "42", "utf-8");
		expect(loadConfig(tempDir)).toEqual({});
	});
});
