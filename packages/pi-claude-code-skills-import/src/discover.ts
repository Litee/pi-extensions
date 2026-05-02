import { basename, join } from "node:path";

import { readActivePlugins } from "./activePlugins.js";
import { findSkillDirs } from "./findSkillDirs.js";
import { extractSkillName } from "./frontmatter.js";
import type { DiscoveredSkill } from "./types.js";

export interface DiscoverOptions {
	/** Claude Code home directory (e.g. ~/.claude or $CLAUDE_CONFIG_DIR). */
	claudeDir: string;
	/** Current working directory. When provided, <cwd>/.claude/skills is also scanned. */
	cwd?: string;
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
 * No external IO beyond readdir / readFile on the supplied roots. Missing
 * roots are treated as "nothing to contribute" rather than errors.
 */
export function discoverAllSkills(opts: DiscoverOptions): DiscoveredSkill[] {
	const { claudeDir, cwd } = opts;
	const out: DiscoveredSkill[] = [];

	// 1. User-level skills.
	for (const dir of findSkillDirs(join(claudeDir, "skills"))) {
		out.push(makeSkill(dir, "@user"));
	}

	// 2. Plugin skills — only versions listed as active in installed_plugins.json.
	for (const plugin of readActivePlugins(claudeDir)) {
		for (const dir of findSkillDirs(join(plugin.installPath, "skills"))) {
			out.push(makeSkill(dir, plugin.pluginName));
		}
	}

	// 3. Project-local skills.
	if (cwd !== undefined) {
		for (const dir of findSkillDirs(join(cwd, ".claude", "skills"))) {
			out.push(makeSkill(dir, "@project"));
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
