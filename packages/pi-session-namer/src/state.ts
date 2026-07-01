/**
 * Session-state persistence helpers for pi-herdr-integration.
 * No pi runtime imports — pure data helpers.
 */

/** Custom type key used when persisting state to the session log. */
export const STATE_CUSTOM_TYPE = "pi-herdr-integration:state";

/** Shape of the persisted state payload. */
export interface HerdrIntegrationState {
	lastAppliedName: string;
	herdrWorkspaceId: string;
	appliedAt: number;
}

/**
 * Minimal shape of a session entry we need to inspect.
 * Compatible with pi's `SessionEntry` (which is a superset).
 */
export interface StateCandidateEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Walk `entries` from newest (last) to oldest (first) and return the data of
 * the first entry whose `type === "custom"`, `customType === STATE_CUSTOM_TYPE`,
 * and `data.lastAppliedName` is a string.
 *
 * Returns `undefined` if no such entry exists.
 */
export function pickLatestState(
	entries: readonly StateCandidateEntry[],
): HerdrIntegrationState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
		const data = entry.data as Record<string, unknown> | null | undefined;
		if (data != null && typeof data["lastAppliedName"] === "string") {
			return data as unknown as HerdrIntegrationState;
		}
	}
	return undefined;
}
