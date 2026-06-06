/**
 * TypeBox parameter schema for the glue_watcher tool.
 * Extracted from toolAction.ts so it can be consumed by both the legacy
 * runtime and the new GlueWatcher class without a circular dependency.
 */
import { Type } from 'typebox'

export const GlueWatcherParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal('add'),
      Type.Literal('remove'),
      Type.Literal('list'),
      Type.Literal('status'),
      Type.Literal('set-interval'),
    ],
    {
      description:
        'add: start watching a job or workflow run (seeds baseline immediately). ' +
        'remove: stop watching a run by its watchId. ' +
        'list: show the current watch list with state. ' +
        'status: show runtime state (enabled, watch count, poll interval). ' +
        'set-interval: update the poll interval for a specific watch (requires watchId and pollIntervalMs).',
    },
  ),
  type: Type.Optional(
    Type.Union([Type.Literal('job'), Type.Literal('workflow')], {
      description: "Target kind for 'add': 'job' or 'workflow'.",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Glue job name or workflow name (required for 'add')." }),
  ),
  runId: Type.Optional(
    Type.String({
      description:
        "Run ID (jr_… for jobs, wr_… for workflows). If omitted for 'add', the most recent run is used.",
    }),
  ),
  profile: Type.Optional(
    Type.String({ description: "AWS credentials profile (required for 'add')." }),
  ),
  region: Type.Optional(
    Type.String({ description: 'AWS region. Uses the profile default when omitted.' }),
  ),
  watchId: Type.Optional(
    Type.String({
      description: "Watch ID returned by 'add', required for 'remove' and 'set-interval'.",
    }),
  ),
  pollIntervalMs: Type.Optional(
    Type.Number({
      description:
        'Per-watch poll interval in milliseconds (minimum 5000). Used by \'add\' and \'set-interval\'.',
    }),
  ),
})
