import type { IssueInfo, Snapshot } from "./types.js";

/** Key used with `pi.appendEntry(...)` / session custom entries. */
export const STATE_ENTRY_TYPE = "issue-watcher-state";

/** Maximum age at which a persisted snapshot is still trusted as baseline. */
export const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — matches watch_issues.py

/** Shape of the `data` payload we store via `pi.appendEntry`. */
export interface PersistedState {
	/** Epoch ms at which the snapshot was captured. */
	savedAt: number;
	snapshot: Snapshot;
}

/**
 * Minimal `ctx` surface we need from pi's session manager. Kept narrow so the
 * test double in `persistence.test.ts` can supply a plain object.
 */
export interface SessionLike {
	sessionManager: {
		getEntries(): Array<{ type?: string; customType?: string; data?: unknown }>;
	};
}

interface RawIssueInfo {
	mtimeNs?: bigint | string | number;
	issueId?: string;
	status?: string;
	title?: string;
	description?: string;
	comments?: IssueInfo["comments"];
	skill?: string;
	skillVersion?: string;
}

/**
 * Walk the session entry log newest → oldest. Return the first entry whose
 * `customType === STATE_ENTRY_TYPE` and whose `savedAt` is within
 * `STATE_MAX_AGE_MS`. Returns `null` otherwise.
 *
 * `mtimeNs` is re-hydrated back to `bigint` because `appendEntry` typically
 * round-trips through JSON where bigint is serialised as a string.
 */
export function rehydrateFromSession(ctx: SessionLike): PersistedState | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || e.type !== "custom" || e.customType !== STATE_ENTRY_TYPE) continue;
		const data = e.data as Partial<PersistedState> | undefined;
		if (!data || typeof data !== "object") {
			// eslint-disable-next-line no-console
			console.warn(`[issue-watcher] persisted entry missing data`);
			return null;
		}
		const savedAt = typeof data.savedAt === "number" ? data.savedAt : NaN;
		const snapshotRaw = data.snapshot;
		if (!Number.isFinite(savedAt) || typeof snapshotRaw !== "object" || snapshotRaw === null) {
			// eslint-disable-next-line no-console
			console.warn(`[issue-watcher] persisted entry malformed; ignoring`);
			return null;
		}
		if (Date.now() - savedAt > STATE_MAX_AGE_MS) return null;
		return { savedAt, snapshot: normaliseSnapshot(snapshotRaw as Record<string, RawIssueInfo>) };
	}
	return null;
}

function normaliseSnapshot(raw: Record<string, RawIssueInfo>): Snapshot {
	const out: Snapshot = {};
	for (const [path, info] of Object.entries(raw)) {
		if (!info || typeof info !== "object") continue;
		out[path] = {
			mtimeNs: toBigint(info.mtimeNs),
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

function toBigint(v: bigint | string | number | undefined): bigint {
	if (typeof v === "bigint") return v;
	if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
	if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
	return 0n;
}
