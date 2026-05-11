/**
 * pi-archon-workflow-watcher — pi extension.
 *
 * Polls `archon workflow status --json` on a 15-second interval and injects
 * state-change notifications into pi chat as custom-typed messages.
 *
 * Control flow
 * ------------
 *   session_start:
 *     1. Detect if there's UI.
 *     2. Rehydrate runstate (paused preference).
 *     3. If paused: clear status line, return.
 *     4. Seed initial snapshot from archon workflow status (catch errors gracefully).
 *     5a. If diff vs persisted baseline: emit startup diff message.
 *     5b. Else: emit startup summary message (triggerTurn: false).
 *     6. Start polling.
 *     7. Pin status line.
 *
 *   session_shutdown:
 *     - Clear the poll interval and unpin status.
 *
 *   /archon-watcher (pause|resume|status|<no args>):
 *     - Toggle pause state or print a status summary.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

import {
	createArchonClient,
	type ArchonClient,
} from "./archon-client.js";
import { addToolToActive, registerToolIfNeeded } from "./tool.js";
import {
	buildChangeChatMessage,
	buildStartupChatMessage,
} from "./format.js";
import {
	rehydrateStateFromSession,
	writeState,
	type SessionLike,
} from "./persistence.js";
import { detectChanges } from "./poller.js";
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
import { type ArchonRun, type RunSnapshot } from "./types.js";

/**
 * Wire up the extension with a concrete or injected ArchonClient.
 * Exported so tests can supply a stub client without touching the real CLI.
 */
export function createExtensionWithClient(
	pi: ExtensionAPI,
	client: ArchonClient,
): void {
	const rt: Runtime = makeRuntime(pi, client);

	pi.on("session_start", async (_event, ctx) => {
		const anyCtx = ctx as unknown as { hasUI?: boolean; ui?: UiSurface };
		const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
		rt.ui = hasUI ? ((anyCtx.ui as UiSurface) ?? null) : null;

		/**
		 * Defer every pi.sendMessage emitted during session_start to the next
		 * setImmediate tick so the interactive UI renders the chat bubble
		 * before the LLM turn absorbs the content.
		 */
		const emit: typeof pi.sendMessage = ((message, options) => {
			setImmediate(() => pi.sendMessage(message, options));
		}) as typeof pi.sendMessage;

		// Rehydrate combined state (paused preference + watchedIds + snapshot).
		const sessionCtx = ctx as unknown as SessionLike;
		const state = rehydrateStateFromSession(sessionCtx);
		const paused = state?.paused === true;

		if (paused) {
			rt.paused = true;
			rt.ui?.setStatus?.(STATUS_KEY, undefined);
			return;
		}

		rt.paused = false;

		// Register the archon_watcher tool (once-only guard inside).
		registerToolIfNeeded(pi, rt);
		addToolToActive(pi);

		// Rehydrate watched IDs and last-known snapshot.
		// If no IDs are persisted, skip the archon CLI call entirely —
		// there is nothing to watch and no reason to touch archon.
		if (!state || state.watchedIds.length === 0) {
			// Nothing to watch — stay completely silent.
			return;
		}

		// Restore watched IDs.
		for (const id of state.watchedIds) rt.watchedIds.add(id);

		// Fetch current status and filter to watched IDs only.
		let initialRuns: ArchonRun[] = [];
		try {
			initialRuns = await client.getWorkflowStatus();
		} catch (e) {
			rt.pi.appendEntry("archon-watcher:init-error", { message: (e as Error).message });
		}

		const current: RunSnapshot = {};
		for (const run of initialRuns) {
			if (run.id && rt.watchedIds.has(run.id)) current[run.id] = run;
		}

		// Diff against persisted snapshot and emit startup message if anything changed.
		const events = detectChanges(state.snapshot, current);
		if (events.length > 0) {
			const triggerTurn = events.some((e) => e.shouldTriggerTurn);
			emit(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: buildChangeChatMessage(events, new Date()),
					display: true,
					details: { events },
				},
				{ deliverAs: "followUp", triggerTurn },
			);
			// Auto-remove runs that ended between sessions.
			for (const event of events) {
				if (event.eventType === "run_removed") rt.watchedIds.delete(event.runId);
			}
		} else if (Object.keys(current).length > 0) {
			// Watched runs are active and unchanged — brief summary, no turn trigger.
			emit(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: buildStartupChatMessage(current, new Date()),
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
		}
		// else: watched IDs exist but no longer active (already ended) — stay silent.

		rt.snapshot = current;
		writeState(pi, { snapshot: current, watchedIds: rt.watchedIds, paused: rt.paused });
		if (rt.watchedIds.size > 0) startPolling(rt);
		refreshStatus(rt);
	});

	pi.on("session_shutdown", async () => {
		stopPolling(rt);
		try {
			rt.ui?.setStatus?.(STATUS_KEY, undefined);
		} catch {
			/* noop — UI may already be torn down */
		}
		rt.ui = null;
	});

	// Renderer: box with label `pi-archon-workflow-watcher`
	pi.registerMessageRenderer(
		CUSTOM_MESSAGE_TYPE,
		(message, _options, theme) => {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(
								(c): c is { type: "text"; text: string } => c.type === "text",
							)
							.map((c) => c.text)
							.join("\n");
			const label = theme.bold(
				theme.fg("customMessageLabel", "pi-archon-workflow-watcher"),
			);
			const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(`${label}\n\n${text}`, 0, 0));
			return box;
		},
	);

	pi.registerCommand("archon-watcher", {
		description: "Control the archon workflow watcher (pause/resume/status)",
		handler: async (args, ctx) => {
			const anyCtx = ctx as unknown as {
				hasUI?: boolean;
				ui?: UiSurface;
			};
			const hasUI =
				anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
			const ui = hasUI ? (anyCtx.ui as UiSurface) : undefined;
			const sub = args.trim().toLowerCase();

			switch (sub) {
				case "pause": {
					rt.paused = true;
					stopPolling(rt);
					writeState(pi, { snapshot: rt.snapshot, watchedIds: rt.watchedIds, paused: true });
					// Clear status via the command ctx UI (always available) and
					// rt.ui (set by session_start, may be null or same object).
					ui?.setStatus?.(STATUS_KEY, undefined);
					if (rt.ui !== null && rt.ui !== ui) {
						rt.ui.setStatus?.(STATUS_KEY, undefined);
					}
					ui?.notify?.("archon-workflow-watcher: paused", "info");
					return;
				}
				case "resume": {
					rt.paused = false;
					writeState(pi, { snapshot: rt.snapshot, watchedIds: rt.watchedIds, paused: false });
					startPolling(rt);
					// refreshStatus handles the no-active-runs case by clearing the row.
					refreshStatus(rt);
					ui?.notify?.("archon-workflow-watcher: resumed", "info");
					return;
				}
				case "":
				case "status": {
					let runs: ArchonRun[] = [];
					try {
						runs = await client.getWorkflowStatus();
					} catch (err) {
						ui?.notify?.(
							`archon-workflow-watcher: error fetching status: ${(err as Error).message}`,
							"warning",
						);
						return;
					}
					const current: RunSnapshot = {};
					for (const run of runs) {
						if (run.id) current[run.id] = run;
					}
					pi.sendMessage({
						customType: CUSTOM_MESSAGE_TYPE,
						content: buildStartupChatMessage(current, new Date()),
						display: true,
					});
					return;
				}
				default:
					ui?.notify?.(
						`archon-workflow-watcher: unknown subcommand '${sub}'. Use: pause | resume | status`,
						"warning",
					);
			}
		},
	});
}

/** Default export — creates a real archon CLI client and activates the extension. */
export default function archonWorkflowWatcher(pi: ExtensionAPI): void {
	createExtensionWithClient(pi, createArchonClient());
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
	STATE_ENTRY_TYPE,
	rehydrateStateFromSession,
	writeState,
} from "./persistence.js";
export { POLL_INTERVAL_MS, POLL_INTERVAL_MAX_MS, ERROR_THRESHOLD } from "./runtime.js";
export { handleToolAction, registerToolIfNeeded, resetToolRegisteredForTests } from "./tool.js";
