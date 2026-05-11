/**
 * Session-log persistence for pi-archon-workflow-watcher.
 * Merges the former STATE + RUNSTATE two-entry scheme into a single combined
 * entry via pi-watcher-core createPersistence.
 */
import { createPersistence } from "pi-watcher-core/persistence";
export type { SessionLike } from "pi-watcher-core/persistence";

import type { RunSnapshot } from "./types.js";

/** Combined-state customType. Kept identical to the old STATE_ENTRY_TYPE value. */
export const STATE_ENTRY_TYPE = "pi-archon-workflow-watcher:state";

const _persistence = createPersistence<string[], RunSnapshot>({
	stateCustomType: STATE_ENTRY_TYPE,
	watchItemsKey: "watchedIds",
	normaliseItems: (raw: unknown): string[] =>
		Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [],
	normaliseBaselines: (raw: unknown): RunSnapshot => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return raw as RunSnapshot;
	},
});

export interface RehydratedState {
	savedAt: number;
	watchedIds: string[];
	snapshot: RunSnapshot;
	paused: boolean;
}

/**
 * Walk the session log newest-to-oldest and return the first valid combined
 * state entry, or null if none found.
 */
export function rehydrateStateFromSession(
	ctx: import("pi-watcher-core/persistence").SessionLike,
): RehydratedState | null {
	const state = _persistence.rehydrateStateFromSession(ctx);
	if (state === null) return null;
	return {
		savedAt: state.savedAt,
		watchedIds: state.items,
		snapshot: state.baselines,
		paused: state.paused,
	};
}

/**
 * Write a combined state entry (watchedIds + snapshot + paused). Best-effort.
 */
export function writeState(
	pi: { appendEntry(customType: string, data: unknown): void },
	opts: { snapshot: RunSnapshot; watchedIds: Iterable<string>; paused: boolean },
): void {
	_persistence.writeState(pi, {
		items: [...opts.watchedIds],
		paused: opts.paused,
		baselines: opts.snapshot,
	});
}
