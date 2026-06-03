/**
 * pi-file-system-watcher — pi extension entrypoint.
 *
 * The `file_system_watcher` tool is registered and active from
 * session_start. The `/file-system-watcher` command opens an interactive
 * TUI menu for display-mode toggles without requiring an LLM round-trip.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createFsClient } from "./fs-client.js";
import { FsWatcher } from "./watcher.js";

export function createExtensionWithClient(
  pi: ExtensionAPI,
  client: import("./fs-client.js").FsClient,
): void {
  new FsWatcher({ pi, client }).register(pi);
}

export default function fsWatcher(pi: ExtensionAPI): void {
  createExtensionWithClient(pi, createFsClient());
}

// ---------------------------------------------------------------------------
// Re-exports for external consumers and tests
// ---------------------------------------------------------------------------

export { FsWatcher, formatTimeLeft, compressPath } from "./watcher.js";
export { snapshotPath, detectChanges, buildTimeoutEvent } from "./poller.js";
export { createFsClient } from "./fs-client.js";
export { FsWatcherParams, MAX_TIMEOUT_SECONDS } from "./toolAction.js";
export { buildChangeChatMessage } from "./format.js";
export type { FsClient } from "./fs-client.js";
export type {
  FsWatch,
  FsEvent,
  WatchMap,
  FsBaseline,
  TargetCondition,
} from "./types.js";
