/**
 * pi-aws-glue-watcher — extension entrypoint.
 *
 * Polls AWS Glue job and workflow runs in-process and injects state-change
 * notifications into pi chat as custom-typed messages.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { createGlueClient, type GlueClient } from './glue-client.js'
import { GlueWatcher } from './watcher.js'

export function createExtensionWithClient(pi: ExtensionAPI, client: GlueClient): void {
  new GlueWatcher({ pi, client }).register(pi)
}

/** Default export — wired to the real AWS SDK client. */
export default function glueWatcher(pi: ExtensionAPI): void {
  createExtensionWithClient(pi, createGlueClient())
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { GlueWatcher, POLL_INTERVAL_MS, POLL_INTERVAL_MAX_MS } from './watcher.js'
export { createGlueClient } from './glue-client.js'
export type { GlueClient } from './glue-client.js'
export {
  snapshotJobRun,
  snapshotWorkflowRun,
  detectJobChanges,
  detectWorkflowChanges,
} from './poller.js'
export {
  buildChangeChatMessage,
  buildStartupChatMessage,
  buildStatusLine,
  buildWatchEntry,
} from './format.js'

export { GlueWatcherParams } from './toolParams.js'
export type {
  GlueWatch,
  GlueEvent,
  WatchMap,
  WatchBaseline,
  JobBaseline,
  WorkflowBaseline,
} from './types.js'
