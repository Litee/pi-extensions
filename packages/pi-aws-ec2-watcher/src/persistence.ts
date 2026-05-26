/**
 * Session-log persistence for pi-aws-ec2-watcher.
 * Delegates to pi-watcher-core createPersistence.
 */
import { createPersistence, toFiniteNumber } from "pi-watcher-core/persistence";
export type { SessionLike } from "pi-watcher-core/persistence";

import type { Ec2Baseline, Ec2InstanceState, Ec2Watch, WatchMap } from "./types.js";

export const STATE_CUSTOM_TYPE = "pi-aws-ec2-watcher:state";

type Baselines = { enabled: boolean; displayMode: "widget" | "statusline" };

const _persistence = createPersistence<Ec2Watch[], Baselines>({
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

function _toWatchMap(watches: Ec2Watch[]): WatchMap {
	const out: WatchMap = {};
	for (const w of watches) out[w.watchId] = w;
	return out;
}

function _normaliseWatchArray(raw: unknown): Ec2Watch[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((v) => {
		const w = _normaliseWatch(v);
		return w ? [w] : [];
	});
}

const VALID_STATES: ReadonlySet<Ec2InstanceState> = new Set<Ec2InstanceState>([
	"pending",
	"running",
	"shutting-down",
	"terminated",
	"stopping",
	"stopped",
]);

function _normaliseWatch(v: unknown): Ec2Watch | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const r = v as Record<string, unknown>;
	if (
		typeof r["watchId"] !== "string" ||
		typeof r["instanceId"] !== "string" ||
		typeof r["profile"] !== "string"
	) {
		return null;
	}
	return {
		watchId: r["watchId"],
		instanceId: r["instanceId"],
		profile: r["profile"],
		region: typeof r["region"] === "string" ? r["region"] : undefined,
		stopOnStopped: typeof r["stopOnStopped"] === "boolean" ? r["stopOnStopped"] : false,
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

function _normaliseBaseline(raw: unknown): Ec2Baseline | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r["state"] !== "string" || !VALID_STATES.has(r["state"] as Ec2InstanceState)) {
		return undefined;
	}
	const b: Ec2Baseline = { state: r["state"] as Ec2InstanceState };
	if (typeof r["nameTag"] === "string") b.nameTag = r["nameTag"];
	if (typeof r["stateTransitionReason"] === "string") {
		b.stateTransitionReason = r["stateTransitionReason"];
	}
	if (typeof r["availabilityZone"] === "string") b.availabilityZone = r["availabilityZone"];
	if (typeof r["instanceType"] === "string") b.instanceType = r["instanceType"];
	return b;
}
