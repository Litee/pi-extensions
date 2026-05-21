/**
 * pi-aws-s3-watcher — pi extension entrypoint.
 *
 * Auto-enabled: the `s3_watcher` tool is registered and active from
 * session_start. The `/s3-watcher` command is a thin convenience for
 * pause/resume/status without requiring an LLM round-trip.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createWatcherMessageRenderer } from "pi-watcher-core/renderer";
import { seedMissingBaselines } from "pi-watcher-core/seed-baselines";
import { reconcileToolActivation, removeToolFromActive } from "pi-watcher-core/tool-activation";
import { extractUiSurface } from "pi-watcher-core/ui-surface";

import { loadConfig } from "./config.js";
import { buildStartupChatMessage } from "./format.js";
import { rehydrateStateFromSession, writeState } from "./persistence.js";
import { snapshotObject } from "./poller.js";
import {
	CUSTOM_MESSAGE_TYPE,
	makeRuntime,
	refreshStatus,
	startPolling,
	stopPolling,
	toggleDisplayMode,
	TOOL_NAME,
	type Runtime,
} from "./runtime.js";
import { createS3Client, type S3Client } from "./s3-client.js";
import { registerToolIfNeeded } from "./toolAction.js";
import { S3Widget } from "./ui/s3-widget.js";

/**
 * Wire up the extension with a concrete or injected {@link S3Client}.
 * Exported so tests can supply a stub client without touching AWS.
 */
export function createExtensionWithClient(pi: ExtensionAPI, client: S3Client): void {
	const rt: Runtime = makeRuntime(pi, client);
	rt.widget = new S3Widget(pi, () => rt.watches, () => rt.scheduler.intervalMs);

	pi.on("session_start", async (_event, ctx) => {
		rt.ui = extractUiSurface(ctx);

		// Register the tool into the registry so it is visible via manage_tools
		// ({action:"list"}) and can be activated by the LLM on demand.
		// NOT added to the active set — the LLM must call manage_tools first.
		registerToolIfNeeded(pi, rt);

		const state = rehydrateStateFromSession(ctx);
		rt.watches = state?.watches ?? {};
		rt.paused = state?.paused ?? false;
		rt.enabled = state?.enabled ?? false;
		// Display-mode precedence: persisted state > user config > hardcoded
		// default. Loading the config here (rather than at module-eval time)
		// keeps it cheap and lets tests override per session_start call.
		const { defaultDisplayMode } = loadConfig();
		rt.displayMode = state?.displayMode ?? defaultDisplayMode ?? "widget";

		// Pi auto-activates all extension tools on session_start regardless of
		// user intent. Undo that if we have no persisted enabled=true so the
		// tool stays inactive (matching persisted state).
		if (!rt.enabled) {
			removeToolFromActive(pi, TOOL_NAME);
		}

		// Re-seed any watch that never got a baseline (add-time seeding
		// failed, or persistence dropped the baseline).
		await seedMissingBaselines(Object.values(rt.watches), {
			snapshot: (watch) => snapshotObject(client, watch),
			onError: (watch, err) => {
				rt.pi.appendEntry("s3-watcher:seed-error", {
					bucket: watch.bucket,
					key: watch.key,
					message: (err as Error).message,
				});
			},
		});

		// Polling runs whenever there are active watches — regardless of
		// rt.enabled. Tool active state only controls LLM tool access.
		const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
		if (!rt.paused && activeWatches.length > 0) startPolling(rt);
		refreshStatus(rt);
		if (rt.displayMode === "widget") rt.widget?.show(ctx);
		else rt.widget?.hide(ctx);

		if (Object.keys(rt.watches).length > 0) {
			// Defer: fire after the interactive UI has painted so the chat
			// bubble renders as its own message rather than being folded into
			// the next LLM turn's prompt.
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

	pi.on("turn_end", (_event, ctx) => {
		// Reconcile rt.enabled with the active-tools list. The user may have
		// run manage_tools({action:"activate"}) or deactivate during the turn.
		const intent = reconcileToolActivation(TOOL_NAME, rt.enabled, pi.getActiveTools());
		if (intent === "noop") return;
		if (intent === "activate") {
			rt.enabled = true;
			writeState(pi, rt);
			const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
			if (!rt.paused && anyActive && !rt.scheduler.isRunning) startPolling(rt);
			refreshStatus(rt);
			if (rt.displayMode === "widget") rt.widget?.show(ctx);
			else rt.widget?.hide(ctx);
		} else {
			// Deactivate: remove tool from active set and persist, but keep
			// polling running — notifications still fire with a re-activation hint.
			rt.enabled = false;
			writeState(pi, rt);
			refreshStatus(rt);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopPolling(rt);
		try {
			rt.widget?.hide(ctx);
			rt.widget?.destroy();
		} catch {
			/* noop — UI may already be torn down */
		}
		rt.ui = null;
	});

	pi.registerMessageRenderer(
		CUSTOM_MESSAGE_TYPE,
		createWatcherMessageRenderer("pi-aws-s3-watcher"),
	);

	pi.registerCommand("s3-watcher", {
		description: "Control the S3 object watcher (pause | resume | status)",
		handler: (args, ctx) => {
			const ui = extractUiSurface(ctx);
			const sub = (args ?? "").trim().toLowerCase();
			switch (sub) {
				case "pause": {
					rt.paused = true;
					stopPolling(rt);
					writeState(pi, rt);
					refreshStatus(rt);
					ui?.notify?.("s3-watcher: paused.", "info");
					return Promise.resolve();
				}
				case "resume": {
					rt.paused = false;
					writeState(pi, rt);
					const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
					if (anyActive && !rt.scheduler.isRunning) startPolling(rt);
					refreshStatus(rt);
					ui?.notify?.("s3-watcher: resumed.", "info");
					return Promise.resolve();
				}
				case "":
				case "status": {
					const ids = Object.keys(rt.watches);
					const active = ids.filter((id) => !rt.watches[id]?.terminal).length;
					const stateDesc = rt.paused ? "paused" : "active";
					ui?.notify?.(
						`s3-watcher: ${stateDesc} | ${ids.length} watch(es) (${active} active) | poll: ${Math.round(rt.scheduler.intervalMs / 1000)}s`,
						"info",
					);
					return Promise.resolve();
				}
				case "display": {
					toggleDisplayMode(rt, ctx);
					ui?.notify?.(`s3-watcher: switched to ${rt.displayMode} mode.`, "info");
					return Promise.resolve();
				}
				default:
					ui?.notify?.(
						`s3-watcher: unknown subcommand '${sub}'. Use: pause | resume | status | display`,
						"warning",
					);
					return Promise.resolve();
			}
		},
	});
}

/** Default export — wired to the real AWS SDK client. */
export default function s3Watcher(pi: ExtensionAPI): void {
	const client = createS3Client();
	createExtensionWithClient(pi, client);
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
	POLL_INTERVAL_MS,
	POLL_INTERVAL_MAX_MS,
	POLL_ERROR_THRESHOLD,
	CUSTOM_MESSAGE_TYPE,
	STATUS_KEY,
	pollOnce,
} from "./runtime.js";
export {
	handleToolAction,
	MAX_TIMEOUT_SECONDS,
	registerToolIfNeeded,
	resetToolRegisteredForTests,
} from "./toolAction.js";
export { STATE_CUSTOM_TYPE } from "./persistence.js";
export { buildStatusLine, buildChangeChatMessage, buildStartupChatMessage } from "./format.js";
export { snapshotObject, detectChanges, buildTimeoutEvent } from "./poller.js";
export { createS3Client, isNotFoundError } from "./s3-client.js";
export { parseS3Uri, S3UriError } from "./uri.js";
export type { S3Client, HeadObjectResult } from "./s3-client.js";
export type { S3Watch, S3Event, WatchMap, S3Baseline, TargetCondition } from "./types.js";
