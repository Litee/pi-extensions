import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

	beforeAll(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-discover-"));
	});

	afterAll(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(tmpRoot)) {
			rmSync(join(tmpRoot, entry), { recursive: true, force: true });
		}
		claudeDir = mkdir(tmpRoot, "claude");
	});

	afterEach(() => {});

	it("returns [] when claudeDir is empty and no cwd is given", () => {
		expect(discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] })).toEqual([]);
	});

	it("discovers user-level skills under <claudeDir>/skills with pluginId '@user'", () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		const result = discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] });
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
		const result = discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] });
		expect(result[0]?.skillName).toBe("frontmatter-name");
		expect(result[0]?.qualifiedName).toBe("@user/frontmatter-name");
	});

	it("falls back to directory basename when frontmatter has no name", () => {
		const dir = join(claudeDir, "skills", "fallback-dir");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\ndescription: x\n---\n");
		expect(discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] })[0]?.skillName).toBe("fallback-dir");
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

		const result = discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] });
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
		const result = discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] });
		expect(result.map((s) => s.qualifiedName).sort()).toEqual(["p/one", "p/two"]);
	});

	it("includes <cwd>/.claude/skills with pluginId '@project' when cwd is supplied", () => {
		const cwd = mkdir(tmpRoot, "project");
		writeSkill(join(cwd, ".claude", "skills", "local"), "local");
		const result = discoverAllSkills({ claudeDir, cwd, alreadyLoadedSkills: [] });
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
		expect(discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] })).toEqual([]);
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
		const names = discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] }).map((s) => s.qualifiedName);
		expect(names).toEqual([...names].sort());
		expect(names).toEqual(["@user/alpha", "@user/zulu", "beta/mid"]);
	});

	it("returns [] when claudeDir does not exist entirely", () => {
		expect(discoverAllSkills({ claudeDir: join(tmpRoot, "nope"), alreadyLoadedSkills: [] })).toEqual([]);
	});

	it("keeps non-symlinked skills that happen to live next to an unrelated directory", () => {
		writeSkill(join(claudeDir, "skills", "kept"), "kept");
		const result = discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] });
		expect(result.map((s) => s.qualifiedName)).toEqual(["@user/kept"]);
	});

	it("keeps a symlinked skill whose target is NOT under a .agents/skills directory", () => {
		// Symlink into a random elsewhere — not pi core territory.
		const elsewhere = mkdir(tmpRoot, "elsewhere");
		writeSkill(join(elsewhere, "tool"), "tool");
		mkdir(claudeDir, "skills");
		symlinkSync(join(elsewhere, "tool"), join(claudeDir, "skills", "tool"));
		const names = discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] }).map((s) => s.qualifiedName);
		expect(names).toEqual(["@user/tool"]);
	});
});


describe("discoverAllSkills with alreadyLoadedSkills (issue #0007)", () => {
	let tmpRoot: string;
	let claudeDir: string;

	beforeAll(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-dedup-"));
	});

	afterAll(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(tmpRoot)) {
			rmSync(join(tmpRoot, entry), { recursive: true, force: true });
		}
		claudeDir = mkdir(tmpRoot, "claude");
	});

	it("excludes a skill whose skillDir matches an alreadyLoadedSkills entry's path", () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		writeSkill(join(claudeDir, "skills", "beta"), "beta");
		const alphaDir = join(claudeDir, "skills", "alpha");
		const result = discoverAllSkills({
			claudeDir,
			alreadyLoadedSkills: [{ name: "other-name", path: alphaDir }],
		});
		expect(result.map((s) => s.skillName)).toEqual(["beta"]);
	});

	it("excludes a skill whose skillName matches an alreadyLoadedSkills entry's name", () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		writeSkill(join(claudeDir, "skills", "beta"), "beta");
		const result = discoverAllSkills({
			claudeDir,
			// path does not match any skill dir — only the name triggers exclusion
			alreadyLoadedSkills: [{ name: "alpha", path: "/some/unrelated/path" }],
		});
		expect(result.map((s) => s.skillName)).toEqual(["beta"]);
	});

	it("does NOT use the heuristic when alreadyLoadedSkills is provided (empty list keeps symlinked skill)", () => {
		// Even if the skill's realpath resolves into .agents/skills, it should
		// NOT be excluded when alreadyLoadedSkills is given but does not
		// mention it — the API is authoritative, not the heuristic.
		const agentsSkills = mkdir(tmpRoot, "home/.agents/skills");
		writeSkill(join(agentsSkills, "archon"), "archon");
		mkdir(claudeDir, "skills");
		symlinkSync(join(agentsSkills, "archon"), join(claudeDir, "skills", "archon"));
		const result = discoverAllSkills({
			claudeDir,
			alreadyLoadedSkills: [], // API says nothing is already loaded
		});
		// Heuristic would exclude this; API-mode with an empty list does not
		expect(result.map((s) => s.skillName)).toEqual(["archon"]);
	});

	it("returns all skills when alreadyLoadedSkills is an empty array", () => {
		writeSkill(join(claudeDir, "skills", "x"), "x");
		writeSkill(join(claudeDir, "skills", "y"), "y");
		const result = discoverAllSkills({ claudeDir, alreadyLoadedSkills: [] });
		expect(result.map((s) => s.skillName).sort()).toEqual(["x", "y"]);
	});

	it("excludes plugin skills matched by name in alreadyLoadedSkills", () => {
		const installPath = mkdir(tmpRoot, "claude/plugins/cache/owner/p/1.0.0");
		writeSkill(join(installPath, "skills", "one"), "one");
		writeSkill(join(installPath, "skills", "two"), "two");
		writeFileSync(
			join(claudeDir, "plugins", "installed_plugins.json"),
			JSON.stringify({
				plugins: {
					"p@owner": [{ scope: "user", installPath, lastUpdated: "2025-01-01T00:00:00Z" }],
				},
			}),
		);
		const result = discoverAllSkills({
			claudeDir,
			alreadyLoadedSkills: [{ name: "one", path: "/unrelated" }],
		});
		expect(result.map((s) => s.skillName)).toEqual(["two"]);
	});

	it("excludes project-local skills matched by path in alreadyLoadedSkills", () => {
		const cwd = mkdir(tmpRoot, "project");
		const localDir = join(cwd, ".claude", "skills", "local");
		writeSkill(localDir, "local");
		const result = discoverAllSkills({
			claudeDir,
			cwd,
			alreadyLoadedSkills: [{ name: "unrelated", path: localDir }],
		});
		expect(result).toEqual([]);
	});

	it("excludes plugin skills matched by path in alreadyLoadedSkills", () => {
		// Covers the `excludedByDir` true branch for plugin skills.
		const installPath = mkdir(tmpRoot, "claude/plugins/cache/owner/p2/1.0.0");
		writeSkill(join(installPath, "skills", "one"), "one");
		writeSkill(join(installPath, "skills", "two"), "two");
		writeFileSync(
			join(claudeDir, "plugins", "installed_plugins.json"),
			JSON.stringify({
				plugins: {
					"p2@owner": [{ scope: "user", installPath, lastUpdated: "2025-01-01T00:00:00Z" }],
				},
			}),
		);
		const oneDir = join(installPath, "skills", "one");
		const result = discoverAllSkills({
			claudeDir,
			alreadyLoadedSkills: [{ name: "unrelated-name", path: oneDir }],
		});
		expect(result.map((s) => s.skillName)).toEqual(["two"]);
	});

	it("excludes project-local skills matched by name in alreadyLoadedSkills", () => {
		// Covers the `excludedByName` true branch for project-local skills.
		const cwd = mkdir(tmpRoot, "project2");
		writeSkill(join(cwd, ".claude", "skills", "local"), "local");
		const result = discoverAllSkills({
			claudeDir,
			cwd,
			alreadyLoadedSkills: [{ name: "local", path: "/unrelated/path" }],
		});
		expect(result).toEqual([]);
	});
});
