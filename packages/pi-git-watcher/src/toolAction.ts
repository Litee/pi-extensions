/**
 * Tool parameters schema and constants for pi-git-watcher.
 */

import { Type } from "typebox";

import type { TargetCondition } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling for all watches: 7 days in seconds. */
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60; // 604_800 s

/** Valid target conditions. */
export const TARGETS: ReadonlySet<TargetCondition> = new Set<TargetCondition>([
  "new_commit",
  "branch_created",
  "branch_deleted",
  "tag_created",
]);

// ---------------------------------------------------------------------------
// TypeBox schema
// ---------------------------------------------------------------------------

export const GitWatcherParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("add"),
      Type.Literal("remove"),
      Type.Literal("list"),
      Type.Literal("pause"),
      Type.Literal("resume"),
      Type.Literal("status"),
    ],
    {
      description:
        "add: start watching a git repository. " +
        "remove: stop watching by watchId. " +
        "list: show all watches. " +
        "pause / resume: toggle polling globally (persisted). " +
        "status: show runtime state (paused, watch count, poll interval).",
    },
  ),
  repoPath: Type.Optional(
    Type.String({
      description: "Absolute path to the git repository (required for 'add').",
    }),
  ),
  branch: Type.Optional(
    Type.String({
      description:
        "Branch name to watch (required for 'add'). Used for new_commit; also contextualises branch_created/deleted/tag_created events.",
    }),
  ),
  targets: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("new_commit"),
        Type.Literal("branch_created"),
        Type.Literal("branch_deleted"),
        Type.Literal("tag_created"),
      ]),
      {
        minItems: 1,
        uniqueItems: true,
        description:
          "Conditions to watch for (required for 'add'). " +
          "new_commit: fires when branch HEAD SHA changes. " +
          "branch_created: fires when any new local branch appears. " +
          "branch_deleted: fires when any local branch disappears. " +
          "tag_created: fires when any new local tag appears.",
      },
    ),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "Optional. Cap the watch at this many seconds; watch indefinitely if omitted. Values above 604800 s (7 days) are silently capped.",
    }),
  ),
  watchId: Type.Optional(
    Type.String({
      description: "Watch ID returned by 'add', required for 'remove'.",
    }),
  ),
});
