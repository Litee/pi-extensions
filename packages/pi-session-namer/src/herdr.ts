/**
 * Pure herdr CLI helpers — no pi imports.
 * Accept an injected `ExecFn` for testability.
 */

/** Minimal exec abstraction used by the herdr helpers. */
export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: { timeout?: number },
) => Promise<{ code: number; stdout: string; stderr?: string }>;

// ---------------------------------------------------------------------------
// Internal JSON shape for `herdr pane get`
// ---------------------------------------------------------------------------

interface HerdrPaneGetResult {
	result: {
		pane: {
			workspace_id: string;
		};
	};
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when running inside herdr (`HERDR_ENV === "1"`).
 * Pass `process.env` (or a test-controlled object) as `env`.
 */
export function isInsideHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
	return env["HERDR_ENV"] === "1";
}

/**
 * Resolve the workspace ID that owns the current pi agent process.
 *
 * Calls `herdr pane get <HERDR_PANE_ID>` — herdr accepts the env-var value
 * directly as a pane identifier and returns the pane's stable `workspace_id`
 * hash (e.g. `w652f1910e89a56`). This is the only reliable approach because:
 *
 * - Workspace `number` fields compact when workspaces are closed, so the
 *   number stored in `HERDR_PANE_ID` (e.g. the `6` in `p_6`) no longer
 *   maps to the same workspace after any workspace is closed or opened.
 * - `focused` reflects what the user is looking at in the UI, which may
 *   differ from where the agent process lives.
 *
 * Returns `null` if `HERDR_PANE_ID` is absent, exec throws, the exit code
 * is non-zero, or the response JSON is malformed.
 */
export async function resolveWorkspaceId(
	exec: ExecFn,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
	const paneId = env["HERDR_PANE_ID"];
	if (!paneId) return null;

	let stdout: string;
	try {
		const result = await exec("herdr", ["pane", "get", paneId], { timeout: 5000 });
		if (result.code !== 0) return null;
		stdout = result.stdout;
	} catch {
		return null;
	}

	try {
		const parsed = JSON.parse(stdout) as HerdrPaneGetResult;
		const wsId = parsed?.result?.pane?.workspace_id;
		return typeof wsId === "string" && wsId.length > 0 ? wsId : null;
	} catch {
		return null;
	}
}

/**
 * Rename a herdr workspace by calling `herdr workspace rename <id> <name>`.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on failure.
 */
export async function renameWorkspace(
	exec: ExecFn,
	workspaceId: string,
	name: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		const result = await exec("herdr", ["workspace", "rename", workspaceId, name], { timeout: 5000 });
		if (result.code !== 0) {
			const reason =
				result.stderr?.trim()
					? result.stderr.trim()
					: `exit code ${result.code}`;
			return { ok: false, reason };
		}
		return { ok: true };
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		return { ok: false, reason };
	}
}
