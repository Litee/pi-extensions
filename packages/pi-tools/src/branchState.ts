import type { SessionEntry } from "@mariozechner/pi-coding-agent";

/** Shape of the `tools-config` custom entry payload persisted by pi-tools. */
export interface ToolsState {
	enabledTools: string[];
}

/** Custom-entry type string used to tag tool-enablement snapshots. */
export const TOOLS_CONFIG_CUSTOM_TYPE = "tools-config";

/**
 * Walk branch entries in order and return the most recently persisted
 * `tools-config` payload, if any.
 *
 * Pure: no pi/session side effects. Callers are responsible for intersecting
 * the returned list with the currently-registered tool names before calling
 * `pi.setActiveTools`.
 *
 * Returns:
 *   - `undefined` when no tools-config entry exists (fall back to
 *     `pi.getActiveTools()` in the caller);
 *   - an array (possibly empty) when a tools-config entry is found.
 */
export function pickSavedTools(branchEntries: SessionEntry[]): string[] | undefined {
	let savedTools: string[] | undefined;
	for (const entry of branchEntries) {
		if (entry.type === "custom" && entry.customType === TOOLS_CONFIG_CUSTOM_TYPE) {
			const data = (entry as { data?: unknown }).data as ToolsState | undefined;
			if (data?.enabledTools) {
				savedTools = data.enabledTools;
			}
		}
	}
	return savedTools;
}
