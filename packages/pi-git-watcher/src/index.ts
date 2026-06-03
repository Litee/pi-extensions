/**
 * pi-git-watcher — pi extension entrypoint.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createGitClient, type GitClient } from "./git-client.js";
import { GitWatcher } from "./watcher.js";

export function createExtensionWithClient(
  pi: ExtensionAPI,
  client: GitClient,
): void {
  new GitWatcher({ pi, client }).register(pi);
}

export default function gitWatcher(pi: ExtensionAPI): void {
  createExtensionWithClient(pi, createGitClient());
}

// ---------------------------------------------------------------------------
// Re-exports for external consumers and tests
// ---------------------------------------------------------------------------

export { GitWatcher, formatTimeLeft } from "./watcher.js";
export {
  snapshotRepo,
  detectChanges,
  buildTimeoutEvent,
  __test__,
} from "./poller.js";
export { createGitClient, GitClientError } from "./git-client.js";
export { GitWatcherParams, MAX_TIMEOUT_SECONDS } from "./toolAction.js";
export { buildStatusLine, buildChangeChatMessage } from "./format.js";
export type {
  GitWatch,
  GitEvent,
  WatchMap,
  GitBaseline,
  TargetCondition,
} from "./types.js";
export type { GitClient } from "./git-client.js";
