/**
 * Tool registration + action handler for pi-archon-workflow-watcher.
 *
 * Registers an `archon_watcher` tool so the LLM can programmatically
 * manage the watch list and control polling.
 *
 * Actions:
 *   add    — register a run ID to watch (required before any tracking happens)
 *   remove — stop watching a run ID
 *   list   — fetch the global archon active runs (for run ID discovery)
 *   status — show current state of watched runs only
 *   poll   — trigger an immediate poll cycle of watched runs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { buildStartupChatMessage } from "./format.js";
import { writeState } from "./persistence.js";
import {
	CUSTOM_MESSAGE_TYPE,
	pollOnce,
	refreshStatus,
	startPolling,
	stopPolling,
	type Runtime,
} from "./runtime.js";
import type { ArchonRun } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ArchonWatcherParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("remove"),
			Type.Literal("status"),
			Type.Literal("poll"),
		],
		{
			description:
				"add: start watching a specific run ID — required before the watcher tracks anything. " +
				"remove: stop watching a run ID. " +
				"status: show current state of watched runs only. " +
				"poll: trigger an immediate poll of watched runs now.",
		},
	),
	runId: Type.Optional(
		Type.String({
			description: "Workflow run ID — required for 'add' and 'remove'.",
		}),
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
			"Manage the archon workflow watcher. " +
			"Call 'add' with a run ID to start watching it — get the ID from `archon workflow status --json`. " +
			"The watcher will automatically notify you when the run's status changes " +
			"(paused = waiting for input, disappeared = completed or failed). " +
			"Use 'status' to see watched runs, 'remove' to stop watching, " +
			"'poll' to check immediately.",
		promptSnippet:
			"archon_watcher({action, runId?}) — add | remove | status | poll",
		parameters: ArchonWatcherParams,
		async execute(_toolCallId, params) {
			return handleToolAction(rt, params, pi);
		},
	});
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

function ok(action: string, message: string): ToolResultContent {
	return { content: toolText(message), details: { action, ok: true, message } };
}

function err(action: string, message: string): ToolResultContent {
	return { content: toolText(message), details: { action, ok: false, message } };
}

export type ToolParams = { action: string; runId?: string };

export async function handleToolAction(
	rt: Runtime,
	params: ToolParams,
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "getActiveTools" | "setActiveTools">,
): Promise<ToolResultContent> {
	switch (params.action) {

		case "add": {
			const runId = params.runId?.trim() ?? "";
			if (!runId) {
				return err("add", "archon-watcher: 'add' requires a runId.");
			}
			if (rt.watchedIds.has(runId)) {
				return ok("add", `archon-watcher: already watching run '${runId}'.`);
			}
			// Seed the snapshot entry from the current global status.
			let match: ArchonRun | undefined;
			try {
				const runs = await rt.client.getWorkflowStatus();
				match = runs.find((r) => r.id === runId);
			} catch {
				// Non-fatal — we add to watchedIds even if seeding fails.
			}
			rt.watchedIds.add(runId);
			if (match) rt.snapshot[runId] = match;
			writeState(pi, { snapshot: rt.snapshot, watchedIds: rt.watchedIds });
			if (!rt.scheduler.isRunning) startPolling(rt);
			refreshStatus(rt);
			const label = match?.workflowName ?? runId;
			const state = match?.status ?? "unknown (run not found in active list)";
			return ok("add",
				`archon-watcher: watching '${label}' (${runId}) — status: ${state}. ` +
				`You will be notified automatically when the status changes.`,
			);
		}

		case "remove": {
			const runId = params.runId?.trim() ?? "";
			if (!runId) {
				return err("remove", "archon-watcher: 'remove' requires a runId.");
			}
			if (!rt.watchedIds.has(runId)) {
				return err("remove", `archon-watcher: '${runId}' is not in the watch list.`);
			}
			rt.watchedIds.delete(runId);
			delete rt.snapshot[runId];
			if (rt.watchedIds.size === 0) stopPolling(rt);
			writeState(pi, { snapshot: rt.snapshot, watchedIds: rt.watchedIds });
			refreshStatus(rt);
			return ok("remove",
				`archon-watcher: stopped watching '${runId}'. ` +
				`${rt.watchedIds.size} run(s) remaining.`,
			);
		}

		case "status": {
			if (rt.watchedIds.size === 0) {
				return ok("status",
					"archon-watcher: no runs being watched. " +
					"Call list to see active runs, then add with a run ID.",
				);
			}
			const message = buildStartupChatMessage(rt.snapshot, new Date());
			pi.sendMessage(
				{ customType: CUSTOM_MESSAGE_TYPE, content: message, display: true },
				{ deliverAs: "followUp", triggerTurn: false },
			);
			return ok("status", message);
		}

		case "poll": {
			if (rt.watchedIds.size === 0) {
				return ok("poll", "archon-watcher: no runs being watched — nothing to poll.");
			}
			await pollOnce(rt);
			const message = buildStartupChatMessage(rt.snapshot, new Date());
			pi.sendMessage(
				{ customType: CUSTOM_MESSAGE_TYPE, content: message, display: true },
				{ deliverAs: "followUp", triggerTurn: false },
			);
			return ok("poll", message);
		}

		default: {
			return err(params.action,
				`archon-watcher: unknown action ${JSON.stringify(params.action)}.`,
			);
		}
	}
}
