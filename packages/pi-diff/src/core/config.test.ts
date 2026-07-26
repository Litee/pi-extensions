import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidatePiDiffConfig, loadPiDiffConfig, configSepStyle,  configLongLines, configFileHeader, configColors, configLineNumbers, configIndicatorStyle, configTheme, configShikiTheme } from "./config.js";

describe("loadPiDiffConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-diff-config-test-"));
		invalidatePiDiffConfig();
	});

	afterEach(() => {
		invalidatePiDiffConfig();
	});

	it("returns empty object when no config file exists", () => {
		const config = loadPiDiffConfig(tmpDir);
		expect(config).toEqual({});
	});

	it("reads from project-level pi-diff.json", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: false, indicatorStyle: "none" }), "utf-8");

		const config = loadPiDiffConfig(tmpDir);
		expect(config.lineNumbers).toBe(false);
		expect(config.indicatorStyle).toBe("none");
	});

	it("reads sepStyle from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ sepStyle: "metadata" }), "utf-8");

		expect(configSepStyle(tmpDir)).toBe("metadata");
	});

	it("reads longLines from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ longLines: "scroll" }), "utf-8");

		expect(configLongLines(tmpDir)).toBe("scroll");
	});

	it("reads fileHeader from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ fileHeader: false }), "utf-8");

		expect(configFileHeader(tmpDir)).toBe(false);
	});

	it("reads color overrides from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				colors: { bgAdd: "#111111", bgDel: "#222222", fgAdd: "#33ff33" },
			}),
			"utf-8",
		);

		const colors = configColors(tmpDir);
		expect(colors?.bgAdd).toBe("#111111");
		expect(colors?.bgDel).toBe("#222222");
		expect(colors?.fgAdd).toBe("#33ff33");
	});

	it("ignores invalid JSON files silently", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, "not valid json", "utf-8");

		const config = loadPiDiffConfig(tmpDir);
		expect(config).toEqual({});
	});

	it("caches the result across calls", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: false }), "utf-8");

		const first = loadPiDiffConfig(tmpDir);
		expect(first.lineNumbers).toBe(false);

		// Modify file
		writeFileSync(configPath, JSON.stringify({ lineNumbers: true }), "utf-8");

		// Without invalidation, should still return cached value
		const second = loadPiDiffConfig(tmpDir);
		expect(second.lineNumbers).toBe(false);
	});

	it("re-reads after invalidation", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: false }), "utf-8");

		loadPiDiffConfig(tmpDir);
		writeFileSync(configPath, JSON.stringify({ lineNumbers: true }), "utf-8");

		invalidatePiDiffConfig();
		const config = loadPiDiffConfig(tmpDir);
		expect(config.lineNumbers).toBe(true);
	});

	it("returns {} from ?? fallback when cache is null (no config files found)", () => {
		// First call with no config file sets _cachedConfig = null
		let result = loadPiDiffConfig(tmpDir);
		expect(result).toEqual({});

		// Second call hits the early return with _cachedConfig === null
		// triggering the ?? {} branch (line 73)
		result = loadPiDiffConfig(tmpDir);
		expect(result).toEqual({});
	});
});

describe("config value extractors", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-diff-extractor-test-"));
		invalidatePiDiffConfig();
	});

	afterEach(() => {
		invalidatePiDiffConfig();
	});

	it("configLineNumbers reads lineNumbers from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: true }), "utf-8");
		expect(configLineNumbers(tmpDir)).toBe(true);
	});

	it("configLineNumbers returns false when config has lineNumbers: false", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: false }), "utf-8");
		expect(configLineNumbers(tmpDir)).toBe(false);
	});

	it("configIndicatorStyle reads indicatorStyle from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ indicatorStyle: "classic" }), "utf-8");
		expect(configIndicatorStyle(tmpDir)).toBe("classic");
	});

	it("configIndicatorStyle returns undefined when not set", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: true }), "utf-8");
		expect(configIndicatorStyle(tmpDir)).toBeUndefined();
	});

	it("configTheme reads theme from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ theme: "github-dark" }), "utf-8");
		expect(configTheme(tmpDir)).toBe("github-dark");
	});

	it("configTheme returns undefined when not set", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: true }), "utf-8");
		expect(configTheme(tmpDir)).toBeUndefined();
	});

	it("configShikiTheme reads shikiTheme from config", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ shikiTheme: "github-dark-dimmed" }), "utf-8");
		expect(configShikiTheme(tmpDir)).toBe("github-dark-dimmed");
	});

	it("configShikiTheme returns undefined when not set", () => {
		const configPath = join(tmpDir, "pi-diff.json");
		writeFileSync(configPath, JSON.stringify({ lineNumbers: true }), "utf-8");
		expect(configShikiTheme(tmpDir)).toBeUndefined();
	});
});


// ---------------------------------------------------------------------------
// loadPiDiffConfig without cwd — covers the else branch of the ternary (line 82-87)
// ---------------------------------------------------------------------------

describe("loadPiDiffConfig without cwd", () => {
	beforeEach(() => {
		invalidatePiDiffConfig();
	});

	afterEach(() => {
		invalidatePiDiffConfig();
	});

	it("returns {} when no config files exist in global paths", () => {
		const config = loadPiDiffConfig();
		expect(config).toEqual({});
	});

	it("uses global search paths when cwd is omitted", () => {
		// When cwd is omitted, it searches process.cwd() then global paths.
		// This covers the else branch of the searchPaths ternary (line 82-87).
		const config = loadPiDiffConfig();
		expect(config).toBeDefined();
		expect(typeof config).toBe("object");
	});
});

