import { basename, join } from "node:path";

import { readActivePlugins } from "./activePlugins.js";
import { findSkillDirs } from "./findSkillDirs.js";
import { extractSkillName } from "./frontmatter.js";
import type { DiscoveredSkill } from "./types.js";

/** A minimal skill descriptor as returned by `ctx.getSystemPromptOptions().skills`. */
export interface AlreadyLoadedSkill {
	name: string;
	path: string;
}

export interface DiscoverOptions {
	/** Claude Code home directory (e.g. ~/.claude or $CLAUDE_CONFIG_DIR). */
	claudeDir: string;
	/** Current working directory. When provided, <cwd>/.claude/skills is also scanned. */
	cwd?: string;
	/**
	 * Skills already loaded by pi core, as returned by
	 * `ctx.getSystemPromptOptions().skills` (pi 0.78.0+).
	 *
	 * A discovered skill is excluded when its `skillDir` matches an entry's
	 * `path` **or** its `skillName` matches an entry's `name`.
	 */
	alreadyLoadedSkills: ReadonlyArray<AlreadyLoadedSkill>;
}

/**
 * Discover every Claude Code skill visible to pi, resolving each to a
 * {@link DiscoveredSkill} carrying its qualified name, bare name, plugin id,
 * and absolute paths.
 *
 * Sources, merged and sorted by qualifiedName:
 *   - `<claudeDir>/skills`                             → pluginId "@user"
 *   - `<installPath>/skills` for every active plugin  → pluginId "<pluginName>"
 *     (active-version selection per {@link readActivePlugins})
 *   - `<cwd>/.claude/skills`                           → pluginId "@project"
 *
 * **Deduplication against pi-core skills:**
 * A skill is excluded if its `skillDir` matches an entry in
 * `opts.alreadyLoadedSkills[].path` or its `skillName` matches an entry's
 * `name`. Pass an empty array to skip deduplication.
 *
 * No external IO beyond readdir / readFile on the supplied roots. Missing
 * roots are treated as "nothing to contribute" rather than errors.
 */
export function discoverAllSkills(opts: DiscoverOptions): DiscoveredSkill[] {
	const { claudeDir, cwd, alreadyLoadedSkills } = opts;
	const out: DiscoveredSkill[] = [];

	const alreadyLoadedPaths = new Set(alreadyLoadedSkills.map((s) => s.path));
	const alreadyLoadedNames = new Set(alreadyLoadedSkills.map((s) => s.name));

	function excludedByDir(dir: string): boolean {
		return alreadyLoadedPaths.has(dir);
	}

	function excludedByName(skillName: string): boolean {
		return alreadyLoadedNames.has(skillName);
	}

	// 1. User-level skills.
	for (const dir of findSkillDirs(join(claudeDir, "skills"))) {
		if (excludedByDir(dir)) continue;
		const skill = makeSkill(dir, "@user");
		if (excludedByName(skill.skillName)) continue;
		out.push(skill);
	}

	// 2. Plugin skills — only versions listed as active in installed_plugins.json.
	for (const plugin of readActivePlugins(claudeDir)) {
		for (const dir of findSkillDirs(join(plugin.installPath, "skills"))) {
			if (excludedByDir(dir)) continue;
			const skill = makeSkill(dir, plugin.pluginName);
			if (excludedByName(skill.skillName)) continue;
			out.push(skill);
		}
	}

	// 3. Project-local skills.
	if (cwd !== undefined) {
		for (const dir of findSkillDirs(join(cwd, ".claude", "skills"))) {
			if (excludedByDir(dir)) continue;
			const skill = makeSkill(dir, "@project");
			if (excludedByName(skill.skillName)) continue;
			out.push(skill);
		}
	}

	out.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
	return out;
}

function makeSkill(skillDir: string, pluginId: string): DiscoveredSkill {
	const skillFile = join(skillDir, "SKILL.md");
	const skillName = extractSkillName(skillFile) ?? basename(skillDir);
	return {
		qualifiedName: `${pluginId}/${skillName}`,
		skillName,
		pluginId,
		skillDir,
		skillFile,
	};
}
