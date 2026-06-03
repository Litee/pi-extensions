/**
 * Session-log persistence for pi-local-issue-watcher.
 * Uses two createPersistence instances: one for the snapshot baseline
 * (with a 24h TTL applied by the caller) and one for the paused/running
 * run state (sticky, no TTL).
 *
 * Migration note: the legacy entry types
 *   issue-watcher-state / local-issue-watcher-state / pi-local-issue-watcher-state
 *   issue-watcher-runstate / local-issue-watcher-runstate / pi-local-issue-watcher-runstate
 * are no longer read. Sessions written before this migration will not
 * rehydrate; the watcher starts fresh (24h TTL already guarantees this
 * for snapshot; paused state defaults to false on clean start).
 */
import { createPersistence } from "pi-watcher-core/persistence";
export type { SessionLike } from "pi-watcher-core/persistence";

import type { IssueInfo, Snapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const STATE_ENTRY_TYPE = "pi-local-issue-watcher:state";

export const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Serialised shapes (JSON-safe)
// ---------------------------------------------------------------------------

export interface SerialisedIssueInfo {
	mtimeNs: string;
	issueId: string;
	status: string;
	title: string;
	description: string;
	comments: IssueInfo["comments"];
	skill: string;
	skillVersion: string;
}
export type SerialisedSnapshot = Record<string, SerialisedIssueInfo>;

// ---------------------------------------------------------------------------
// In-memory shapes returned to callers
// ---------------------------------------------------------------------------

export interface RehydratedState {
	savedAt: number;
	snapshot: Snapshot;
}

// ---------------------------------------------------------------------------
// Persistence instances
// ---------------------------------------------------------------------------

const _snapshotPersistence = createPersistence<SerialisedSnapshot, Record<string, never>>({
	stateCustomType: STATE_ENTRY_TYPE,
	watchItemsKey: "snapshot",
	normaliseItems: _normaliseSnapshotItems,
	normaliseBaselines: () => ({}),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rehydrate snapshot from session. Returns null when no valid entry is found
 * OR when the entry is older than STATE_MAX_AGE_MS.
 */
export function rehydrateFromSession(
	ctx: import("pi-watcher-core/persistence").SessionLike,
): RehydratedState | null {
	const state = _snapshotPersistence.rehydrateStateFromSession(ctx);
	if (state === null) return null;
	if (Date.now() - state.savedAt > STATE_MAX_AGE_MS) return null;
	return {
		savedAt: state.savedAt,
		snapshot: _deserialiseSnapshot(state.items),
	};
}

/**
 * Write a new snapshot baseline entry. Best-effort.
 */
export function persistSnapshot(
	pi: { appendEntry(customType: string, data: unknown): void },
	snapshot: Snapshot,
): void {
	_snapshotPersistence.writeState(pi, {
		// Stored as Object.entries([path, info][]); normaliseItems reconstructs the record on read.
		items: Object.entries(_serialiseSnapshot(snapshot)) as unknown as SerialisedSnapshot,
		baselines: {},
	});
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function _serialiseSnapshot(snap: Snapshot): SerialisedSnapshot {
	const out: SerialisedSnapshot = {};
	for (const [path, info] of Object.entries(snap)) {
		out[path] = { ...info, mtimeNs: info.mtimeNs.toString() };
	}
	return out;
}

function _deserialiseSnapshot(snap: SerialisedSnapshot): Snapshot {
	const out: Snapshot = {};
	for (const [path, info] of Object.entries(snap)) {
		if (!info || typeof info !== "object") continue;
		out[path] = {
			mtimeNs: _toBigint(info.mtimeNs),
			issueId: typeof info.issueId === "string" ? info.issueId : "",
			status: typeof info.status === "string" ? info.status : "",
			title: typeof info.title === "string" ? info.title : "",
			description: typeof info.description === "string" ? info.description : "",
			comments: Array.isArray(info.comments) ? info.comments : [],
			skill: typeof info.skill === "string" ? info.skill : "",
			skillVersion: typeof info.skillVersion === "string" ? info.skillVersion : "",
		};
	}
	return out;
}

function _normaliseSnapshotItems(raw: unknown): SerialisedSnapshot {
	// Items are stored as Object.entries(serialisableSnapshot) — array of [path, info] tuples.
	if (!Array.isArray(raw)) return {};
	const out: SerialisedSnapshot = {};
	for (const entry of raw) {
		if (
			!Array.isArray(entry) ||
			entry.length < 2 ||
			typeof entry[0] !== "string" ||
			!entry[1] ||
			typeof entry[1] !== "object"
		) {
			continue;
		}
		const [path, rawInfo] = entry as [string, Record<string, unknown>];
		out[path] = {
			mtimeNs: typeof rawInfo["mtimeNs"] === "string" ? rawInfo["mtimeNs"] : "0",
			issueId: typeof rawInfo["issueId"] === "string" ? rawInfo["issueId"] : "",
			status: typeof rawInfo["status"] === "string" ? rawInfo["status"] : "",
			title: typeof rawInfo["title"] === "string" ? rawInfo["title"] : "",
			description: typeof rawInfo["description"] === "string" ? rawInfo["description"] : "",
			comments: Array.isArray(rawInfo["comments"]) ? rawInfo["comments"] as IssueInfo["comments"] : [],
			skill: typeof rawInfo["skill"] === "string" ? rawInfo["skill"] : "",
			skillVersion: typeof rawInfo["skillVersion"] === "string" ? rawInfo["skillVersion"] : "",
		};
	}
	return out;
}

function _toBigint(v: bigint | string | number | undefined): bigint {
	if (typeof v === "bigint") return v;
	if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
	if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
	return 0n;
}
