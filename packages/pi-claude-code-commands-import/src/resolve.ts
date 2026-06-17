import { join } from "node:path";

/**
 * Resolve the Claude Code home directory.
 *
 * Honors `$CLAUDE_CONFIG_DIR` when set to a non-empty string (matching Claude
 * Code's own convention). Falls back to `<home>/.claude` otherwise.
 *
 * This function is pure: the caller supplies the environment and home directory
 * so the logic is trivial to unit-test without touching process state.
 */
export function resolveClaudeDir(env: NodeJS.ProcessEnv, home: string): string {
	const override = env["CLAUDE_CONFIG_DIR"];
	if (override !== undefined && override !== "") {
		return override;
	}
	return join(home, ".claude");
}
