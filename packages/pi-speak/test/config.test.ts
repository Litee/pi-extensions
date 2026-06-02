import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the fs module before importing config
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	readdirSync: vi.fn(),
	statSync: vi.fn(),
}));

// Mock os module
vi.mock("node:os", () => ({
	homedir: () => "/home/testuser",
}));

// Mock getAgentDir
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/fake",
}));

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assetsReady, configFilePath, discoverAssetsDir, findHfCachedModel, loadConfig, resolveExplicitAssetsDir } from "../src/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync as unknown as (path: string) => string[]);
const mockStatSync = vi.mocked(statSync as unknown as (path: string) => { mtimeMs: number });

describe("configFilePath", () => {
	it("returns path inside agent dir", () => {
		expect(configFilePath()).toBe("/fake/pi-speak.json");
	});
});

describe("loadConfig", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("returns {} when file does not exist", () => {
		mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
		expect(loadConfig()).toEqual({});
	});

	it("returns {} for invalid JSON", () => {
		mockReadFileSync.mockReturnValue("not json");
		expect(loadConfig()).toEqual({});
	});

	it("returns {} when root is not an object", () => {
		mockReadFileSync.mockReturnValue("[1,2,3]");
		expect(loadConfig()).toEqual({});
	});

	it("returns {} when root is null", () => {
		mockReadFileSync.mockReturnValue("null");
		expect(loadConfig()).toEqual({});
	});

	it("picks up assetsDir when valid string", () => {
		mockReadFileSync.mockReturnValue(JSON.stringify({ assetsDir: "/my/assets" }));
		expect(loadConfig()).toEqual({ assetsDir: "/my/assets" });
	});

	it("drops assetsDir when wrong type", () => {
		mockReadFileSync.mockReturnValue(JSON.stringify({ assetsDir: 42 }));
		expect(loadConfig()).toEqual({});
	});
});

describe("resolveExplicitAssetsDir", () => {
	const origEnv = process.env["PI_SPEAK_ASSETS_DIR"];

	afterEach(() => {
		if (origEnv === undefined) delete process.env["PI_SPEAK_ASSETS_DIR"];
		else process.env["PI_SPEAK_ASSETS_DIR"] = origEnv;
	});

	it("env var wins over config", () => {
		process.env["PI_SPEAK_ASSETS_DIR"] = "/env/assets";
		expect(resolveExplicitAssetsDir({ assetsDir: "/cfg/assets" })).toBe("/env/assets");
	});

	it("config returned when no env var", () => {
		delete process.env["PI_SPEAK_ASSETS_DIR"];
		expect(resolveExplicitAssetsDir({ assetsDir: "/cfg/assets" })).toBe("/cfg/assets");
	});

	it("returns undefined when no env var or config", () => {
		delete process.env["PI_SPEAK_ASSETS_DIR"];
		expect(resolveExplicitAssetsDir({})).toBeUndefined();
	});

	it("ignores blank env var", () => {
		process.env["PI_SPEAK_ASSETS_DIR"] = "   ";
		expect(resolveExplicitAssetsDir({ assetsDir: "/cfg/assets" })).toBe("/cfg/assets");
	});
});

describe("findHfCachedModel", () => {
	const origHfHome = process.env["HF_HOME"];
	const origHfHubCache = process.env["HUGGINGFACE_HUB_CACHE"];

	beforeEach(() => {
		vi.resetAllMocks();
		delete process.env["HF_HOME"];
		delete process.env["HUGGINGFACE_HUB_CACHE"];
	});

	afterEach(() => {
		if (origHfHome === undefined) delete process.env["HF_HOME"];
		else process.env["HF_HOME"] = origHfHome;
		if (origHfHubCache === undefined) delete process.env["HUGGINGFACE_HUB_CACHE"];
		else process.env["HUGGINGFACE_HUB_CACHE"] = origHfHubCache;
	});

	it("returns undefined when snapshotsDir does not exist", () => {
		mockExistsSync.mockReturnValue(false);
		expect(findHfCachedModel()).toBeUndefined();
	});

	it("returns undefined when snapshotsDir is empty", () => {
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockReturnValue([]);
		expect(findHfCachedModel()).toBeUndefined();
	});

	it("returns the most recently modified snapshot", () => {
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockReturnValue(["abc123", "def456"]);
		mockStatSync.mockImplementation((p) => ({
			mtimeMs: p.endsWith("abc123") ? 1000 : 2000,
		}));
		const result = findHfCachedModel();
		expect(result).toContain("def456");
	});

	it("respects HF_HOME env var", () => {
		process.env["HF_HOME"] = "/custom/hf_home";
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockReturnValue(["snap1"]);
		mockStatSync.mockReturnValue({ mtimeMs: 1000 });
		const result = findHfCachedModel();
		expect(result).toContain(join("/custom/hf_home", "hub"));
	});

	it("respects HUGGINGFACE_HUB_CACHE env var", () => {
		process.env["HUGGINGFACE_HUB_CACHE"] = "/custom/hub_cache";
		mockExistsSync.mockReturnValue(true);
		mockReaddirSync.mockReturnValue(["snap1"]);
		mockStatSync.mockReturnValue({ mtimeMs: 1000 });
		const result = findHfCachedModel();
		expect(result).toContain("/custom/hub_cache");
	});
});

describe("discoverAssetsDir", () => {
	const origEnv = process.env["PI_SPEAK_ASSETS_DIR"];

	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(() => {
		if (origEnv === undefined) delete process.env["PI_SPEAK_ASSETS_DIR"];
		else process.env["PI_SPEAK_ASSETS_DIR"] = origEnv;
	});

	it("explicit override wins over HF cache", () => {
		process.env["PI_SPEAK_ASSETS_DIR"] = "/explicit/assets";
		expect(discoverAssetsDir()).toBe("/explicit/assets");
	});

	it("falls back to default path when no explicit dir and no HF cache", () => {
		delete process.env["PI_SPEAK_ASSETS_DIR"];
		mockExistsSync.mockReturnValue(false);
		const result = discoverAssetsDir();
		expect(result).toContain("models--Supertone--supertonic-3");
		expect(result).toContain("snapshots");
	});
});

describe("assetsReady", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("returns true when sentinel file exists", () => {
		mockExistsSync.mockReturnValue(true);
		expect(assetsReady("/my/assets")).toBe(true);
		expect(mockExistsSync).toHaveBeenCalledWith(
			join("/my/assets", "onnx", "duration_predictor.onnx"),
		);
	});

	it("returns false when sentinel file is missing", () => {
		mockExistsSync.mockReturnValue(false);
		expect(assetsReady("/my/assets")).toBe(false);
	});
});
