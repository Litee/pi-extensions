/**
 * Session-log persistence helpers.
 *
 * The extension writes a single combined state entry on every mutation via
 * `pi.appendEntry`:
 *
 *   - {@link STATE_CUSTOM_TYPE} — `{ savedAt, enabled, paused, watches }`.
 *     No TTL — an explicit pause or a weeks-old watch list sticks until
 *     overwritten.
 *
 * Rehydration walks the session log newest-to-oldest and returns the first
 * entry that passes schema checks. Malformed entries are warned and skipped
 * so a single bad write never discards older valid state.
 */

import type { WatchMap } from "./types.js";

/** Combined-state customType. Package-name prefix avoids namespace collisions. */
export const STATE_CUSTOM_TYPE = "pi-aws-glue-watcher:state";

/**
 * Narrow session-manager shape the rehydrator needs. Tests supply a plain
 * object with a single `getEntries` method — no full `SessionManager` needed.
 */
export interface SessionLike {
	sessionManager: {
		getEntries(): Array<{
			type?: string;
			customType?: string;
			data?: unknown;
		}>;
	};
}

/** Shape of the `data` payload on each combined-state entry. */
export interface PersistedState {
	savedAt: number;
	enabled: boolean;
	paused: boolean;
	watches: WatchMap;
}

/** Rehydrated in-memory state — same shape as persisted. */
export interface HydratedState {
	savedAt: number;
	enabled: boolean;
	paused: boolean;
	watches: WatchMap;
}

/**
 * Walk the session log newest-to-oldest and return the first valid state
 * entry. Malformed entries are skipped with a warning; `null` means "no
 * usable state — treat as first run" (enabled=false, paused=false,
 * watches={}).
 */
export function rehydrateStateFromSession(ctx: SessionLike): HydratedState | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) {
			continue;
		}
		const data = entry.data as Partial<PersistedState> | undefined;
		if (!data || typeof data !== "object") {
			// eslint-disable-next-line no-console
			console.warn("[glue-watcher] persisted state entry missing data");
			continue;
		}
		const savedAt = typeof data.savedAt === "number" ? data.savedAt : NaN;
		if (!Number.isFinite(savedAt)) {
			// eslint-disable-next-line no-console
			console.warn("[glue-watcher] persisted state entry has invalid savedAt");
			continue;
		}
		if (typeof data.enabled !== "boolean") {
			// eslint-disable-next-line no-console
			console.warn("[glue-watcher] persisted state entry has invalid enabled");
			continue;
		}
		if (typeof data.paused !== "boolean") {
			// eslint-disable-next-line no-console
			console.warn("[glue-watcher] persisted state entry has invalid paused");
			continue;
		}
		return {
			savedAt,
			enabled: data.enabled,
			paused: data.paused,
			watches: normaliseWatches(data.watches),
		};
	}
	return null;
}

/**
 * Append a combined-state entry. Best-effort — persistence failures are
 * swallowed so a broken session log never blocks a user-facing action.
 */
export function writeState(
	pi: { appendEntry: (customType: string, data: unknown) => void },
	snapshot: { enabled: boolean; paused: boolean; watches: WatchMap },
): void {
	try {
		pi.appendEntry(STATE_CUSTOM_TYPE, {
			savedAt: Date.now(),
			enabled: snapshot.enabled,
			paused: snapshot.paused,
			watches: snapshot.watches,
		} satisfies PersistedState);
	} catch {
		/* swallow — state persistence is best-effort */
	}
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Coerce a raw JSON value (from the session log) back into a typed
 * {@link WatchMap}. Entries that are missing required fields are silently
 * dropped so a partially-corrupted map never crashes the extension.
 */
export function normaliseWatches(raw: unknown): WatchMap {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: WatchMap = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const v = value as Record<string, unknown>;
		if (
			typeof v["watchId"] !== "string" ||
			(v["type"] !== "job" && v["type"] !== "workflow") ||
			typeof v["name"] !== "string" ||
			typeof v["runId"] !== "string" ||
			typeof v["profile"] !== "string"
		) {
			continue;
		}
		out[key] = {
			watchId: v["watchId"] as string,
			type: v["type"] as "job" | "workflow",
			name: v["name"] as string,
			runId: v["runId"] as string,
			profile: v["profile"] as string,
			region: typeof v["region"] === "string" ? v["region"] : undefined,
			addedAt: typeof v["addedAt"] === "number" ? v["addedAt"] : 0,
			lastPolledAt: typeof v["lastPolledAt"] === "number" ? v["lastPolledAt"] : undefined,
			baseline:
				v["baseline"] !== null &&
				v["baseline"] !== undefined &&
				typeof v["baseline"] === "object" &&
				!Array.isArray(v["baseline"])
					? (v["baseline"] as import("./types.js").WatchBaseline)
					: undefined,
			terminal: typeof v["terminal"] === "boolean" ? v["terminal"] : false,
			consecutiveErrors: typeof v["consecutiveErrors"] === "number" && Number.isFinite(v["consecutiveErrors"]) ? v["consecutiveErrors"] : 0,
		};
	}
	return out;
}
