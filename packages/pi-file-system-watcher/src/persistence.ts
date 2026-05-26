/**
 * Session-log persistence for pi-file-system-watcher.
 * Delegates to pi-watcher-core createPersistence.
 */
import { coerceString, createPersistence, toFiniteNumber } from "pi-watcher-core/persistence";
export type { SessionLike } from "pi-watcher-core/persistence";

import type { FsBaseline, FsWatch, TargetCondition, WatchMap, WatchMode } from "./types.js";

export const STATE_CUSTOM_TYPE = "pi-file-system-watcher:state";

type Baselines = { enabled: boolean; displayMode: "widget" | "statusline" };

const _persistence = createPersistence<FsWatch[], Baselines>({
	stateCustomType: STATE_CUSTOM_TYPE,
	watchItemsKey: "watches",
	normaliseItems: _normaliseWatchArray,
	normaliseBaselines: (raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return { enabled: false, displayMode: "widget" };
		}
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
	snapshot: {
		paused: boolean;
		enabled: boolean;
		watches: WatchMap;
		displayMode: "widget" | "statusline";
	},
): void {
	_persistence.writeState(pi, {
		items: Object.values(snapshot.watches),
		paused: snapshot.paused,
		baselines: { enabled: snapshot.enabled, displayMode: snapshot.displayMode },
	});
}

function _toWatchMap(watches: FsWatch[]): WatchMap {
	const out: WatchMap = {};
	for (const w of watches) out[w.watchId] = w;
	return out;
}

function _normaliseWatchArray(raw: unknown): FsWatch[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((v) => {
		const w = _normaliseWatch(v);
		return w ? [w] : [];
	});
}

const TARGETS: ReadonlySet<TargetCondition> = new Set<TargetCondition>([
	"exists",
	"changed",
	"removed",
]);

const MODES: ReadonlySet<WatchMode> = new Set<WatchMode>(["auto", "event", "poll"]);

function _normaliseWatch(v: unknown): FsWatch | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const r = v as Record<string, unknown>;
	if (typeof r["watchId"] !== "string" || typeof r["path"] !== "string") return null;

	const target = r["target"];
	if (typeof target !== "string" || !TARGETS.has(target as TargetCondition)) return null;

	const rawMode = r["mode"];
	const mode: WatchMode =
		typeof rawMode === "string" && MODES.has(rawMode as WatchMode)
			? (rawMode as WatchMode)
			: "auto";

	return {
		watchId: coerceString(r["watchId"]),
		path: coerceString(r["path"]),
		target: target as TargetCondition,
		mode,
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
			typeof r["consecutiveErrors"] === "number" &&
			Number.isFinite(r["consecutiveErrors"])
				? r["consecutiveErrors"]
				: 0,
	};
}

function _normaliseBaseline(raw: unknown): FsBaseline | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r["exists"] !== "boolean") return undefined;
	const b: FsBaseline = { exists: r["exists"] };
	// mtimeNs is serialised as a string (JSON cannot represent BigInt natively).
	if (typeof r["mtimeNs"] === "string" || typeof r["mtimeNs"] === "bigint") {
		try {
			b.mtimeNs = BigInt(r["mtimeNs"]);
		} catch {
			/* ignore invalid bigint */
		}
	}
	if (typeof r["size"] === "number" && Number.isFinite(r["size"])) {
		b.size = r["size"];
	}
	return b;
}
