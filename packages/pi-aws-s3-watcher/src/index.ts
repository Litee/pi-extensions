/**
 * pi-aws-s3-watcher — pi extension entrypoint.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { createS3Client, type S3Client } from './s3-client.js'
import { S3Watcher } from './watcher.js'

export function createExtensionWithClient(pi: ExtensionAPI, client: S3Client): void {
  new S3Watcher({ pi, client }).register(pi)
}

export default function s3Watcher(pi: ExtensionAPI): void {
  createExtensionWithClient(pi, createS3Client())
}

// ---------------------------------------------------------------------------
// Re-exports for external consumers and tests
// ---------------------------------------------------------------------------

export { S3Watcher, formatTimeLeft } from './watcher.js'
export { snapshotObject, detectChanges, buildTimeoutEvent } from './poller.js'
export { createS3Client, isNotFoundError } from './s3-client.js'
export { parseS3Uri, S3UriError } from './uri.js'
export { S3WatcherParams, MAX_TIMEOUT_SECONDS } from './toolAction.js'
export { buildStatusLine, buildChangeChatMessage, buildStartupChatMessage } from './format.js'
export type { S3Watch, S3Event, WatchMap, S3Baseline, TargetCondition } from './types.js'
export type { S3Client, HeadObjectResult } from './s3-client.js'
