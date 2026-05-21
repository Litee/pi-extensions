/**
 * Tool-action handling for pi-aws-glue-watcher.
 *
 * Extracted from index.ts so `handleToolAction` can be unit-tested
 * without any pi-tui dependency, and so tool registration guard state
 * has a single home.
 */

import { randomBytes } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	addToolToActive,
	reconcileToolActivation as coreReconcileToolActivation,
	removeToolFromActive as coreRemoveToolFromActive,
	syncToolActiveState as coreSyncToolActiveState,
} from "pi-watcher-core/tool-activation";
export type { ReconcileIntent } from "pi-watcher-core/tool-activation";

import { writeState } from "./persistence.js";
import { snapshotJobRun, snapshotWorkflowRun } from "./poller.js";
import {
	refreshStatus,
	startPolling,
	startWatchPolling,
	stopPolling,
	stopWatchPolling,
	type Runtime,
} from "./runtime.js";
import type { GlueWatch } from "./types.js";

// ---------------------------------------------------------------------------
// Tool parameters (TypeBox)
// ---------------------------------------------------------------------------

export const GlueWatcherParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("remove"),
			Type.Literal("list"),
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("status"),
			Type.Literal("set-interval"),
		],
		{
			description:
				"add: start watching a job or workflow run (seeds baseline immediately). " +
				"remove: stop watching a run by its watchId. " +
				"list: show the current watch list with state. " +
				"pause: suspend polling (persisted). " +
				"resume: resume polling (persisted). " +
				"status: show runtime state (enabled, paused, watch count, poll interval). " +
				"set-interval: update the poll interval for a specific watch (requires watchId and pollIntervalMs).",
		},
	),
	type: Type.Optional(
		Type.Union([Type.Literal("job"), Type.Literal("workflow")], {
			description: "Target kind for 'add': 'job' or 'workflow'.",
		}),
	),
	name: Type.Optional(
		Type.String({ description: "Glue job name or workflow name (required for 'add')." }),
	),
	runId: Type.Optional(
		Type.String({
			description:
				"Run ID (jr_… for jobs, wr_… for workflows). If omitted for 'add', the most recent run is used.",
		}),
	),
	profile: Type.Optional(
		Type.String({ description: "AWS credentials profile (required for 'add')." }),
	),
	region: Type.Optional(
		Type.String({ description: "AWS region. Uses the profile default when omitted." }),
	),
	watchId: Type.Optional(
		Type.String({ description: "Watch ID returned by 'add', required for 'remove' and 'set-interval'." }),
	),
	pollIntervalMs: Type.Optional(
		Type.Number({
			description: "Per-watch poll interval in milliseconds (minimum 5000). Used by 'add' and 'set-interval'.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Tool registration (lazy, once-only)
// ---------------------------------------------------------------------------

let toolRegistered = false;

/** Reset the module-level tool-registration flag between test runs. */
export function resetToolRegisteredForTests(): void {
	toolRegistered = false;
}

/**
 * Register the `glue_watcher` tool with pi. Safe to call multiple times —
 * subsequent calls are no-ops guarded by the module-level flag.
 */
export function registerToolIfNeeded(pi: ExtensionAPI, rt: Runtime): void {
	if (toolRegistered) return;
	toolRegistered = true;
	pi.registerTool({
		name: "glue_watcher",
		label: "Glue Watcher",
		description:
			"Manage the background AWS Glue job and workflow watcher. " +
			"Actions: add (start watching a run), remove (stop watching), " +
			"list (show all watches), pause (suspend polling), " +
			"resume (resume polling), status (show runtime state). " +
			"State-change events are injected into chat automatically.",
		parameters: GlueWatcherParams,
		async execute(_toolCallId, params) {
			return handleToolAction(rt, params);
		},
	});
}

// ---------------------------------------------------------------------------
// Backward-compat wrappers (glue-specific, tool name pre-bound)
// These preserve the old call signatures for tests and existing code.
// ---------------------------------------------------------------------------

/** @deprecated Use `addToolToActive(pi, "glue_watcher")` from pi-watcher-core/tool-activation. */
export function addToolToActiveGlue(pi: ExtensionAPI): void {
	addToolToActive(pi, "glue_watcher");
}

/** @deprecated Use `removeToolFromActive(pi, "glue_watcher")` from pi-watcher-core/tool-activation. */
export function removeToolFromActive(pi: ExtensionAPI): void {
	coreRemoveToolFromActive(pi, "glue_watcher");
}

/** @deprecated Use `syncToolActiveState(pi, "glue_watcher", enabled)` from pi-watcher-core/tool-activation. */
export function syncToolActiveState(pi: ExtensionAPI, enabled: boolean): void {
	coreSyncToolActiveState(pi, "glue_watcher", enabled);
}

/** @deprecated Use `reconcileToolActivation("glue_watcher", enabled, activeTools)` from pi-watcher-core/tool-activation. */
export function reconcileToolActivation(
	enabled: boolean,
	activeTools: readonly string[],
): import("pi-watcher-core/tool-activation").ReconcileIntent {
	return coreReconcileToolActivation("glue_watcher", enabled, activeTools);
}

// ---------------------------------------------------------------------------
// Tool action handler
// ---------------------------------------------------------------------------

export interface ToolResultContent {
	content: Array<{ type: "text"; text: string }>;
	details: {
		action: string;
		ok: boolean;
		message: string;
		watches?: string[];
	};
}

function toolText(text: string): ToolResultContent["content"] {
	return [{ type: "text", text }];
}

export type ToolParams = {
	action: string;
	type?: string | undefined;
	name?: string | undefined;
	runId?: string | undefined;
	profile?: string | undefined;
	region?: string | undefined;
	watchId?: string | undefined;
	pollIntervalMs?: number | undefined;
};

/** Handles every tool action; pure except for AWS calls. */
export async function handleToolAction(
	rt: Runtime,
	params: ToolParams,
): Promise<ToolResultContent> {
	switch (params.action) {
		case "add": {
			if (params.type !== "job" && params.type !== "workflow") {
				const message = `glue-watcher: 'add' requires type to be 'job' or 'workflow', got ${JSON.stringify(params.type ?? "")}.`;
				return { content: toolText(message), details: { action: "add", ok: false, message } };
			}
			const name = params.name?.trim() ?? "";
			if (!name) {
				const message = "glue-watcher: 'add' requires a non-empty name.";
				return { content: toolText(message), details: { action: "add", ok: false, message } };
			}
			const profile = params.profile?.trim() ?? "";
			if (!profile) {
				const message = "glue-watcher: 'add' requires a profile.";
				return { content: toolText(message), details: { action: "add", ok: false, message } };
			}
			const region = params.region?.trim() || undefined;
			const type = params.type;

			// Validate and clamp poll interval.
			const MIN_POLL_MS = 5_000;
			let watchPollMs: number | undefined;
			if (params.pollIntervalMs !== undefined) {
				if (!Number.isFinite(params.pollIntervalMs) || params.pollIntervalMs < MIN_POLL_MS) {
					const message = `glue-watcher: 'add' pollIntervalMs must be a finite number >= ${MIN_POLL_MS}ms.`;
					return { content: toolText(message), details: { action: "add", ok: false, message } };
				}
				watchPollMs = params.pollIntervalMs;
			}

			let runId = params.runId?.trim() ?? "";
			if (!runId) {
				try {
					runId =
						type === "job"
							? await rt.client.getLatestJobRunId(name, profile, region)
							: await rt.client.getLatestWorkflowRunId(name, profile, region);
				} catch (err) {
					const message = `glue-watcher: failed to fetch latest run ID for ${type} '${name}': ${(err as Error).message}`;
					return { content: toolText(message), details: { action: "add", ok: false, message } };
				}
			}

			const watchId = randomBytes(4).toString("hex");
			const watch: GlueWatch = {
				watchId,
				type,
				name,
				runId,
				profile,
				region,
				...(watchPollMs !== undefined ? { pollIntervalMs: watchPollMs } : {}),
				addedAt: Date.now(),
				lastPolledAt: undefined,
				baseline: undefined,
				terminal: false,
				consecutiveErrors: 0,
			};

			let seedError: string | undefined;
			try {
				watch.baseline =
					type === "job"
						? await snapshotJobRun(rt.client, watch)
						: await snapshotWorkflowRun(rt.client, watch);
			} catch (err) {
				seedError = (err as Error).message;
			}

			rt.watches[watchId] = watch;
			writeState(rt.pi, rt);
			if (!rt.paused) startWatchPolling(rt, watchId);
			rt.pi.events.emit("glue:change", {});
			refreshStatus(rt);

			const intervalNote = watchPollMs !== undefined ? ` | poll: ${Math.round(watchPollMs / 1000)}s` : "";
			const stateLabel = watch.baseline ? watch.baseline.state || "?" : "?";
			const message = watch.baseline
				? `glue-watcher: added ${type} '${name}' (${runId}) — state=${stateLabel}${intervalNote}. Watch ID: ${watchId}`
				: `glue-watcher: added ${type} '${name}' (${runId}), but seeding failed (${seedError ?? "unknown"})${intervalNote}. Watch ID: ${watchId}`;
			return {
				content: toolText(message),
				details: { action: "add", ok: true, message, watches: Object.keys(rt.watches) },
			};
		}

		case "remove": {
			const id = params.watchId?.trim() ?? "";
			if (!id) {
				const message = "glue-watcher: 'remove' requires a watchId.";
				return { content: toolText(message), details: { action: "remove", ok: false, message } };
			}
			if (!(id in rt.watches)) {
				const message = `glue-watcher: watch '${id}' not found.`;
				return { content: toolText(message), details: { action: "remove", ok: false, message } };
			}
			stopWatchPolling(rt, id);
			delete rt.watches[id];
			if (Object.keys(rt.watches).length === 0) stopPolling(rt);
			writeState(rt.pi, rt);
			rt.pi.events.emit("glue:change", {});
			refreshStatus(rt);
			const message = `glue-watcher: removed watch '${id}'. ${Object.keys(rt.watches).length} watch(es) remaining.`;
			return {
				content: toolText(message),
				details: { action: "remove", ok: true, message, watches: Object.keys(rt.watches) },
			};
		}

		case "list": {
			const ids = Object.keys(rt.watches);
			if (ids.length === 0) {
				const message = "glue-watcher: no watches configured.";
				return { content: toolText(message), details: { action: "list", ok: true, message, watches: [] } };
			}
			const lines = ids.map((id) => {
				const w = rt.watches[id];
				if (!w) return `- [${id}] (missing)`;
				const state = w.baseline ? w.baseline.state || "?" : "?";
				const interval = w.pollIntervalMs !== undefined ? ` | poll: ${Math.round(w.pollIntervalMs / 1000)}s` : "";
				return `- [${id}] ${w.type} '${w.name}' (${w.runId}) | state=${state}${w.terminal ? " [terminal]" : ""}${interval}`;
			});
			const message = `glue-watcher: ${ids.length} watch(es):\n${lines.join("\n")}`;
			return { content: toolText(message), details: { action: "list", ok: true, message, watches: ids } };
		}

		case "pause": {
			rt.paused = true;
			stopPolling(rt);
			writeState(rt.pi, rt);
			refreshStatus(rt);
			const message = "glue-watcher: paused. Use the glue_watcher resume action to re-enable polling.";
			return { content: toolText(message), details: { action: "pause", ok: true, message } };
		}

		case "resume": {
			rt.paused = false;
			writeState(rt.pi, rt);
			const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
			if (rt.enabled && activeWatches.length > 0) startPolling(rt);
			refreshStatus(rt);
			const message = `glue-watcher: resumed. Polling ${Object.keys(rt.watches).length} watch(es).`;
			return { content: toolText(message), details: { action: "resume", ok: true, message } };
		}

		case "status": {
			const ids = Object.keys(rt.watches);
			const activeCount = ids.filter((id) => !rt.watches[id]?.terminal).length;
			const terminalCount = ids.length - activeCount;
			const statusLabel = rt.paused ? "paused" : "active";
			const enabledLabel = rt.enabled ? "enabled" : "disabled";
			const intervalLines = ids.map((id) => {
				const w = rt.watches[id];
				if (!w) return "";
				const ms = w.pollIntervalMs !== undefined ? w.pollIntervalMs : undefined;
				return `    [${id}] ${w.name}: ${ms !== undefined ? `${Math.round(ms / 1000)}s` : "default"}`;
			}).filter(Boolean);
			const intervalSection = intervalLines.length > 0 ? `\n  per-watch intervals:\n${intervalLines.join("\n")}` : "";
			const message = [
				`glue-watcher: ${statusLabel} | ${enabledLabel}`,
				`  watches: ${ids.length} total (${activeCount} active, ${terminalCount} terminal)`,
			].join("\n") + intervalSection;
			return { content: toolText(message), details: { action: "status", ok: true, message } };
		}

		case "set-interval": {
			const id = params.watchId?.trim() ?? "";
			if (!id) {
				const message = "glue-watcher: 'set-interval' requires a watchId.";
				return { content: toolText(message), details: { action: "set-interval", ok: false, message } };
			}
			const watch = rt.watches[id];
			if (!watch) {
				const message = `glue-watcher: watch '${id}' not found.`;
				return { content: toolText(message), details: { action: "set-interval", ok: false, message } };
			}
			const MIN_POLL_MS = 5_000;
			if (params.pollIntervalMs === undefined || !Number.isFinite(params.pollIntervalMs) || params.pollIntervalMs < MIN_POLL_MS) {
				const message = `glue-watcher: 'set-interval' requires pollIntervalMs >= ${MIN_POLL_MS}ms.`;
				return { content: toolText(message), details: { action: "set-interval", ok: false, message } };
			}
			watch.pollIntervalMs = params.pollIntervalMs;
			// Restart this watch's scheduler with the new interval.
			stopWatchPolling(rt, id);
			if (!rt.paused && !watch.terminal) startWatchPolling(rt, id);
			writeState(rt.pi, rt);
			refreshStatus(rt);
			const message = `glue-watcher: poll interval for watch '${id}' set to ${Math.round(params.pollIntervalMs / 1000)}s.`;
			return { content: toolText(message), details: { action: "set-interval", ok: true, message } };
		}

		default: {
			const message = `glue-watcher: unknown action ${JSON.stringify(params.action)}.`;
			return { content: toolText(message), details: { action: params.action, ok: false, message } };
		}
	}
}
