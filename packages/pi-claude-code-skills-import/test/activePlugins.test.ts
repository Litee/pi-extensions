import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readActivePlugins } from "../src/activePlugins.js";

function writeManifest(claudeDir: string, manifest: unknown): void {
	const dir = join(claudeDir, "plugins");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify(manifest));
}

describe("readActivePlugins", () => {
	let tmpRoot: string;
	let claudeDir: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-active-"));
		claudeDir = join(tmpRoot, "claude");
		mkdirSync(claudeDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns [] when the manifest file is missing", () => {
		expect(readActivePlugins(claudeDir)).toEqual([]);
	});

	it("returns [] when the manifest is malformed JSON", () => {
		mkdirSync(join(claudeDir, "plugins"));
		writeFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "{not json");
		expect(readActivePlugins(claudeDir)).toEqual([]);
	});

	it("returns [] when plugins field is absent or not an object", () => {
		writeManifest(claudeDir, { notPlugins: {} });
		expect(readActivePlugins(claudeDir)).toEqual([]);

		writeManifest(claudeDir, { plugins: [] });
		expect(readActivePlugins(claudeDir)).toEqual([]);
	});

	it("skips plugins with an empty entry array", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [],
			},
		});
		expect(readActivePlugins(claudeDir)).toEqual([]);
	});

	it("extracts pluginName as the portion before the first @ in pluginKey", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [{ scope: "user", installPath: "/x/alpha-1", lastUpdated: "2025-01-01T00:00:00Z" }],
			},
		});
		const result = readActivePlugins(claudeDir);
		expect(result).toEqual([
			{ pluginKey: "alpha@owner", pluginName: "alpha", installPath: "/x/alpha-1" },
		]);
	});

	it("handles pluginKey without an @ (pluginName = pluginKey)", () => {
		writeManifest(claudeDir, {
			plugins: {
				alpha: [{ scope: "user", installPath: "/x/a", lastUpdated: "2025-01-01T00:00:00Z" }],
			},
		});
		expect(readActivePlugins(claudeDir)).toEqual([
			{ pluginKey: "alpha", pluginName: "alpha", installPath: "/x/a" },
		]);
	});

	it("prefers the user-scope entry over non-user entries regardless of date", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [
					{ scope: "project", installPath: "/new/alpha", lastUpdated: "2030-01-01T00:00:00Z" },
					{ scope: "user", installPath: "/old/alpha", lastUpdated: "2020-01-01T00:00:00Z" },
				],
			},
		});
		expect(readActivePlugins(claudeDir)).toEqual([
			{ pluginKey: "alpha@owner", pluginName: "alpha", installPath: "/old/alpha" },
		]);
	});

	it("falls back to the newest entry by lastUpdated when no user-scope entry exists", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [
					{ scope: "project", installPath: "/older", lastUpdated: "2020-01-01T00:00:00Z" },
					{ scope: "project", installPath: "/newer", lastUpdated: "2024-06-01T00:00:00Z" },
				],
			},
		});
		expect(readActivePlugins(claudeDir)).toEqual([
			{ pluginKey: "alpha@owner", pluginName: "alpha", installPath: "/newer" },
		]);
	});

	it("falls back to installedAt when lastUpdated is missing", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [
					{ scope: "project", installPath: "/older", installedAt: "2020-01-01T00:00:00Z" },
					{ scope: "project", installPath: "/newer", installedAt: "2024-06-01T00:00:00Z" },
				],
			},
		});
		expect(readActivePlugins(claudeDir)).toEqual([
			{ pluginKey: "alpha@owner", pluginName: "alpha", installPath: "/newer" },
		]);
	});

	it("skips entries that have no installPath", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [{ scope: "user", lastUpdated: "2025-01-01T00:00:00Z" }],
			},
		});
		expect(readActivePlugins(claudeDir)).toEqual([]);
	});

	it("skips entries where the entry object is falsy (e.g. null items in the array)", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [null],
			},
		});
		// chosen is null → no installPath → skipped.
		expect(readActivePlugins(claudeDir)).toEqual([]);
	});

	it("skips rawEntries that are not an array", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": "not-an-array",
			},
		});
		expect(readActivePlugins(claudeDir)).toEqual([]);
	});

	it("returns one entry per plugin across many plugins", () => {
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [{ scope: "user", installPath: "/a", lastUpdated: "2025-01-01T00:00:00Z" }],
				"beta@owner": [{ scope: "user", installPath: "/b", lastUpdated: "2025-01-01T00:00:00Z" }],
			},
		});
		const result = readActivePlugins(claudeDir);
		expect(result.map((p) => p.pluginName).sort()).toEqual(["alpha", "beta"]);
	});
});
