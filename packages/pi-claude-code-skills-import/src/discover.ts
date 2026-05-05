import { realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";

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
 * Skills whose real path resolves into a `.agents/skills/` directory are
 * excluded — pi core already auto-loads those via its own skills-discovery
 * pass (user-level `~/.agents/skills/` and project-ancestor
 * `<dir>/.agents/skills/`), so surfacing them again here would produce a
 * duplicate entry with a different qualified name (e.g. `@user/archon` and
 * `agents/archon` for the same underlying directory). The typical trigger
 * is a symlink from `~/.claude/skills/<name>` into `~/.agents/skills/<name>`.
 *
 * No external IO beyond readdir / readFile on the supplied roots. Missing
 * roots are treated as "nothing to contribute" rather than errors.
 */
export function discoverAllSkills(opts: DiscoverOptions): DiscoveredSkill[] {
	const { claudeDir, cwd } = opts;
	const out: DiscoveredSkill[] = [];

	// 1. User-level skills.
	for (const dir of findSkillDirs(join(claudeDir, "skills"))) {
		if (resolvesIntoAgentsSkills(dir)) continue;
		out.push(makeSkill(dir, "@user"));
	}

	// 2. Plugin skills — only versions listed as active in installed_plugins.json.
	for (const plugin of readActivePlugins(claudeDir)) {
		for (const dir of findSkillDirs(join(plugin.installPath, "skills"))) {
			if (resolvesIntoAgentsSkills(dir)) continue;
			out.push(makeSkill(dir, plugin.pluginName));
		}
	}

	// 3. Project-local skills.
	if (cwd !== undefined) {
		for (const dir of findSkillDirs(join(cwd, ".claude", "skills"))) {
			if (resolvesIntoAgentsSkills(dir)) continue;
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

/**
 * Return true when the realpath of `skillDir` lies under a `.agents/skills/`
 * directory — the canonical auto-load root for pi core's own skills pass.
 *
 * Match rule: the realpath contains the segment `.agents/skills` (OS-agnostic:
 * `path.sep` used for split). Matches both `~/.agents/skills/<name>` and any
 * project-ancestor `<dir>/.agents/skills/<name>` without having to replicate
 * pi core's ancestor-walk — any `.agents/skills` anywhere in the resolved
 * path is treated as a pi-core-owned skill.
 *
 * If realpath fails (broken symlink, ENOENT, permission error), returns
 * false — be permissive rather than silently dropping a legitimate skill.
 * A broken symlink almost certainly fails the later SKILL.md existence
 * check anyway, so this does not produce spurious entries in practice.
 *
 * Exported for unit testing.
 */
export function resolvesIntoAgentsSkills(skillDir: string): boolean {
	let real: string;
	try {
		real = realpathSync(skillDir);
	} catch {
		return false;
	}
	const segments = real.split(sep);
	for (let i = 0; i + 1 < segments.length; i++) {
		if (segments[i] === ".agents" && segments[i + 1] === "skills") return true;
	}
	return false;
}
