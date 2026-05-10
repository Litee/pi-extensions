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
import {
	buildChangeChatMessage,
	buildStartupChatMessage,
	buildStatusLine,
} from "./format.js";
import {
	rehydrateRunStateFromSession,
	rehydrateSnapshotFromSession,
	writeRunState,
	writeSnapshot,
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
import { TERMINAL_STATUSES, type ArchonRun, type RunSnapshot } from "./types.js";

/** Colorize text with theme accent, falling back to plain text. */
function colorize(theme: UiSurface["theme"], text: string): string {
	return theme?.fg ? theme.fg("accent", text) : text;
}

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

		// Rehydrate run state (paused preference). Default: not paused.
		const sessionCtx = ctx as unknown as SessionLike;
		const runState = rehydrateRunStateFromSession(sessionCtx);
		const paused = runState?.paused === true;

		if (paused) {
			rt.paused = true;
			rt.ui?.setStatus?.(STATUS_KEY, undefined);
			return;
		}

		rt.paused = false;

		// Seed initial snapshot from archon workflow status (errors are not fatal)
		let initialRuns: ArchonRun[] = [];
		try {
			initialRuns = await client.getWorkflowStatus();
		} catch (err) {
			console.warn(
				`[archon-watcher] session_start: could not fetch initial status: ${(err as Error).message}`,
			);
		}

		const current: RunSnapshot = {};
		for (const run of initialRuns) {
			if (run.id) current[run.id] = run;
		}

		// Diff against persisted baseline and emit appropriate startup message.
		// Suppress all startup messages when there are no active runs — we don't
		// want to inject "No active workflow runs" noise on every session start.
		const baseline = rehydrateSnapshotFromSession(sessionCtx);
		const hasActiveRuns = Object.keys(current).length > 0;
		if (baseline !== null) {
			const events = detectChanges(baseline.snapshot, current);
			if (events.length > 0) {
				// Real changes since last session — always emit regardless of
				// whether runs are currently active.
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
			} else if (hasActiveRuns) {
				// No diff, but runs are active — brief summary, no turn trigger.
				emit(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content: buildStartupChatMessage(current, new Date()),
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			}
			// else: no changes and no active runs — stay silent.
		} else if (hasActiveRuns) {
			// No prior baseline but runs are active — emit startup summary.
			emit(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: buildStartupChatMessage(current, new Date()),
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
			// else: no prior baseline and no active runs — stay silent.
		}

		rt.snapshot = current;
		writeSnapshot(pi, current);
		startPolling(rt);

		// Pin status line using rt.ui (set above)
		const runCount = Object.keys(current).length;
		const activeCount = Object.values(current).filter(
			(r) => !TERMINAL_STATUSES.has(r.status),
		).length;
		const statusText = buildStatusLine({ paused: false, runCount, activeCount });
		rt.ui?.setStatus?.(STATUS_KEY, colorize(rt.ui.theme, statusText));
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
					writeRunState(pi, true);
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
					writeRunState(pi, false);
					startPolling(rt);
					// Set status via the command ctx UI.
					const runCount = Object.keys(rt.snapshot).length;
					const activeCount = Object.values(rt.snapshot).filter(
						(r) => !TERMINAL_STATUSES.has(r.status),
					).length;
					const statusText = buildStatusLine({
						paused: false,
						runCount,
						activeCount,
					});
					ui?.setStatus?.(STATUS_KEY, statusText);
					// Also refresh rt.ui if it differs from the command ctx UI.
					if (rt.ui !== null && rt.ui !== ui) {
						refreshStatus(rt);
					}
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
	RUNSTATE_ENTRY_TYPE,
	rehydrateSnapshotFromSession,
	rehydrateRunStateFromSession,
} from "./persistence.js";
export { POLL_INTERVAL_MS, POLL_INTERVAL_MAX_MS, ERROR_THRESHOLD } from "./runtime.js";
