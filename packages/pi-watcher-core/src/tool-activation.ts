/**
 * Tool-activation helpers shared across pi watcher extensions.
 *
 * Extracted from pi-aws-glue-watcher so that any watcher can share the
 * reconcile logic without re-implementing it.
 *
 * Design note: `addToolToActive` / `removeToolFromActive` are intentionally
 * idempotent — calling them when the tool is already in / out of the set is
 * a no-op.
 */

/** Minimal pi API shape needed by the activation helpers. */
export interface PiToolsLike {
	getActiveTools(): string[];
	setActiveTools(tools: string[]): void;
}

/**
 * Determine the corrective action (if any) when `rt.enabled` and the
 * active-tools list disagree.
 *
 * - `"activate"`   — tool is in the active set but `enabled` is false.
 * - `"deactivate"` — tool is not in the active set but `enabled` is true.
 * - `"noop"`       — states already agree.
 */
export type ReconcileIntent = "activate" | "deactivate" | "noop";

export function reconcileToolActivation(
	toolName: string,
	enabled: boolean,
	activeTools: readonly string[],
): ReconcileIntent {
	const isActive = activeTools.includes(toolName);
	if (isActive === enabled) return "noop";
	return isActive ? "activate" : "deactivate";
}

/** Add `toolName` to the active set. Idempotent. */
export function addToolToActive(pi: PiToolsLike, toolName: string): void {
	const current = pi.getActiveTools();
	if (!current.includes(toolName)) {
		pi.setActiveTools([...current, toolName]);
	}
}

/** Remove `toolName` from the active set. Idempotent. */
export function removeToolFromActive(pi: PiToolsLike, toolName: string): void {
	pi.setActiveTools(pi.getActiveTools().filter((t) => t !== toolName));
}

/**
 * Sync `toolName`'s active-set membership with `enabled`.
 * Called from `session_start` to restore the persisted state after a restart.
 */
export function syncToolActiveState(
	pi: PiToolsLike,
	toolName: string,
	enabled: boolean,
): void {
	if (enabled) addToolToActive(pi, toolName);
	else removeToolFromActive(pi, toolName);
}
