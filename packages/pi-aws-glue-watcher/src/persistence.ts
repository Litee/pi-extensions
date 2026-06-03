/**
 * Session-log persistence for pi-aws-glue-watcher.
 * Delegates to pi-watcher-core createPersistence.
 */
import { createPersistence, toFiniteNumber } from "pi-watcher-core/persistence";
export type { SessionLike } from "pi-watcher-core/persistence";

import type { GlueWatch, WatchBaseline, WatchMap } from "./types.js";

export const STATE_CUSTOM_TYPE = "pi-aws-glue-watcher:state";

type Baselines = { enabled: boolean; displayMode: "widget" | "statusline" };

const _persistence = createPersistence<GlueWatch[], Baselines>({
	stateCustomType: STATE_CUSTOM_TYPE,
	watchItemsKey: "watches",
	normaliseItems: _normaliseWatchArray,
	normaliseBaselines: _normaliseBaselines,
});

export interface PersistedState {
	savedAt: number;
	enabled: boolean;
	watches: WatchMap;
	displayMode?: "widget" | "statusline";
}

export interface HydratedState {
	savedAt: number;
	enabled: boolean;
	watches: WatchMap;
	displayMode: "widget" | "statusline";
}

export function rehydrateStateFromSession(ctx: import("pi-watcher-core/persistence").SessionLike): HydratedState | null {
	const state = _persistence.rehydrateStateFromSession(ctx);
	if (state === null) return null;
	return {
		savedAt: state.savedAt,
		watches: _toWatchMap(state.items),
		enabled: state.baselines.enabled,
		displayMode: state.baselines.displayMode,
	};
}

export function writeState(
	pi: { appendEntry(customType: string, data: unknown): void },
	snapshot: { enabled: boolean; watches: WatchMap; displayMode: "widget" | "statusline" },
): void {
	_persistence.writeState(pi, {
		items: Object.values(snapshot.watches),
		baselines: { enabled: snapshot.enabled, displayMode: snapshot.displayMode },
	});
}

/**
 * Exported for tests that previously imported normaliseWatches.
 * Accepts either an array of watch entries or an object-shaped map.
 */
export function normaliseWatches(raw: unknown): WatchMap {
	return _toWatchMap(_normaliseWatchArray(
		raw && typeof raw === "object" && !Array.isArray(raw)
			? Object.values(raw as Record<string, unknown>)
			: Array.isArray(raw) ? raw : [],
	));
}

function _toWatchMap(watches: GlueWatch[]): WatchMap {
	const out: WatchMap = {};
	for (const w of watches) out[w.watchId] = w;
	return out;
}

function _normaliseBaselines(raw: unknown): Baselines {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { enabled: false, displayMode: "widget" };
	}
	const r = raw as Record<string, unknown>;
	return {
		enabled: typeof r["enabled"] === "boolean" ? r["enabled"] : false,
		displayMode: r["displayMode"] === "statusline" ? "statusline" : "widget",
	};
}

function _normaliseWatchArray(raw: unknown): GlueWatch[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((v) => {
		const w = _normaliseGlueWatch(v);
		return w ? [w] : [];
	});
}

function _normaliseGlueWatch(v: unknown): GlueWatch | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const r = v as Record<string, unknown>;
	if (
		typeof r["watchId"] !== "string" ||
		(r["type"] !== "job" && r["type"] !== "workflow") ||
		typeof r["name"] !== "string" ||
		typeof r["runId"] !== "string" ||
		typeof r["profile"] !== "string"
	) {
		return null;
	}
	return {
		watchId: r["watchId"],
		type: r["type"],
		name: r["name"],
		runId: r["runId"],
		profile: r["profile"],
		region: typeof r["region"] === "string" ? r["region"] : undefined,
		addedAt: toFiniteNumber(r["addedAt"]),
		lastPolledAt: typeof r["lastPolledAt"] === "number" ? r["lastPolledAt"] : undefined,
		baseline:
			r["baseline"] !== null &&
			r["baseline"] !== undefined &&
			typeof r["baseline"] === "object" &&
			!Array.isArray(r["baseline"])
				? (r["baseline"] as WatchBaseline)
				: undefined,
		terminal: typeof r["terminal"] === "boolean" ? r["terminal"] : false,
		consecutiveErrors:
			typeof r["consecutiveErrors"] === "number" && Number.isFinite(r["consecutiveErrors"])
				? r["consecutiveErrors"]
				: 0,
	};
}
