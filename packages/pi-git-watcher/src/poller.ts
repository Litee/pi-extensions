/**
 * Git change detection for pi-git-watcher.
 *
 * Pure module: no environment access beyond GitClient, no persistence,
 * no setInterval. Tests can stub the GitClient to exercise change-detection
 * logic without needing a real git repository.
 *
 * Public surface:
 *   - {@link snapshotRepo}       — fetch current baseline, no diff.
 *   - {@link detectChanges}      — fetch + diff against a watch's baseline,
 *                                  emit change events.
 *   - {@link buildTimeoutEvent}  — synthesise a timeout event.
 *   - {@link arrayDiff}          — exported as __test__.arrayDiff for unit tests.
 */

import { basename } from "node:path";

import type { GitClient } from "./git-client.js";
import type {
  GitBaseline,
  GitEvent,
  GitWatch,
  TargetCondition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Fetch the current state of the repository as a baseline. */
export async function snapshotRepo(
  client: GitClient,
  watch: GitWatch,
): Promise<GitBaseline> {
  const [headSha, branches, tags] = await Promise.all([
    client.resolveBranch(watch.repoPath, watch.branch),
    client.listLocalBranches(watch.repoPath),
    client.listLocalTags(watch.repoPath),
  ]);
  return { headSha, branches, tags };
}

// ---------------------------------------------------------------------------
// Array diff (O(n+m) merge)
// ---------------------------------------------------------------------------

/**
 * Returns elements in `b` that are not in `a`.
 * Both arrays MUST be sorted ascending.
 */
export function arrayDiff(a: string[], b: string[]): string[] {
  const result: string[] = [];
  let ai = 0;
  let bi = 0;
  while (bi < b.length) {
    if (ai >= a.length) {
      result.push(b[bi]!);
      bi++;
    } else {
      const cmp = a[ai]!.localeCompare(b[bi]!);
      if (cmp < 0) {
        ai++;
      } else if (cmp === 0) {
        ai++;
        bi++;
      } else {
        result.push(b[bi]!);
        bi++;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function repoName(repoPath: string): string {
  return basename(repoPath);
}

function buildNewCommitEvent(
  watch: GitWatch,
  sha: string,
  commitSubject: string | undefined,
  now: number,
): GitEvent {
  const name = repoName(watch.repoPath);
  const sha7 = sha.slice(0, 7);
  const subjectPart = commitSubject ? ` — ${commitSubject}` : "";
  const summary = `${name} [${watch.branch}]: new commit ${sha7}${subjectPart}`;
  const event: GitEvent = {
    watchId: watch.watchId,
    repoPath: watch.repoPath,
    branch: watch.branch,
    eventType: "new_commit",
    sha,
    affectedBranch: watch.branch,
    isTerminal: false,
    summary,
    formatted: `• ${summary} ✓`,
    timestamp: now,
  };
  if (commitSubject !== undefined) event.commitSubject = commitSubject;
  return event;
}

function buildBranchCreatedEvent(
  watch: GitWatch,
  branchName: string,
  now: number,
): GitEvent {
  const name = repoName(watch.repoPath);
  const summary = `${name}: branch '${branchName}' created`;
  return {
    watchId: watch.watchId,
    repoPath: watch.repoPath,
    branch: watch.branch,
    eventType: "branch_created",
    affectedBranch: branchName,
    isTerminal: false,
    summary,
    formatted: `• ${summary} ✓`,
    timestamp: now,
  };
}

function buildBranchDeletedEvent(
  watch: GitWatch,
  branchName: string,
  now: number,
): GitEvent {
  const name = repoName(watch.repoPath);
  const summary = `${name}: branch '${branchName}' deleted`;
  return {
    watchId: watch.watchId,
    repoPath: watch.repoPath,
    branch: watch.branch,
    eventType: "branch_deleted",
    affectedBranch: branchName,
    isTerminal: false,
    summary,
    formatted: `• ${summary} ✓`,
    timestamp: now,
  };
}

function buildTagCreatedEvent(
  watch: GitWatch,
  tagName: string,
  now: number,
): GitEvent {
  const name = repoName(watch.repoPath);
  const summary = `${name}: tag '${tagName}' created`;
  return {
    watchId: watch.watchId,
    repoPath: watch.repoPath,
    branch: watch.branch,
    eventType: "tag_created",
    tagName,
    isTerminal: false,
    summary,
    formatted: `• ${summary} ✓`,
    timestamp: now,
  };
}

export function buildTimeoutEvent(watch: GitWatch, now: number): GitEvent {
  const name = repoName(watch.repoPath);
  const summary = `${name} (${watch.branch}): timed out`;
  return {
    watchId: watch.watchId,
    repoPath: watch.repoPath,
    branch: watch.branch,
    eventType: "timeout",
    isTerminal: true,
    summary,
    formatted: `• ${summary} ✗`,
    timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export interface DetectChangesResult {
  events: GitEvent[];
  newBaseline: GitBaseline;
  observedChange: boolean;
}

export async function detectChanges(
  client: GitClient,
  watch: GitWatch,
  nowTs: number,
): Promise<DetectChangesResult> {
  const snap = await snapshotRepo(client, watch);

  // First poll: seed the baseline, return no events.
  if (watch.baseline === undefined) {
    return {
      events: [],
      newBaseline: snap,
      observedChange: false,
    };
  }

  const prev = watch.baseline;
  const targets = new Set<TargetCondition>(watch.targets);
  const events: GitEvent[] = [];

  // Detect new_commit: branch existed and HEAD SHA changed
  if (
    targets.has("new_commit") &&
    prev.headSha !== undefined &&
    snap.headSha !== undefined &&
    prev.headSha !== snap.headSha
  ) {
    let subject: string | undefined;
    try {
      subject = await client.getCommitSubject(watch.repoPath, snap.headSha);
    } catch {
      // best-effort: swallow
    }
    events.push(buildNewCommitEvent(watch, snap.headSha, subject, nowTs));
  }

  // Detect branch_created and branch_deleted
  if (targets.has("branch_created")) {
    const created = arrayDiff(prev.branches, snap.branches);
    for (const b of created) {
      events.push(buildBranchCreatedEvent(watch, b, nowTs));
    }
  }
  if (targets.has("branch_deleted")) {
    const deleted = arrayDiff(snap.branches, prev.branches);
    for (const b of deleted) {
      events.push(buildBranchDeletedEvent(watch, b, nowTs));
    }
  }

  // Detect tag_created
  if (targets.has("tag_created")) {
    const created = arrayDiff(prev.tags, snap.tags);
    for (const t of created) {
      events.push(buildTagCreatedEvent(watch, t, nowTs));
    }
  }

  // observedChange: any field changed relative to prev (even untargeted)
  const observedChange =
    prev.headSha !== snap.headSha ||
    !arraysEqual(prev.branches, snap.branches) ||
    !arraysEqual(prev.tags, snap.tags);

  return { events, newBaseline: snap, observedChange };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Test hook
// ---------------------------------------------------------------------------

export const __test__ = { arrayDiff };
