import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAllSkills } from "../src/discover.js";

function mkdir(root: string, rel: string): string {
	const p = join(root, rel);
	mkdirSync(p, { recursive: true });
	return p;
}

function writeSkill(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: fixture ${name}.\n---\n\n# ${name}\n`,
	);
}

function writeManifest(claudeDir: string, manifest: unknown): void {
	const p = join(claudeDir, "plugins");
	mkdirSync(p, { recursive: true });
	writeFileSync(join(p, "installed_plugins.json"), JSON.stringify(manifest));
}

describe("discoverAllSkills", () => {
	let tmpRoot: string;
	let claudeDir: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-discover-"));
		claudeDir = mkdir(tmpRoot, "claude");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns [] when claudeDir is empty and no cwd is given", () => {
		expect(discoverAllSkills({ claudeDir })).toEqual([]);
	});

	it("discovers user-level skills under <claudeDir>/skills with pluginId '@user'", () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		const result = discoverAllSkills({ claudeDir });
		expect(result).toEqual([
			{
				qualifiedName: "@user/alpha",
				skillName: "alpha",
				pluginId: "@user",
				skillDir: join(claudeDir, "skills", "alpha"),
				skillFile: join(claudeDir, "skills", "alpha", "SKILL.md"),
			},
		]);
	});

	it("uses SKILL.md frontmatter name when it differs from the directory basename", () => {
		const dir = join(claudeDir, "skills", "dir-name-that-differs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			"---\nname: frontmatter-name\ndescription: x\n---\n",
		);
		const result = discoverAllSkills({ claudeDir });
		expect(result[0]?.skillName).toBe("frontmatter-name");
		expect(result[0]?.qualifiedName).toBe("@user/frontmatter-name");
	});

	it("falls back to directory basename when frontmatter has no name", () => {
		const dir = join(claudeDir, "skills", "fallback-dir");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\ndescription: x\n---\n");
		expect(discoverAllSkills({ claudeDir })[0]?.skillName).toBe("fallback-dir");
	});

	it("only includes plugins listed as active in installed_plugins.json (ignores fan-out versions)", () => {
		// Two cached versions on disk, only the newer one listed as active.
		writeSkill(
			join(claudeDir, "plugins", "cache", "owner", "alpha", "1.0.0", "skills", "old-skill"),
			"old-skill",
		);
		writeSkill(
			join(claudeDir, "plugins", "cache", "owner", "alpha", "2.0.0", "skills", "new-skill"),
			"new-skill",
		);
		writeManifest(claudeDir, {
			plugins: {
				"alpha@owner": [
					{
						scope: "user",
						installPath: join(claudeDir, "plugins", "cache", "owner", "alpha", "2.0.0"),
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		});

		const result = discoverAllSkills({ claudeDir });
		expect(result.map((s) => s.skillName)).toEqual(["new-skill"]);
		expect(result[0]?.qualifiedName).toBe("alpha/new-skill");
		expect(result[0]?.pluginId).toBe("alpha");
	});

	it("qualifies plugin skills as '<pluginName>/<skillName>'", () => {
		const installPath = join(claudeDir, "plugins", "cache", "owner", "p", "1.0.0");
		writeSkill(join(installPath, "skills", "one"), "one");
		writeSkill(join(installPath, "skills", "two"), "two");
		writeManifest(claudeDir, {
			plugins: {
				"p@owner": [{ scope: "user", installPath, lastUpdated: "2025-01-01T00:00:00Z" }],
			},
		});
		const result = discoverAllSkills({ claudeDir });
		expect(result.map((s) => s.qualifiedName).sort()).toEqual(["p/one", "p/two"]);
	});

	it("includes <cwd>/.claude/skills with pluginId '@project' when cwd is supplied", () => {
		const cwd = mkdir(tmpRoot, "project");
		writeSkill(join(cwd, ".claude", "skills", "local"), "local");
		const result = discoverAllSkills({ claudeDir, cwd });
		const local = result.find((s) => s.skillName === "local");
		expect(local).toMatchObject({
			qualifiedName: "@project/local",
			pluginId: "@project",
			skillDir: join(cwd, ".claude", "skills", "local"),
			skillFile: join(cwd, ".claude", "skills", "local", "SKILL.md"),
		});
	});

	it("does not consider cwd when cwd is omitted", () => {
		const cwd = mkdir(tmpRoot, "project");
		writeSkill(join(cwd, ".claude", "skills", "local"), "local");
		expect(discoverAllSkills({ claudeDir })).toEqual([]);
	});

	it("returns results sorted by qualifiedName", () => {
		writeSkill(join(claudeDir, "skills", "zulu"), "zulu");
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		const installPath = join(claudeDir, "plugins", "cache", "o", "beta", "1.0.0");
		writeSkill(join(installPath, "skills", "mid"), "mid");
		writeManifest(claudeDir, {
			plugins: {
				"beta@o": [{ scope: "user", installPath, lastUpdated: "2025-01-01T00:00:00Z" }],
			},
		});
		const names = discoverAllSkills({ claudeDir }).map((s) => s.qualifiedName);
		expect(names).toEqual([...names].sort());
		expect(names).toEqual(["@user/alpha", "@user/zulu", "beta/mid"]);
	});

	it("returns [] when claudeDir does not exist entirely", () => {
		expect(discoverAllSkills({ claudeDir: join(tmpRoot, "nope") })).toEqual([]);
	});
});
