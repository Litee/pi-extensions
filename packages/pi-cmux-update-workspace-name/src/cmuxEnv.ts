/**
 * `cmuxAvailable` — env-var gate for whether we are running inside a cmux
 * session. Extracted into its own file so `cmuxSpawner.ts` (the live-IO
 * module excluded from coverage) can import it without dragging the full
 * `cmux.ts` surface into an import cycle.
 */

export function cmuxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!env["CMUX_WORKSPACE_ID"]) return false;
	if (!env["CMUX_TAB_ID"] && !env["CMUX_SURFACE_ID"]) return false;
	return true;
}
