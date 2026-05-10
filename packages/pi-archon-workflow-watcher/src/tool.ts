/**
 * Tool registration + action handler for pi-archon-workflow-watcher.
 *
 * Registers an `archon_watcher` tool so the LLM can programmatically
 * interact with the watcher — checking status, pausing/resuming, and
 * triggering an immediate poll — without relying on the human-typed
 * `/archon-watcher` slash command.
 *
 * Extracted from index.ts so `handleToolAction` can be unit-tested
 * without a live pi-tui runtime.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import type { ArchonClient } from "./archon-client.js";
import { buildStartupChatMessage } from "./format.js";
import { writeRunState } from "./persistence.js";
import {
	CUSTOM_MESSAGE_TYPE,
	pollOnce,
	refreshStatus,
	startPolling,
	stopPolling,
	type Runtime,
} from "./runtime.js";
import type { RunSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ArchonWatcherParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("poll"),
		],
		{
			description:
				"status: fetch and return the current archon workflow run statuses. " +
				"pause: suspend background polling (persisted across sessions). " +
				"resume: resume background polling (persisted). " +
				"poll: run one immediate poll cycle now and return any detected changes.",
		},
	),
});

// ---------------------------------------------------------------------------
// Tool registration (lazy, once-only)
// ---------------------------------------------------------------------------

let toolRegistered = false;

/** Reset the registration flag between test runs. */
export function resetToolRegisteredForTests(): void {
	toolRegistered = false;
}

/**
 * Register the `archon_watcher` tool with pi. Safe to call multiple times —
 * subsequent calls are no-ops guarded by the module-level flag.
 */
export function registerToolIfNeeded(pi: ExtensionAPI, rt: Runtime): void {
	if (toolRegistered) return;
	toolRegistered = true;
	pi.registerTool({
		name: "archon_watcher",
		label: "Archon Workflow Watcher",
		description:
			"Interact with the background archon workflow watcher. " +
			"Use 'status' to see all current workflow run states, " +
			"'poll' to trigger an immediate check for changes, " +
			"'pause' to suspend polling, or 'resume' to re-enable it. " +
			"State-change notifications (paused, completed, failed) are " +
			"injected into chat automatically — you only need this tool " +
			"when you want to check status on demand or control polling.",
		promptSnippet:
			"archon_watcher({action}) — status | pause | resume | poll",
		parameters: ArchonWatcherParams,
		async execute(_toolCallId, params) {
			return handleToolAction(rt, params, pi);
		},
	});
}

export function addToolToActive(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (active.includes("archon_watcher")) return;
	pi.setActiveTools([...active, "archon_watcher"]);
}

// ---------------------------------------------------------------------------
// Tool action handler
// ---------------------------------------------------------------------------

export interface ToolResultContent {
	content: Array<{ type: "text"; text: string }>;
	details: { action: string; ok: boolean; message: string };
}

function toolText(text: string): ToolResultContent["content"] {
	return [{ type: "text", text }];
}

export type ToolParams = { action: string };

export async function handleToolAction(
	rt: Runtime,
	params: ToolParams,
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "getActiveTools" | "setActiveTools">,
): Promise<ToolResultContent> {
	switch (params.action) {
		case "status": {
			let runs: import("./types.js").ArchonRun[];
			try {
				runs = await rt.client.getWorkflowStatus();
			} catch (err) {
				const message = `archon-watcher: failed to fetch status: ${(err as Error).message}`;
				return { content: toolText(message), details: { action: "status", ok: false, message } };
			}
			const current: RunSnapshot = {};
			for (const run of runs) {
				if (run.id) current[run.id] = run;
			}
			const message = buildStartupChatMessage(current, new Date());
			return { content: toolText(message), details: { action: "status", ok: true, message } };
		}

		case "pause": {
			rt.paused = true;
			stopPolling(rt);
			writeRunState(pi, true);
			refreshStatus(rt);
			const message =
				"archon-watcher: paused. Background polling suspended. " +
				"Call archon_watcher({action:'resume'}) to re-enable.";
			return { content: toolText(message), details: { action: "pause", ok: true, message } };
		}

		case "resume": {
			rt.paused = false;
			writeRunState(pi, false);
			startPolling(rt);
			refreshStatus(rt);
			const activeCount = Object.keys(rt.snapshot).length;
			const message =
				`archon-watcher: resumed. Polling every ${Math.round(rt.pollIntervalMs / 1000)}s. ` +
				`${activeCount} run(s) currently tracked.`;
			return { content: toolText(message), details: { action: "resume", ok: true, message } };
		}

		case "poll": {
			await pollOnce(rt);
			// After the poll, snapshot reflects the latest state.
			const message = buildStartupChatMessage(rt.snapshot, new Date());
			// Send as a chat message so the LLM sees it in the conversation too.
			pi.sendMessage(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: message,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
			return { content: toolText(message), details: { action: "poll", ok: true, message } };
		}

		default: {
			const message = `archon-watcher: unknown action ${JSON.stringify(params.action)}.`;
			return { content: toolText(message), details: { action: params.action, ok: false, message } };
		}
	}
}
