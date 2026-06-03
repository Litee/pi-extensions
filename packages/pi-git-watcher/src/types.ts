/**
 * Types shared across the pi-git-watcher modules.
 */

/** What the user is waiting for on a given git repository. */
export type TargetCondition =
  | "new_commit"
  | "branch_created"
  | "branch_deleted"
  | "tag_created";

/**
 * Point-in-time observation of a git repository.
 */
export interface GitBaseline {
  /** SHA of watch.branch HEAD; undefined if branch doesn't exist. */
  headSha: string | undefined;
  /** All local branch names, sorted ascending. */
  branches: string[];
  /** All local tag names, sorted ascending. */
  tags: string[];
}

/** A single active watch. One record per `watchId`. */
export interface GitWatch {
  watchId: string;
  /** Always absolute — resolved at addWatch time. */
  repoPath: string;
  /** Required; used for new_commit; repo-wide context for others. */
  branch: string;
  targets: TargetCondition[];
  /** Epoch ms; undefined = watch indefinitely. */
  timeoutAt: number | undefined;
  addedAt: number;
  lastPolledAt: number | undefined;
  baseline: GitBaseline | undefined;
  terminal: boolean;
  consecutiveErrors: number;
}

/** Map of watchId → GitWatch. Serialisable to JSON as-is. */
export type WatchMap = Record<string, GitWatch>;

/** A single detected event emitted by the poll loop. */
export interface GitEvent {
  watchId: string;
  repoPath: string;
  /** Watch.branch context (always present). */
  branch: string;
  eventType: TargetCondition | "timeout";
  /** Present iff eventType === "new_commit". */
  sha?: string;
  /** Present iff eventType === "tag_created". */
  tagName?: string;
  /** Present iff eventType ∈ {branch_created, branch_deleted, new_commit}. */
  affectedBranch?: string;
  /** Present iff eventType === "new_commit", best-effort. */
  commitSubject?: string;
  /** true ONLY for "timeout" events. */
  isTerminal: boolean;
  /** Human-readable one-liner. */
  summary: string;
  /** Bullet line with "• " prefix. */
  formatted: string;
  /** Epoch ms. */
  timestamp: number;
}
