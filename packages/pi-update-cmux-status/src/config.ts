/**
 * Environment-variable derived runtime config for pi-update-cmux-status.
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

/**
 * Whether the extension should rename the cmux *workspace* (not just the
 * tab). Disabled when `$PI_CMUX_RENAME_WORKSPACE` is set to any of
 * `0`, `false`, `no` (case-insensitive). Default: enabled.
 */
export function resolveRenameWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env["PI_CMUX_RENAME_WORKSPACE"];
	if (raw === undefined) return true;
	const normalised = raw.toLowerCase();
	return !["0", "false", "no"].includes(normalised);
}

/**
 * Optional override for the model used to summarise the first user prompt
 * into tab + workspace names. Expected format: `"provider:modelId"`.
 * Returns `undefined` when unset or malformed (i.e. missing colon) so the
 * caller falls back to `ctx.model`.
 */
export function resolveSummaryModelOverride(
	env: NodeJS.ProcessEnv = process.env,
): { provider: string; modelId: string } | undefined {
	const raw = env["PI_CMUX_SUMMARY_MODEL"];
	if (!raw || !raw.includes(":")) return undefined;
	const [provider, ...rest] = raw.split(":");
	const modelId = rest.join(":");
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}
