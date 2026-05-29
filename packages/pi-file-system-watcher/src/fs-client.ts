/**
 * FsClient — injectable filesystem client for pi-file-system-watcher.
 *
 * The default implementation delegates to `snapshotPath` from poller.ts.
 * Tests pass a stub so real `fs.promises.stat` is never called.
 */

import type { FsBaseline } from "./types.js";
import { snapshotPath } from "./poller.js";

export interface FsClient {
  snapshot(path: string): Promise<FsBaseline>;
}

export function createFsClient(): FsClient {
  return { snapshot: snapshotPath };
}
