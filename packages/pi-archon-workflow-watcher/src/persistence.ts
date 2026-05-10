import type { RunSnapshot } from "./types.js";

export const STATE_ENTRY_TYPE = "pi-archon-workflow-watcher:state";
export const RUNSTATE_ENTRY_TYPE = "pi-archon-workflow-watcher:runstate";

export interface SessionLike {
	sessionManager: {
		getEntries(): Array<{ type?: string; customType?: string; data?: unknown }>;
	};
}

export interface PersistedState {
	savedAt: number;
	snapshot: RunSnapshot;
	/** Explicitly watched run IDs — no TTL, sticky until removed. */
	watchedIds: string[];
}

export interface RehydratedState {
	savedAt: number;
	snapshot: RunSnapshot;
	watchedIds: string[];
}

export interface PersistedRunState {
	savedAt: number;
	paused: boolean;
}

export interface RehydratedRunState {
	savedAt: number;
	paused: boolean;
}

/**
 * Walk the session entry log newest → oldest and return the first valid
 * state entry. No TTL — watchedIds must survive across sessions.
 * Returns null when no entry has been written yet.
 */
export function rehydrateSnapshotFromSession(
	ctx: SessionLike,
): RehydratedState | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || e.type !== "custom" || e.customType !== STATE_ENTRY_TYPE) continue;
		const data = e.data as Partial<PersistedState> | undefined;
		if (!data || typeof data !== "object") {
			console.warn("[archon-watcher] persisted state entry missing data");
			continue;
		}
		const savedAt = typeof data.savedAt === "number" ? data.savedAt : NaN;
		const snapshot = data.snapshot;
		if (
			!Number.isFinite(savedAt) ||
			typeof snapshot !== "object" ||
			snapshot === null
		) {
			console.warn("[archon-watcher] persisted state entry malformed; ignoring");
			continue;
		}
		const watchedIds = Array.isArray(data.watchedIds)
			? data.watchedIds.filter((id): id is string => typeof id === "string")
			: [];
		return { savedAt, snapshot: snapshot as RunSnapshot, watchedIds };
	}
	return null;
}

/**
 * Walk the session entry log newest → oldest and return the most recent
 * run-state entry. No TTL — an explicit pause preference is sticky until
 * the user resumes.
 */
export function rehydrateRunStateFromSession(
	ctx: SessionLike,
): RehydratedRunState | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || e.type !== "custom" || e.customType !== RUNSTATE_ENTRY_TYPE) continue;
		const data = e.data as Partial<PersistedRunState> | undefined;
		if (!data || typeof data !== "object") {
			console.warn("[archon-watcher] persisted run-state entry missing data");
			continue;
		}
		const savedAt = typeof data.savedAt === "number" ? data.savedAt : NaN;
		if (!Number.isFinite(savedAt) || typeof data.paused !== "boolean") {
			console.warn("[archon-watcher] persisted run-state entry malformed; ignoring");
			continue;
		}
		return { savedAt, paused: data.paused };
	}
	return null;
}

export function writeSnapshot(
	pi: { appendEntry(type: string, data: unknown): void },
	snapshot: RunSnapshot,
	watchedIds: Set<string>,
): void {
	try {
		pi.appendEntry(STATE_ENTRY_TYPE, {
			savedAt: Date.now(),
			snapshot,
			watchedIds: [...watchedIds],
		} satisfies PersistedState);
	} catch {
		/* noop — persistence is best-effort */
	}
}

export function writeRunState(
	pi: { appendEntry(type: string, data: unknown): void },
	paused: boolean,
): void {
	try {
		pi.appendEntry(RUNSTATE_ENTRY_TYPE, { savedAt: Date.now(), paused });
	} catch {
		/* noop — persistence is best-effort */
	}
}
