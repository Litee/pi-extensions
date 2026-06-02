/**
 * Tool parameters schema for pi-file-system-watcher.
 */

import { Type } from "typebox";

/** Hard ceiling on watch duration: 24 h. */
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60; // 86_400 s

export const FsWatcherParams = Type.Object({
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
        "add: start watching a filesystem path. " +
        "remove: stop watching by watchId. " +
        "list: show all watches. " +
        "pause / resume: toggle polling globally (persisted). " +
        "status: show runtime state.",
    },
  ),
  path: Type.Optional(
    Type.String({
      description: "Absolute or relative filesystem path to watch (required for 'add').",
    }),
  ),
  target: Type.Optional(
    Type.Union(
      [
        Type.Literal("creation"),
        Type.Literal("modification"),
        Type.Literal("deletion"),
      ],
      {
        description:
          "Condition to wait for (required for 'add'). " +
          "'creation': fire when the path appears. " +
          "'modification': fire when mtime or size changes from baseline (path must exist at add time). " +
          "'deletion': fire when the path is deleted.",
      },
    ),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "Optional. Cap the watch at this many seconds; defaults to 24 h (86400 s) if omitted. " +
        "Values above 24 h are silently capped at 24 h.",
    }),
  ),
  watchId: Type.Optional(
    Type.String({ description: "Watch ID returned by 'add', required for 'remove'." }),
  ),
});
