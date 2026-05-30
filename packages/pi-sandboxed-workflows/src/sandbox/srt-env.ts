/**
 * Pure env-merge helper for the srt sandbox provider. Extracted from
 * `srt.ts` so it can be unit-tested without standing up the actual srt
 * CLI (which `srt.ts` itself is coverage-excluded for).
 *
 * Why this exists
 * ---------------
 * `srt.ts` spawns child processes with
 * `env: { ...process.env, ...resolvedEnv }`. That blind merge causes a
 * real AWS SDK conflict: the parent (pi) often runs with `AWS_PROFILE`
 * set, and `getBedrockEnv()` injects static `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` into the child. The AWS SDK then logs
 *
 *   @aws-sdk/credential-provider-node - defaultProvider::fromEnv WARNING:
 *   Multiple credential sources detected: Both AWS_PROFILE and the pair
 *   AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY static credentials are set.
 *
 * to stderr. Claude Code (and likely other AWS-Bedrock-backed agents)
 * treats that stderr line as a fatal startup error and exits non-zero,
 * which kills the whole `/workflow:implement` run.
 *
 * Conflict resolution rule
 * ------------------------
 * If the child explicitly sets `AWS_ACCESS_KEY_ID`, drop `AWS_PROFILE`
 * and `AWS_DEFAULT_PROFILE` from the inherited parent env BEFORE merging
 * so the SDK only sees one credential signal. Anything else flows
 * through unchanged.
 *
 * If the child does NOT set `AWS_ACCESS_KEY_ID` (e.g. the workflow opts
 * into profile-based auth instead), the parent's `AWS_PROFILE` is
 * preserved as-is.
 *
 * The function is pure (no fs, no exec, no `process.env` reads except
 * via the explicit `parent` argument) so it is fully unit-testable.
 */

/**
 * Merge a parent process env with a per-exec child env, with AWS
 * credential conflict resolution. Returns a fresh `Record<string, string>`
 * suitable for passing to `child_process.spawn({ env })`.
 *
 * `undefined` values in `parent` (which `NodeJS.ProcessEnv` allows) are
 * skipped, so the result is a clean string-to-string map.
 */
export function mergeChildEnv(
	parent: NodeJS.ProcessEnv,
	child: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parent)) {
		if (v === undefined) continue;
		out[k] = v;
	}
	if (child["AWS_ACCESS_KEY_ID"] !== undefined) {
		// Static credentials in the child win unconditionally. Strip
		// profile-based signals from the parent to avoid the AWS SDK
		// "Multiple credential sources detected" warning that some
		// downstream tools treat as fatal.
		delete out["AWS_PROFILE"];
		delete out["AWS_DEFAULT_PROFILE"];
	}
	for (const [k, v] of Object.entries(child)) {
		out[k] = v;
	}
	return out;
}
