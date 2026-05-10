import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DiscoverOptions {
	/** Claude Code home directory (e.g. ~/.claude or $CLAUDE_CONFIG_DIR). */
	claudeDir: string;
	/** Current working directory. When provided, <cwd>/.claude/commands is also checked. */
	cwd?: string;
}

/**
 * Return the list of existing `.claude/commands` directories that pi should
 * scan for prompt templates.
 *
 * Two sources, returned in this order:
 *   1. `<claudeDir>/commands`       → user-level Claude Code commands
 *   2. `<cwd>/.claude/commands`     → project-level Claude Code commands
 *
 * Only directories that actually exist on disk are included, so this function
 * is a safe no-op when Claude Code is not installed or when no commands have
 * been authored yet.
 *
 * Note: Pi's prompt-template discovery is non-recursive, so only `.md` files
 * placed *directly* inside a commands directory are registered as slash
 * commands. Files nested in subdirectories (e.g. `commands/git/commit.md`)
 * are not imported.
 */
export function discoverCommandDirs(opts: DiscoverOptions): string[] {
	const dirs: string[] = [];

	const userCommands = join(opts.claudeDir, "commands");
	if (existsSync(userCommands)) dirs.push(userCommands);

	if (opts.cwd !== undefined) {
		const projectCommands = join(opts.cwd, ".claude", "commands");
		if (existsSync(projectCommands)) dirs.push(projectCommands);
	}

	return dirs;
}
