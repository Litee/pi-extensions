import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Find every directory under `root` that directly contains a SKILL.md.
 *
 * Follows symlinks: if a child is a symlink pointing at a directory, it is
 * treated as that directory. Claude Code's `~/.claude/skills/` commonly
 * contains symlinks into `~/.agents/skills/*`, so symlink following is
 * required for user-level skill discovery.
 *
 * Descends into a child only when that child does *not* already contain a
 * SKILL.md, so a skill dir is reported once (not twice along with any
 * SKILL.md files nested inside it). Returns [] if `root` does not exist or
 * is unreadable.
 */
export function findSkillDirs(root: string): string[] {
	const out: string[] = [];
	if (!existsSync(root)) return out;
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const dir = join(root, entry.name);
		if (!isDirectoryFollowingSymlinks(entry, dir)) continue;
		const skillFile = join(dir, "SKILL.md");
		if (existsSync(skillFile)) {
			out.push(dir);
		} else {
			out.push(...findSkillDirs(dir));
		}
	}
	return out;
}

function isDirectoryFollowingSymlinks(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }, fullPath: string): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(fullPath).isDirectory();
	} catch {
		return false;
	}
}
