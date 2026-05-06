/**
 * Environment-variable derived runtime config for pi-cmux-report-status.
 *
 * Kept in its own module so tests can exercise the parsing rules without
 * having to boot the rest of the extension.
 */

/**
 * The sidebar status-pill key we write to with `cmux set-status`. One pill
 * per extension, matching slack-watcher / issue-watcher conventions.
 *
 * Overridable via `$PI_CMUX_STATUS_KEY`; defaults to "pi".
 */
export function resolveStatusKey(env: NodeJS.ProcessEnv = process.env): string {
	const v = env["PI_CMUX_STATUS_KEY"];
	if (v && v.trim().length > 0) return v;
	return "pi";
}
