/**
 * Types shared across the pi-aws-s3-watcher modules.
 */

/** What the user is waiting for on a given S3 object. */
export type TargetCondition = "exists" | "updated" | "removed";

/**
 * Point-in-time observation of an S3 object.
 *
 * `exists` is the authoritative field — `etag` and `contentLength` are only
 * present when `exists === true`.
 */
export interface S3Baseline {
	exists: boolean;
	/** Quoted ETag as returned by HeadObject (e.g. `"d41d8cd98f00b204..."`). */
	etag?: string;
	/** Object size in bytes. */
	contentLength?: number;
}

/** A single active watch. One record per `watchId`. */
export interface S3Watch {
	watchId: string;
	bucket: string;
	key: string;
	/** AWS credentials profile. */
	profile: string;
	/** AWS region; `undefined` falls back to the profile default. */
	region: string | undefined;
	/** Condition that, when met, fires one event and marks the watch terminal. */
	target: TargetCondition;
	/**
	 * Absolute epoch ms at which a `timeout` event fires and the watch is
	 * auto-removed. `undefined` means no timeout — watch runs until target
	 * condition is met or the user removes it.
	 */
	timeoutAt: number | undefined;
	addedAt: number;
	lastPolledAt: number | undefined;
	/**
	 * Last observed state. `undefined` when seeding on `add` failed — the
	 * poll loop will retry on the next tick.
	 */
	baseline: S3Baseline | undefined;
	/** `true` once the target condition has fired OR the timeout elapsed. */
	terminal: boolean;
	/** Consecutive poll failures; reset to 0 on success. */
	consecutiveErrors: number;
}

/** Map of watchId → S3Watch. Serialisable to JSON as-is. */
export type WatchMap = Record<string, S3Watch>;

/** A single detected event emitted by the poll loop. */
export interface S3Event {
	watchId: string;
	bucket: string;
	key: string;
	/**
	 * `exists` / `updated` / `removed` mean the target condition fired.
	 * `timeout` means `timeoutAt` elapsed before the target was met.
	 */
	eventType: "exists" | "updated" | "removed" | "timeout";
	/**
	 * All S3 events are terminal — when any event fires the watch is done.
	 * Always `true`; present so `isTerminalBatch` can inspect the event
	 * itself rather than relying on `events.length > 0`.
	 */
	isTerminal: true;
	/** Human-readable one-liner. */
	summary: string;
	/** Bullet-list line for chat messages (includes `"• "` prefix). */
	formatted: string;
}
