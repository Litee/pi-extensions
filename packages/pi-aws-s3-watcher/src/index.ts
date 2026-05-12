/**
 * pi-aws-s3-watcher — pi extension entrypoint.
 *
 * Auto-enabled: the `s3_watcher` tool is registered and active from
 * session_start. The `/s3-watcher` command is a thin convenience for
 * pause/resume/status without requiring an LLM round-trip.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import { buildStartupChatMessage } from "./format.js";
import { rehydrateStateFromSession, writeState } from "./persistence.js";
import { snapshotObject } from "./poller.js";
import {
	CUSTOM_MESSAGE_TYPE,
	makeRuntime,
	refreshStatus,
	startPolling,
	STATUS_KEY,
	stopPolling,
	type Runtime,
	type UiSurface,
} from "./runtime.js";
import { createS3Client, type S3Client } from "./s3-client.js";
import { registerToolIfNeeded } from "./toolAction.js";

/**
 * Wire up the extension with a concrete or injected {@link S3Client}.
 * Exported so tests can supply a stub client without touching AWS.
 */
export function createExtensionWithClient(pi: ExtensionAPI, client: S3Client): void {
	const rt: Runtime = makeRuntime(pi, client);

	pi.on("session_start", async (_event, ctx) => {
		const anyCtx = ctx as unknown as { hasUI?: boolean; ui?: UiSurface };
		const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
		rt.ui = hasUI ? (anyCtx.ui ?? null) : null;

		// Register the tool into the registry so it is visible via manage_tools
		// ({action:"list"}) and can be activated by the LLM on demand.
		// NOT added to the active set — the LLM must call manage_tools first.
		registerToolIfNeeded(pi, rt);

		const state = rehydrateStateFromSession(ctx);
		rt.watches = state?.watches ?? {};
		rt.paused = state?.paused ?? false;

		// Re-seed any watch that never got a baseline (add-time seeding
		// failed, or persistence dropped the baseline).
		for (const watch of Object.values(rt.watches)) {
			if (watch.terminal || watch.baseline !== undefined) continue;
			try {
				watch.baseline = await snapshotObject(client, watch);
			} catch (err) {
				rt.pi.appendEntry("s3-watcher:seed-error", {
					bucket: watch.bucket,
					key: watch.key,
					message: (err as Error).message,
				});
			}
		}

		const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
		if (!rt.paused && activeWatches.length > 0) startPolling(rt);
		refreshStatus(rt);

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

	pi.on("session_shutdown", () => {
		stopPolling(rt);
		try {
			rt.ui?.setStatus?.(STATUS_KEY, undefined);
		} catch {
			/* noop — UI may already be torn down */
		}
		rt.ui = null;
	});

	pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
		const label = theme.bold(theme.fg("customMessageLabel", "pi-aws-s3-watcher"));
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${label}\n\n${text}`, 0, 0));
		return box;
	});

	pi.registerCommand("s3-watcher", {
		description: "Control the S3 object watcher (pause | resume | status)",
		handler: (args, ctx) => {
			const anyCtx = ctx as unknown as { hasUI?: boolean; ui?: UiSurface };
			const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
			const ui = hasUI ? anyCtx.ui : undefined;
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
				default:
					ui?.notify?.(
						`s3-watcher: unknown subcommand '${sub}'. Use: pause | resume | status`,
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
