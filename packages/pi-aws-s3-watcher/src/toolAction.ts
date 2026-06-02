/**
 * Tool parameters schema and constants for pi-aws-s3-watcher.
 *
 * Action handlers have moved to S3Watcher (watcher.ts / BaseWatcher).
 * Only the TypeBox schema, the timeout ceiling, and the valid-targets set
 * are kept here so they can be imported by both the watcher class and tests.
 */

import { Type } from 'typebox'

import type { TargetCondition } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling for all watches: 72 hours in seconds. */
export const MAX_TIMEOUT_SECONDS = 72 * 60 * 60 // 259_200 s

/** Valid target conditions. */
export const TARGETS: ReadonlySet<TargetCondition> = new Set<TargetCondition>([
  'creation',
  'modification',
  'deletion',
])

// ---------------------------------------------------------------------------
// TypeBox schema
// ---------------------------------------------------------------------------

export const S3WatcherParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal('add'),
      Type.Literal('remove'),
      Type.Literal('list'),
      Type.Literal('pause'),
      Type.Literal('resume'),
      Type.Literal('status'),
    ],
    {
      description:
        'add: start watching an S3 object URI. ' +
        'remove: stop watching by watchId. ' +
        'list: show all watches. ' +
        'pause / resume: toggle polling globally (persisted). ' +
        'status: show runtime state (paused, watch count, poll interval).',
    },
  ),
  uri: Type.Optional(
    Type.String({
      description: "Object URI in s3://bucket/key form (required for 'add').",
    }),
  ),
  target: Type.Optional(
    Type.Union(
      [Type.Literal('creation'), Type.Literal('modification'), Type.Literal('deletion')],
      {
        description:
          "Condition to wait for (required for 'add'). 'creation': fire when the object appears. 'modification': fire when ETag/size changes from baseline (object must exist at add time). 'deletion': fire when the object is deleted.",
      },
    ),
  ),
  profile: Type.Optional(
    Type.String({ description: "AWS credentials profile (required for 'add')." }),
  ),
  region: Type.Optional(
    Type.String({ description: 'AWS region. Falls back to profile default when omitted.' }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        'Optional. Cap the watch at this many seconds; defaults to 72 h (259200 s) if omitted. Values above 72 h are silently capped at 72 h.',
    }),
  ),
  watchId: Type.Optional(
    Type.String({
      description: "Watch ID returned by 'add', required for 'remove'.",
    }),
  ),
})
