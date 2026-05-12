/**
 * pi-aws-glue-watcher — pi extension entrypoint.
 *
 * Polls AWS Glue job and workflow runs in-process and injects state-change
 * notifications into pi chat as custom-typed messages.
 *
 * Most logic lives in sibling modules:
 *  - runtime.ts        — Runtime type + poll-loop control
 *  - toolAction.ts     — glue_watcher tool + registration guard
 *  - command.ts        — /glue-watcher subcommand dispatch
 *  - ui/watches-view.ts — `/glue-watcher jobs` overlay (shell)
 *  - ui/glue-widget.ts  — below-editor widget (shell)
 *
 * This file is strictly session/lifecycle wiring.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createGlueClient, type GlueClient } from "./glue-client.js";
import { buildStartupChatMessage } from "./format.js";
import { rehydrateStateFromSession } from "./persistence.js";
import { snapshotJobRun, snapshotWorkflowRun } from "./poller.js";
import { runGlueWatcherCommand } from "./command.js";
import {
	CUSTOM_MESSAGE_TYPE,
	makeRuntime,
	refreshStatus,
	startPolling,
	stopPolling,
	type Runtime,
	type UiSurface,
} from "./runtime.js";
import { registerToolIfNeeded, syncToolActiveState } from "./toolAction.js";
import { GlueWidget } from "./ui/glue-widget.js";

/**
 * Wire up the extension with a concrete or injected {@link GlueClient}.
 * Exported so tests can supply a stub client without touching the real CLI.
 */
export function createExtensionWithClient(pi: ExtensionAPI, client: GlueClient): void {
	const rt: Runtime = makeRuntime(pi, client);
	rt.widget = new GlueWidget(pi, () => rt.watches, () => rt.scheduler.intervalMs);

	pi.on("session_start", async (_event, ctx) => {
		const anyCtx = ctx as unknown as { hasUI?: boolean; ui?: UiSurface };
		const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
		rt.ui = hasUI ? (anyCtx.ui ?? null) : null;

		const state = rehydrateStateFromSession(ctx);
		rt.watches = state?.watches ?? {};
		rt.paused = state?.paused ?? false;
		rt.enabled = state?.enabled ?? false;
		rt.displayMode = state?.displayMode ?? "widget";

		// Always register the tool into the registry so manage_tools({action:"list"})
		// shows it. Then sync its active-set membership with persisted `enabled`
		// state — so a restart where the user had previously run
		// /glue-watcher enable keeps the tool callable without forcing a
		// re-enable. If enabled=false, the tool is yanked out of the active set.
		registerToolIfNeeded(pi, rt);
		syncToolActiveState(pi, rt.enabled);

		if (!rt.enabled) return;

		for (const watch of Object.values(rt.watches)) {
			if (watch.terminal || watch.baseline !== undefined) continue;
			try {
				watch.baseline =
					watch.type === "job"
						? await snapshotJobRun(client, watch)
						: await snapshotWorkflowRun(client, watch);
			} catch (err) {
				rt.pi.appendEntry("glue-watcher:seed-error", { type: watch.type, name: watch.name, message: (err as Error).message });
			}
		}

		const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
		if (!rt.paused && activeWatches.length > 0) startPolling(rt);
		refreshStatus(rt);
		if (rt.displayMode === "widget") rt.widget?.show(ctx);
		else rt.widget?.hide(ctx);

		if (Object.keys(rt.watches).length > 0) {
			setImmediate(() => {
				pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content: buildStartupChatMessage(rt.watches, new Date()),
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			});
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

	pi.registerCommand("glue-watcher", {
		description:
			"Manage Glue watcher. No args: open jobs view. Subcommands: enable, disable, status.",
		handler: (args, ctx) => runGlueWatcherCommand(args, ctx, rt, pi, client),
	});
}

/** Default export — wired to the real AWS CLI client. */
export default function glueWatcher(pi: ExtensionAPI): void {
	const client = createGlueClient();
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
export { handleToolAction, registerToolIfNeeded } from "./toolAction.js";
export { STATE_CUSTOM_TYPE } from "./persistence.js";
export { buildStatusLine, buildChangeChatMessage, buildStartupChatMessage } from "./format.js";
export { snapshotJobRun, snapshotWorkflowRun, detectJobChanges, detectWorkflowChanges } from "./poller.js";
export { createGlueClient, GlueCliError } from "./glue-client.js";
export type { GlueClient } from "./glue-client.js";
export type { GlueWatch, GlueEvent, WatchMap, WatchBaseline, JobBaseline, WorkflowBaseline } from "./types.js";
