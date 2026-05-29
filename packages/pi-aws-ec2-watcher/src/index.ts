/**
 * pi-aws-ec2-watcher — pi extension entrypoint.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { createEc2Client, type Ec2Client } from './ec2-client.js'
import { Ec2Watcher } from './watcher.js'

export function createExtensionWithClient(pi: ExtensionAPI, client: Ec2Client): void {
  new Ec2Watcher({ pi, client }).register(pi)
}

export default function ec2InstanceWatcher(pi: ExtensionAPI): void {
  createExtensionWithClient(pi, createEc2Client())
}

// ---------------------------------------------------------------------------
// Re-exports for external consumers and tests
// ---------------------------------------------------------------------------

export { Ec2Watcher, formatTimeLeft } from './watcher.js'
export { snapshotInstance, detectChanges, buildTimeoutEvent } from './poller.js'
export { createEc2Client, isNotFoundError } from './ec2-client.js'
export { validateInstanceId, isValidInstanceId, InstanceIdError } from './instanceId.js'
export { Ec2WatcherParams, MAX_TIMEOUT_SECONDS } from './toolAction.js'
export { buildStatusLine, buildChangeChatMessage, buildStartupChatMessage } from './format.js'
export type { Ec2Watch, Ec2Event, WatchMap, Ec2Baseline, Ec2InstanceState } from './types.js'
export type { Ec2Client, InstanceStateResult } from './ec2-client.js'
