/**
 * Session-log persistence for pi-aws-s3-watcher.
 * Delegates to pi-watcher-core createPersistence.
 */
import { createPersistence, toFiniteNumber } from "pi-watcher-core/persistence";
export type { SessionLike } from "pi-watcher-core/persistence";

import type { S3Baseline, S3Watch, TargetCondition, WatchMap } from "./types.js";

export const STATE_CUSTOM_TYPE = "pi-aws-s3-watcher:state";

/**
 * Baselines payload: enabled + displayMode.
 */
type Baselines = { enabled: boolean; displayMode: "widget" | "statusline" };

const _persistence = createPersistence<S3Watch[], Baselines>({
	stateCustomType: STATE_CUSTOM_TYPE,
	watchItemsKey: "watches",
	normaliseItems: _normaliseWatchArray,
	normaliseBaselines: (raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { enabled: false, displayMode: "widget" };
		const r = raw as Record<string, unknown>;
		return {
			enabled: typeof r["enabled"] === "boolean" ? r["enabled"] : false,
			displayMode: r["displayMode"] === "statusline" ? "statusline" : "widget",
		};
	},
});

export interface HydratedState {
	savedAt: number;
	paused: boolean;
	enabled: boolean;
	displayMode: "widget" | "statusline";
	watches: WatchMap;
}

export function rehydrateStateFromSession(
	ctx: import("pi-watcher-core/persistence").SessionLike,
): HydratedState | null {
	const state = _persistence.rehydrateStateFromSession(ctx);
	if (state === null) return null;
	return {
		savedAt: state.savedAt,
		paused: state.paused,
		enabled: state.baselines.enabled,
		displayMode: state.baselines.displayMode,
		watches: _toWatchMap(state.items),
	};
}

export function writeState(
	pi: { appendEntry(customType: string, data: unknown): void },
	snapshot: { paused: boolean; enabled: boolean; watches: WatchMap; displayMode: "widget" | "statusline" },
): void {
	_persistence.writeState(pi, {
		items: Object.values(snapshot.watches),
		paused: snapshot.paused,
		baselines: { enabled: snapshot.enabled, displayMode: snapshot.displayMode },
	});
}

function _toWatchMap(watches: S3Watch[]): WatchMap {
	const out: WatchMap = {};
	for (const w of watches) out[w.watchId] = w;
	return out;
}

function _normaliseWatchArray(raw: unknown): S3Watch[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((v) => {
		const w = _normaliseWatch(v);
		return w ? [w] : [];
	});
}

const TARGETS: ReadonlySet<TargetCondition> = new Set<TargetCondition>([
	"exists",
	"updated",
	"removed",
]);

function _normaliseWatch(v: unknown): S3Watch | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const r = v as Record<string, unknown>;
	if (
		typeof r["watchId"] !== "string" ||
		typeof r["bucket"] !== "string" ||
		typeof r["key"] !== "string" ||
		typeof r["profile"] !== "string"
	) {
		return null;
	}
	const target = r["target"];
	if (typeof target !== "string" || !TARGETS.has(target as TargetCondition)) {
		return null;
	}
	return {
		watchId: r["watchId"],
		bucket: r["bucket"],
		key: r["key"],
		profile: r["profile"],
		region: typeof r["region"] === "string" ? r["region"] : undefined,
		target: target as TargetCondition,
		timeoutAt:
			typeof r["timeoutAt"] === "number" && Number.isFinite(r["timeoutAt"])
				? r["timeoutAt"]
				: undefined,
		addedAt: toFiniteNumber(r["addedAt"]),
		lastPolledAt:
			typeof r["lastPolledAt"] === "number" ? r["lastPolledAt"] : undefined,
		baseline: _normaliseBaseline(r["baseline"]),
		terminal: typeof r["terminal"] === "boolean" ? r["terminal"] : false,
		consecutiveErrors:
			typeof r["consecutiveErrors"] === "number" && Number.isFinite(r["consecutiveErrors"])
				? r["consecutiveErrors"]
				: 0,
	};
}

function _normaliseBaseline(raw: unknown): S3Baseline | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r["exists"] !== "boolean") return undefined;
	const b: S3Baseline = { exists: r["exists"] };
	if (typeof r["etag"] === "string") b.etag = r["etag"];
	if (typeof r["contentLength"] === "number" && Number.isFinite(r["contentLength"])) {
		b.contentLength = r["contentLength"];
	}
	return b;
}
