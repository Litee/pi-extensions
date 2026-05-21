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
 *  - ui/watches-view.ts — `/glue-watcher browse` overlay (shell)
 *  - ui/glue-widget.ts  — below-editor widget (shell)
 *
 * This file is strictly session/lifecycle wiring.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createWatcherMessageRenderer } from "pi-watcher-core/renderer";
import { seedMissingBaselines } from "pi-watcher-core/seed-baselines";
import { reconcileToolActivation, syncToolActiveState } from "pi-watcher-core/tool-activation";
import { extractUiSurface } from "pi-watcher-core/ui-surface";

import { createGlueClient, type GlueClient } from "./glue-client.js";
import { buildStartupChatMessage } from "./format.js";
import type { WatchMap } from "./types.js";
import { rehydrateStateFromSession, writeState } from "./persistence.js";
import { snapshotJobRun, snapshotWorkflowRun } from "./poller.js";
import { runGlueWatcherCommand } from "./command.js";
import {
	CUSTOM_MESSAGE_TYPE,
	makeRuntime,
	minIntervalMs,
	refreshStatus,
	startPolling,
	stopPolling,
	type Runtime,
} from "./runtime.js";
import { registerToolIfNeeded } from "./toolAction.js";
import { GlueWidget } from "./ui/glue-widget.js";

/**
 * Wire up the extension with a concrete or injected {@link GlueClient}.
 * Exported so tests can supply a stub client without touching the real CLI.
 */
export function createExtensionWithClient(pi: ExtensionAPI, client: GlueClient): void {
	const rt: Runtime = makeRuntime(pi, client);
	rt.widget = new GlueWidget(pi, () => rt.watches, () => minIntervalMs(rt));

	pi.on("session_start", async (_event, ctx) => {
		rt.ui = extractUiSurface(ctx);

		const state = rehydrateStateFromSession(ctx);
		rt.watches = state?.watches ?? {};
		rt.paused = state?.paused ?? false;
		rt.displayMode = state?.displayMode ?? "widget";

		// If watches survived the session log, the user must have enabled and
		// used the tool previously. Treat watches-present as an implicit
		// enabled=true so the widget and polling are restored even when the
		// session ended before turn_end could persist enabled=true (e.g. crash,
		// force-kill, or mid-turn reload).
		const hasActiveWatches = Object.values(rt.watches).some((w) => !w.terminal);
		rt.enabled = (state?.enabled ?? false) || hasActiveWatches;

		// Always register the tool into the registry so manage_tools({action:"list"})
		// shows it. Then sync its active-set membership with persisted `enabled`
		// state — so a restart where the user had previously run
		// /glue-watcher enable keeps the tool callable without forcing a
		// re-enable. If enabled=false, the tool is yanked out of the active set.
		registerToolIfNeeded(pi, rt);
		syncToolActiveState(pi, "glue_watcher", rt.enabled);

		await seedMissingBaselines(Object.values(rt.watches), {
			snapshot: (watch) =>
				watch.type === "job"
					? snapshotJobRun(client, watch)
					: snapshotWorkflowRun(client, watch),
			onError: (watch, err) => {
				rt.pi.appendEntry("glue-watcher:seed-error", {
					type: watch.type,
					name: watch.name,
					message: (err as Error).message,
				});
			},
		});

		const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
		if (!rt.paused && activeWatches.length > 0) startPolling(rt);
		refreshStatus(rt);
		if (rt.displayMode === "widget") rt.widget?.show(ctx);
		else rt.widget?.hide(ctx);

		if (Object.keys(rt.watches).length > 0) {
			setImmediate(() => {
				const pollMs = minIntervalMs(rt);
				pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content: buildStartupChatMessage(rt.watches, new Date(), { pollMs }),
						display: true,
						details: { watches: rt.watches, date: new Date().toISOString(), pollMs },
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			});
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		// Reconcile rt.enabled with whether `glue_watcher` is currently active
		// in pi's tool set. The LLM may have toggled the tool during this turn
		// via manage_tools; mirror that into rt.enabled so polling/widget/status
		// stay consistent with what the LLM can actually call.
		const intent = reconcileToolActivation("glue_watcher", rt.enabled, pi.getActiveTools());
		if (intent === "noop") return;

		if (intent === "activate") {
			rt.enabled = true;
			writeState(rt.pi, rt);
			const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
			if (!rt.paused && activeWatches.length > 0 && !rt.schedulers.size)
				startPolling(rt);
			refreshStatus(rt);
			if (rt.displayMode === "widget") rt.widget?.show(ctx);
			else rt.widget?.hide(ctx);
		} else {
			// deactivate: only remove from active tool set; keep polling and widget
			// running so change events still wake the LLM via triggerTurn: true.
			rt.enabled = false;
			writeState(rt.pi, rt);
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
		createWatcherMessageRenderer("pi-aws-glue-watcher", {
			expandedTextOverride: (message) => {
				if (
					message.details &&
					typeof message.details === "object" &&
					"watches" in message.details
				) {
					const d = message.details as { watches: WatchMap; date: string; pollMs?: number };
					return buildStartupChatMessage(d.watches, new Date(d.date), {
						expanded: true,
						...(typeof d.pollMs === "number" ? { pollMs: d.pollMs } : {}),
					});
				}
				return undefined;
			},
		}),
	);

	pi.registerCommand("glue-watcher", {
		description: "Control the Glue watcher (enable | disable | status | browse)",
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
	pollWatch,
	minIntervalMs,
	startWatchPolling,
	stopWatchPolling,
} from "./runtime.js";
export { handleToolAction, registerToolIfNeeded } from "./toolAction.js";
export { STATE_CUSTOM_TYPE } from "./persistence.js";
export { buildStatusLine, buildChangeChatMessage, buildStartupChatMessage, buildWatchEntry } from "./format.js";
export { snapshotJobRun, snapshotWorkflowRun, detectJobChanges, detectWorkflowChanges } from "./poller.js";
export { createGlueClient, GlueCliError } from "./glue-client.js";
export type { GlueClient } from "./glue-client.js";
export type { GlueWatch, GlueEvent, WatchMap, WatchBaseline, JobBaseline, WorkflowBaseline } from "./types.js";
