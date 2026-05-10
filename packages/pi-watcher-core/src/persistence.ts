/**
 * Generic session-log persistence layer for pi watcher extensions.
 *
 * Each watcher appends a combined-state entry (via `pi.appendEntry`) when
 * state mutates, and rehydrates it on `session_start`. This module provides
 * the shared scaffolding; callers supply type-safe `normalise*` callbacks for
 * their domain-specific item and baseline shapes.
 *
 * Design mirrors the ticket-watcher implementation:
 *   - Walk entries newest → oldest.
 *   - Validate `savedAt` (finite number), `paused` (boolean), and the items
 *     array key (is array).
 *   - Skip malformed entries silently; never discard older valid
 *     state because of a single bad write.
 *   - Best-effort writes — errors from `pi.appendEntry` are swallowed so a
 *     broken session log never blocks user-facing actions.
 */

/** Narrow session-manager shape the rehydrator needs. Tests supply a plain stub. */
export interface SessionLike {
	sessionManager: {
		getEntries(): Array<{
			type?: string;
			customType?: string;
			data?: unknown;
		}>;
	};
}

export interface PersistenceOptions<TWatchItems, TBaselines> {
	/** customType written on every state entry. Package-name prefix avoids collisions. */
	stateCustomType: string;
	/**
	 * Key name used to store the watch items in the persisted data object.
	 * E.g. `"tickets"`, `"reviews"`, `"pipelines"`.
	 */
	watchItemsKey: string;
	/** Coerce the raw persisted items value to the correct domain shape. */
	normaliseItems: (raw: unknown) => TWatchItems;
	/** Coerce the raw persisted baselines map to the correct domain shape. */
	normaliseBaselines: (raw: unknown) => TBaselines;
	/**
	 * Optional callback for malformed session-log entries. Called once per
	 * skipped entry with a short reason string. Useful for routing to
	 * `pi.appendEntry` so corruption is recorded without leaking to stdout.
	 */
	onMalformed?: (reason: string) => void;
	/**
	 * Optional observability hook invoked when `writeState`'s call to
	 * `pi.appendEntry` throws. `writeState` remains best-effort — the error
	 * is never re-thrown regardless of whether `onError` is provided. The
	 * library deliberately does NOT log to stdout/stderr; callers wire this
	 * sink to `ctx.ui.notify` / `pi.appendEntry` at the extension layer.
	 *
	 * Complements `onMalformed` (schema-validation failures on READ) by
	 * covering the WRITE path (`pi.appendEntry` throwing).
	 */
	onError?: (err: Error) => void;
}

export interface PersistedState<TWatchItems, TBaselines> {
	savedAt: number;
	paused: boolean;
	items: TWatchItems;
	baselines: TBaselines;
}

export interface Persistence<TWatchItems, TBaselines> {
	/** The customType used by this persistence instance. */
	readonly STATE_CUSTOM_TYPE: string;
	/**
	 * Walk the session log newest → oldest and return the first valid combined
	 * state entry, or `null` if none are found or all are malformed.
	 */
	rehydrateStateFromSession(
		ctx: SessionLike,
	): PersistedState<TWatchItems, TBaselines> | null;
	/**
	 * Append a combined-state entry. Best-effort — errors from `appendEntry`
	 * are swallowed so persistence failures never block user-facing actions.
	 */
	writeState(
		pi: { appendEntry(customType: string, data: unknown): void },
		snapshot: { items: TWatchItems; paused: boolean; baselines: TBaselines },
	): void;
}

/**
 * Create a persistence helper for a specific watcher's state shape.
 *
 * The returned object is stateless — it reads from / writes to the pi session
 * log but holds no mutable state of its own.
 */
export function createPersistence<TWatchItems, TBaselines>(
	opts: PersistenceOptions<TWatchItems, TBaselines>,
): Persistence<TWatchItems, TBaselines> {
	const { stateCustomType, watchItemsKey, normaliseItems, normaliseBaselines, onMalformed, onError } = opts;

	function rehydrateStateFromSession(
		ctx: SessionLike,
	): PersistedState<TWatchItems, TBaselines> | null {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				!entry ||
				entry.type !== "custom" ||
				entry.customType !== stateCustomType
			) {
				continue;
			}
			const data = entry.data as Record<string, unknown> | undefined;
			if (!data || typeof data !== "object") {
				onMalformed?.(`[${stateCustomType}] persisted state entry missing data`);
				continue;
			}
			const savedAt =
				typeof data["savedAt"] === "number" ? data["savedAt"] : NaN;
			if (!Number.isFinite(savedAt)) {
				onMalformed?.(`[${stateCustomType}] persisted state entry has invalid savedAt`);
				continue;
			}
			if (typeof data["paused"] !== "boolean") {
				onMalformed?.(`[${stateCustomType}] persisted state entry has invalid paused`);
				continue;
			}
			const rawItems = data[watchItemsKey];
			if (!Array.isArray(rawItems)) {
				onMalformed?.(`[${stateCustomType}] persisted state entry has invalid ${watchItemsKey}`);
				continue;
			}
			return {
				savedAt,
				paused: data["paused"],
				items: normaliseItems(rawItems),
				baselines: normaliseBaselines(data["baselines"]),
			};
		}
		return null;
	}

	function writeState(
		pi: { appendEntry(customType: string, data: unknown): void },
		snapshot: { items: TWatchItems; paused: boolean; baselines: TBaselines },
	): void {
		try {
			pi.appendEntry(stateCustomType, {
				savedAt: Date.now(),
				[watchItemsKey]: snapshot.items,
				paused: snapshot.paused,
				baselines: snapshot.baselines,
			});
		} catch (err) {
			/* swallow — state persistence is best-effort. Surface to observability
			   sink if provided; never log to stdout/stderr (see AGENTS.md). */
			if (onError) {
				onError(err instanceof Error ? err : new Error(String(err)));
			}
		}
	}

	return {
		STATE_CUSTOM_TYPE: stateCustomType,
		rehydrateStateFromSession,
		writeState,
	};
}

// ---------------------------------------------------------------------------
// Shared coercion helpers used by normalise* callbacks
// ---------------------------------------------------------------------------

/** Coerce a value to a finite float. Non-numeric / undefined → 0. */
export function toFiniteNumber(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number.parseFloat(v);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

/** Coerce a value to a string, returning `fallback` (default `""`) for non-strings. */
export function coerceString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}
