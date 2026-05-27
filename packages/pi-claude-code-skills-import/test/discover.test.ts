import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { discoverAllSkills, resolvesIntoAgentsSkills } from "../src/discover.js";

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

	it("excludes a user-level skill that is a symlink into ~/.agents/skills (pi core auto-loads it)", () => {
		// Real skill lives under tmpRoot/home/.agents/skills/archon;
		// claudeDir/skills/archon is a symlink to it. pi core would pick up
		// the real path via its own .agents/skills scan, so cc-skills-import
		// must skip the symlinked view to avoid duplicate qualified names.
		const agentsSkills = mkdir(tmpRoot, "home/.agents/skills");
		writeSkill(join(agentsSkills, "archon"), "archon");
		mkdir(claudeDir, "skills");
		symlinkSync(join(agentsSkills, "archon"), join(claudeDir, "skills", "archon"));
		expect(discoverAllSkills({ claudeDir })).toEqual([]);
	});

	it("still excludes when the agents/skills directory is a project-local .agents/skills", () => {
		// Mirror of pi core's ancestor-walk case: the real path has a
		// `.agents/skills` segment anywhere, not just a user-level one.
		const projectAgents = mkdir(tmpRoot, "repo/.agents/skills");
		writeSkill(join(projectAgents, "myskill"), "myskill");
		mkdir(claudeDir, "skills");
		symlinkSync(join(projectAgents, "myskill"), join(claudeDir, "skills", "myskill"));
		expect(discoverAllSkills({ claudeDir })).toEqual([]);
	});

	it("keeps non-symlinked skills that happen to live next to an unrelated directory", () => {
		writeSkill(join(claudeDir, "skills", "kept"), "kept");
		const result = discoverAllSkills({ claudeDir });
		expect(result.map((s) => s.qualifiedName)).toEqual(["@user/kept"]);
	});

	it("keeps a symlinked skill whose target is NOT under a .agents/skills directory", () => {
		// Symlink into a random elsewhere — not pi core territory.
		const elsewhere = mkdir(tmpRoot, "elsewhere");
		writeSkill(join(elsewhere, "tool"), "tool");
		mkdir(claudeDir, "skills");
		symlinkSync(join(elsewhere, "tool"), join(claudeDir, "skills", "tool"));
		const names = discoverAllSkills({ claudeDir }).map((s) => s.qualifiedName);
		expect(names).toEqual(["@user/tool"]);
	});

	it("excludes a plugin-level skill whose installPath/skills/<name> is a symlink into .agents/skills", () => {
		// Guard the other code path: the filter runs for active plugins too,
		// not just @user.
		const plugin = mkdir(tmpRoot, "plugin/1.0.0");
		mkdir(plugin, "skills");
		const agentsSkills = mkdir(tmpRoot, "home/.agents/skills");
		writeSkill(join(agentsSkills, "duped"), "duped");
		symlinkSync(join(agentsSkills, "duped"), join(plugin, "skills", "duped"));
		writeManifest(claudeDir, {
			version: 2,
			plugins: {
				"plugin@scope": [{ scope: "user", installPath: plugin, version: "1.0.0" }],
			},
		});
		expect(discoverAllSkills({ claudeDir })).toEqual([]);
	});
});

describe("resolvesIntoAgentsSkills", () => {
	let tmpRoot: string;

	beforeAll(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-agentsfilter-"));
	});

	afterAll(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	beforeEach(() => {
		for (const entry of readdirSync(tmpRoot)) {
			rmSync(join(tmpRoot, entry), { recursive: true, force: true });
		}
	});

	it("returns true for a path whose realpath lies under a .agents/skills directory", () => {
		const skillDir = join(tmpRoot, ".agents", "skills", "foo");
		mkdirSync(skillDir, { recursive: true });
		expect(resolvesIntoAgentsSkills(skillDir)).toBe(true);
	});

	it("returns true when the input is a symlink resolving into .agents/skills", () => {
		const real = join(tmpRoot, ".agents", "skills", "target");
		mkdirSync(real, { recursive: true });
		const link = join(tmpRoot, "link");
		symlinkSync(real, link);
		expect(resolvesIntoAgentsSkills(link)).toBe(true);
	});

	it("returns false for a path outside any .agents/skills directory", () => {
		const other = join(tmpRoot, "claude", "skills", "bar");
		mkdirSync(other, { recursive: true });
		expect(resolvesIntoAgentsSkills(other)).toBe(false);
	});

	it("returns false for a broken symlink (realpath throws)", () => {
		const link = join(tmpRoot, "dangling");
		symlinkSync(join(tmpRoot, "missing-target"), link);
		expect(resolvesIntoAgentsSkills(link)).toBe(false);
	});

	it("does not match 'agents/skills' without the leading dot ('my-agents/skills/x')", () => {
		// Guard against over-eager substring matching: only the literal
		// `.agents/skills` pair counts.
		const dir = join(tmpRoot, "my-agents", "skills", "x");
		mkdirSync(dir, { recursive: true });
		expect(resolvesIntoAgentsSkills(dir)).toBe(false);
	});
});
