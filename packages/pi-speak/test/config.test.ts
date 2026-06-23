import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the fs module before importing config
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	readdirSync: vi.fn(),
	statSync: vi.fn(),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

// Mock os module
vi.mock("node:os", () => ({
	homedir: () => "/home/testuser",
}));

// Mock getAgentDir
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "/fake",
}));

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetsReady, configFilePath, discoverAssetsDir, findHfCachedModel, loadConfig, resolveExplicitAssetsDir, saveConfig } from "../src/config.js";

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

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe("saveConfig", () => {
	const mockMkdirSync = vi.mocked(mkdirSync);
	const mockWriteFileSync = vi.mocked(writeFileSync as unknown as (p: string, d: string, e: string) => void);

	beforeEach(() => {
		vi.resetAllMocks();
		// loadConfig calls readFileSync; make it return an empty-object config by default
		vi.mocked(readFileSync).mockReturnValue("{}");
	});

	it("returns true when writeFileSync succeeds", () => {
		mockMkdirSync.mockReturnValue(undefined);
		mockWriteFileSync.mockReturnValue(undefined);

		expect(saveConfig({ defaultVoice: "F1" })).toBe(true);
		expect(mockMkdirSync).toHaveBeenCalledWith("/fake", { recursive: true });
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/fake/pi-speak.json",
			expect.stringContaining('"defaultVoice": "F1"'),
			"utf-8",
		);
	});

	it("returns false when writeFileSync throws", () => {
		mockMkdirSync.mockReturnValue(undefined);
		mockWriteFileSync.mockImplementation(() => { throw new Error("disk full"); });

		expect(saveConfig({ defaultVoice: "F1" })).toBe(false);
	});

	it("merges partial with the current config", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultVoice: "M1" }));
		mockMkdirSync.mockReturnValue(undefined);

		let written = "";
		mockWriteFileSync.mockImplementation((_p: string, d: string) => { written = d; });

		expect(saveConfig({ defaultLang: "en" })).toBe(true);
		const parsed = JSON.parse(written) as Record<string, string>;
		expect(parsed).toEqual({ defaultVoice: "M1", defaultLang: "en" });
	});
});

// ---------------------------------------------------------------------------
// loadConfig — individual field branches not yet covered above
// ---------------------------------------------------------------------------

describe("loadConfig — all supported fields", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("picks up defaultVoice when valid string", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultVoice: "M1" }));
		expect(loadConfig()).toEqual({ defaultVoice: "M1" });
	});

	it("ignores defaultVoice when wrong type", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultVoice: 99 }));
		expect(loadConfig()).toEqual({});
	});

	it("picks up defaultLang when valid string", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultLang: "fr" }));
		expect(loadConfig()).toEqual({ defaultLang: "fr" });
	});

	it("picks up defaultSpeed when valid number", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultSpeed: 1.2 }));
		expect(loadConfig()).toEqual({ defaultSpeed: 1.2 });
	});

	it("ignores defaultSpeed when wrong type (string)", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultSpeed: "fast" }));
		expect(loadConfig()).toEqual({});
	});

	it("picks up defaultSteps when valid number", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultSteps: 16 }));
		expect(loadConfig()).toEqual({ defaultSteps: 16 });
	});

	it("ignores defaultSteps when wrong type", () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultSteps: true }));
		expect(loadConfig()).toEqual({});
	});

	it("returns an object with null root as {} (Array.isArray guard)", () => {
		vi.mocked(readFileSync).mockReturnValue("null");
		expect(loadConfig()).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// findHfCachedModel — candidate path existsSync false branch (line 89)
// ---------------------------------------------------------------------------

describe("findHfCachedModel — candidate does not exist at snapshot path", () => {
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

	it("returns undefined when snapshotsDir exists but the chosen snapshot path does not", () => {
		// existsSync(snapshotsDir) returns true, but existsSync(candidate) returns false
		const snapshotsDirPath = join(
			"/home/testuser", ".cache", "huggingface", "hub",
			"models--Supertone--supertonic-3", "snapshots",
		);
		mockExistsSync.mockImplementation((p) => {
			// snapshotsDir itself exists, but the actual snapshot subdirectory does not
			if (p === snapshotsDirPath) return true;
			return false; // candidate path doesn't exist
		});
		mockReaddirSync.mockReturnValue(["abc123"]);
		mockStatSync.mockReturnValue({ mtimeMs: 1000 });

		expect(findHfCachedModel()).toBeUndefined();
	});
});
