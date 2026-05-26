/**
 * pi-file-system-watcher — pi extension entrypoint.
 *
 * Auto-enabled: the `file_system_watcher` tool is registered and active from
 * session_start. The `/file-system-watcher` command opens an interactive TUI menu
 * for pause/resume and display-mode toggles without requiring an LLM round-trip.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createWatcherMessageRenderer } from "pi-watcher-core/renderer";
import { seedMissingBaselines } from "pi-watcher-core/seed-baselines";
import { reconcileToolActivation, removeToolFromActive } from "pi-watcher-core/tool-activation";
import { extractUiSurface } from "pi-watcher-core/ui-surface";

import { runFsWatcherCommand } from "./command.js";
import { loadConfig } from "./config.js";
import { buildStartupChatMessage } from "./format.js";
import { rehydrateStateFromSession, writeState } from "./persistence.js";
import { snapshotPath } from "./poller.js";
import {
	CUSTOM_MESSAGE_TYPE,
	makeRuntime,
	refreshStatus,
	setupWatchFs,
	startPolling,
	stopPolling,
	teardownAllWatchHandles,
	TOOL_NAME,
	type Runtime,
} from "./runtime.js";
import { registerToolIfNeeded } from "./toolAction.js";

export default function fsWatcher(pi: ExtensionAPI): void {
	const rt: Runtime = makeRuntime(pi, snapshotPath);

	pi.on("session_start", async (_event, ctx) => {
		rt.ui = extractUiSurface(ctx);

		registerToolIfNeeded(pi, rt);

		const state = rehydrateStateFromSession(ctx);
		rt.watches = state?.watches ?? {};
		rt.paused = state?.paused ?? false;
		rt.enabled = state?.enabled ?? false;

		const { defaultDisplayMode } = loadConfig();
		rt.displayMode = state?.displayMode ?? defaultDisplayMode ?? "widget";

		if (!rt.enabled) {
			removeToolFromActive(pi, TOOL_NAME);
		}

		// Re-seed any watch that never got a baseline.
		await seedMissingBaselines(Object.values(rt.watches), {
			snapshot: (watch) => snapshotPath(watch.path),
			onError: (watch, err) => {
				pi.appendEntry("file-system-watcher:seed-error", {
					path: watch.path,
					message: (err as Error).message,
				});
			},
		});

		// Re-attach fs.watch listeners for surviving watches.
		for (const watch of Object.values(rt.watches)) {
			if (!watch.terminal) setupWatchFs(rt, watch);
		}

		const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
		if (!rt.paused && activeWatches.length > 0) startPolling(rt);
		refreshStatus(rt);

		if (Object.keys(rt.watches).length > 0) {
			setImmediate(() => {
				pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content: buildStartupChatMessage(rt.watches, new Date()),
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			});
		}
	});

	pi.on("turn_end", (_event, _ctx) => {
		const intent = reconcileToolActivation(TOOL_NAME, rt.enabled, pi.getActiveTools());
		if (intent === "noop") return;
		if (intent === "activate") {
			rt.enabled = true;
			writeState(pi, rt);
			const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
			if (!rt.paused && anyActive && !rt.scheduler.isRunning) startPolling(rt);
			refreshStatus(rt);
		} else {
			rt.enabled = false;
			writeState(pi, rt);
			refreshStatus(rt);
		}
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		stopPolling(rt);
		teardownAllWatchHandles(rt);
		rt.ui = null;
	});

	pi.registerMessageRenderer(
		CUSTOM_MESSAGE_TYPE,
		createWatcherMessageRenderer("pi-file-system-watcher"),
	);

	pi.registerCommand("file-system-watcher", {
		description: "Open the FS path watcher menu",
		handler: (args, ctx) => runFsWatcherCommand(args, ctx, rt),
	});
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

export {
	POLL_INTERVAL_MS,
	POLL_INTERVAL_MAX_MS,
	POLL_ERROR_THRESHOLD,
	CUSTOM_MESSAGE_TYPE,
	STATUS_KEY,
	pollOnce,
} from "./runtime.js";
export { runFsWatcherCommand } from "./command.js";
export {
	handleToolAction,
	MAX_TIMEOUT_SECONDS,
	registerToolIfNeeded,
	resetToolRegisteredForTests,
} from "./toolAction.js";
export { STATE_CUSTOM_TYPE } from "./persistence.js";
export { buildStatusLine, buildChangeChatMessage, buildStartupChatMessage } from "./format.js";
export { detectChanges, buildTimeoutEvent, snapshotPath } from "./poller.js";
export { createDebounced, tryCreateFsWatch } from "./watcher.js";
export type { FsWatch, FsEvent, WatchMap, FsBaseline, TargetCondition, WatchMode } from "./types.js";
