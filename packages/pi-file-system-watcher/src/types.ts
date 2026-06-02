/**
 * Types shared across the pi-file-system-watcher modules.
 */

/** What the user is waiting for on a given filesystem path. */
export type TargetCondition = "creation" | "modification" | "deletion";

/**
 * Point-in-time observation of a filesystem path.
 *
 * `exists` is the authoritative field — `mtimeNs` and `size` are only
 * present when `exists === true`.
 */
export interface FsBaseline {
  exists: boolean;
  /**
   * Last-modification time in nanoseconds from `fs.promises.stat({bigint:true})`.
   * BigInt precision avoids the 1-second granularity limit of floating-point
   * `mtimeMs`, which can cause false-negative missed changes on filesystems
   * with sub-second mtime support.
   *
   * Serialised as a decimal string in JSON (BigInt is not JSON-serialisable).
   */
  mtimeNs?: bigint;
  /** File/directory size in bytes from `stat.size`. */
  size?: number;
}

/** A single active watch. One record per `watchId`. */
export interface FsWatch {
  watchId: string;
  /** Absolute or relative path to watch. */
  path: string;
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
  baseline: FsBaseline | undefined;
  /** `true` once the target condition has fired OR the timeout elapsed. */
  terminal: boolean;
  /** Consecutive poll failures; reset to 0 on success. */
  consecutiveErrors: number;
}

/** Map of watchId → FsWatch. Serialisable to JSON as-is. */
export type WatchMap = Record<string, FsWatch>;

/** A single detected event emitted by the poll loop. */
export interface FsEvent {
  watchId: string;
  path: string;
  /**
   * `creation` / `modification` / `deletion` mean the target condition fired.
   * `timeout` means `timeoutAt` elapsed before the target was met.
   */
  eventType: "creation" | "modification" | "deletion" | "timeout";
  /** Human-readable one-liner. */
  summary: string;
  /** Bullet-list line for chat messages (includes `"• "` prefix). */
  formatted: string;
}
