/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/** Tools that are always disabled while plan mode is active. */
export const PLAN_MODE_DISABLED_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/**
 * Compute the tool set to activate when entering plan mode.
 *
 * Removes `edit` and `write` from `activeTools` (so any third-party write
 * tools the user had enabled also stay active), then ensures the plan-mode
 * read-only basics are always present.
 *
 * Previously the extension unconditionally replaced the entire tool set with
 * the fixed `PLAN_MODE_TOOLS` list, which silently dropped any extra tools
 * the user had added (e.g. MCP servers). This function preserves them.
 *
 * @param activeTools    The tool set currently active before entering plan mode.
 * @param planModeBasicTools  Minimum read-only tools that must be present in plan mode.
 * @param disabledTools  Tools to remove (defaults to PLAN_MODE_DISABLED_TOOLS).
 */
export function computePlanModeTools(
	activeTools: string[],
	planModeBasicTools: string[],
	disabledTools: ReadonlySet<string> = PLAN_MODE_DISABLED_TOOLS,
): string[] {
	const without = activeTools.filter((t) => !disabledTools.has(t));
	// De-duplicate: add basics that aren't already present.
	const withoutSet = new Set(without);
	const extras = planModeBasicTools.filter((t) => !withoutSet.has(t));
	return [...without, ...extras];
}

/**
 * Format a list of tool names for display in a notification message.
 *
 * Shows all tools when there are 10 or fewer; otherwise shows the first 10
 * and appends a "(+N more)" note so the message stays readable regardless of
 * how many tools are active.
 *
 * @example
 * formatToolList(["read", "bash", "grep"]) // "Tools: read, bash, grep"
 * formatToolList(new Array(12).fill(0).map((_,i)=>`t${i+1}`))
 * // "Tools: t1, t2, ..., t10 (+2 more)"
 */
export function formatToolList(tools: string[]): string {
	const SAMPLE_SIZE = 10;
	const sample = tools.slice(0, SAMPLE_SIZE);
	const base = `Tools: ${sample.join(", ")}`;
	if (tools.length > SAMPLE_SIZE) {
		return `${base} (${tools.length} total)`;
	}
	return base;
}

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}
