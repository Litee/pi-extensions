/**
 * Tool-action handling for pi-file-system-watcher.
 *
 * The `file_system_watcher` tool is registered into pi's tool registry at
 * session_start but starts INACTIVE. The LLM must activate it via
 * manage_tools({action:"activate",tools:["file_system_watcher"]}) before use.
 */

import { randomBytes } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { writeState } from "./persistence.js";
import { snapshotPath } from "./poller.js";
import {
	refreshStatus,
	setupWatchFs,
	startPolling,
	stopPolling,
	teardownWatchFs,
	type Runtime,
} from "./runtime.js";
import type { FsWatch, TargetCondition, WatchMode } from "./types.js";

// ---------------------------------------------------------------------------
// Tool parameters (TypeBox)
// ---------------------------------------------------------------------------

/** Hard ceiling on watch duration. 24 h. */
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60; // 86_400 s

const TARGETS: ReadonlySet<TargetCondition> = new Set<TargetCondition>([
	"exists",
	"changed",
	"removed",
]);

export const FsWatcherParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("remove"),
			Type.Literal("list"),
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("status"),
		],
		{
			description:
				"add: start watching a filesystem path. " +
				"remove: stop watching by watchId. " +
				"list: show all watches. " +
				"pause / resume: toggle polling globally (persisted). " +
				"status: show runtime state.",
		},
	),
	path: Type.Optional(
		Type.String({
			description: "Absolute or relative filesystem path to watch (required for 'add').",
		}),
	),
	target: Type.Optional(
		Type.Union(
			[
				Type.Literal("exists"),
				Type.Literal("changed"),
				Type.Literal("removed"),
			],
			{
				description:
					"Condition to wait for (required for 'add'). " +
					"'exists': fire when the path appears. " +
					"'changed': fire when mtime or size changes from baseline (path must exist at add time). " +
					"'removed': fire when the path is deleted.",
			},
		),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"Optional. Cap the watch at this many seconds; defaults to 24 h (86400 s) if omitted. " +
				"Values above 24 h are silently capped at 24 h.",
		}),
	),
	watchId: Type.Optional(
		Type.String({ description: "Watch ID returned by 'add', required for 'remove'." }),
	),
	mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("auto"),
				Type.Literal("event"),
				Type.Literal("poll"),
			],
			{
				description:
					"Detection mode. " +
					"'auto' (default): try fs.watch for fast notifications, fall back to polling if unavailable. " +
					"'event': same as auto. " +
					"'poll': polling only, no fs.watch.",
			},
		),
	),
});

// ---------------------------------------------------------------------------
// Tool registration (once-only)
// ---------------------------------------------------------------------------

let toolRegistered = false;

/** Test-only: reset the one-shot guard so the tool can be re-registered. */
export function resetToolRegisteredForTests(): void {
	toolRegistered = false;
}

export function registerToolIfNeeded(pi: ExtensionAPI, rt: Runtime): void {
	if (toolRegistered) return;
	toolRegistered = true;
	pi.registerTool({
		name: "file_system_watcher",
		label: "FS Watcher",
		description:
			"Watch a local filesystem path for existence, change, or removal. " +
			"Polls stat() at increasing intervals (5 s → 5 min) and fires " +
			"exactly one chat notification when the target condition is met " +
			"(or when an optional timeout elapses). " +
			"Actions: add, remove, list, pause, resume, status.",
		parameters: FsWatcherParams,
		async execute(_toolCallId, params) {
			return handleToolAction(rt, params);
		},
	});
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface ToolResultContent {
	content: Array<{ type: "text"; text: string }>;
	details: {
		action: string;
		ok: boolean;
		message: string;
		watchId?: string;
		watches?: string[];
	};
}

function toolText(text: string): ToolResultContent["content"] {
	return [{ type: "text", text }];
}

export type ToolParams = {
	action: string;
	path?: string | undefined;
	target?: string | undefined;
	timeoutSeconds?: number | undefined;
	watchId?: string | undefined;
	mode?: string | undefined;
};

export async function handleToolAction(
	rt: Runtime,
	params: ToolParams,
): Promise<ToolResultContent> {
	switch (params.action) {
		case "add":
			return handleAdd(rt, params);
		case "remove":
			return handleRemove(rt, params);
		case "list":
			return handleList(rt);
		case "pause":
			return handlePause(rt);
		case "resume":
			return handleResume(rt);
		case "status":
			return handleStatus(rt);
		default: {
			const message = `file-system-watcher: unknown action ${JSON.stringify(params.action)}.`;
			return {
				content: toolText(message),
				details: { action: params.action, ok: false, message },
			};
		}
	}
}

async function handleAdd(rt: Runtime, params: ToolParams): Promise<ToolResultContent> {
	const watchPath = params.path?.trim() ?? "";
	if (!watchPath) {
		const message = "file-system-watcher: 'add' requires a 'path'.";
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}

	const target = params.target?.trim() ?? "";
	if (!TARGETS.has(target as TargetCondition)) {
		const message =
			"file-system-watcher: 'add' requires target to be 'exists', 'changed', or 'removed'.";
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}

	const requestedSeconds = params.timeoutSeconds;
	if (requestedSeconds !== undefined) {
		if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
			const message = "file-system-watcher: 'timeoutSeconds' must be a positive finite number.";
			return { content: toolText(message), details: { action: "add", ok: false, message } };
		}
	}
	const capped =
		requestedSeconds !== undefined && requestedSeconds > MAX_TIMEOUT_SECONDS;
	const effectiveSeconds =
		requestedSeconds !== undefined
			? Math.min(requestedSeconds, MAX_TIMEOUT_SECONDS)
			: MAX_TIMEOUT_SECONDS;
	const timeoutAt = rt.now() + effectiveSeconds * 1000;

	const rawMode = params.mode?.trim() ?? "";
	const mode: WatchMode =
		rawMode === "poll" ? "poll" : rawMode === "event" ? "event" : "auto";

	const watchId = randomBytes(4).toString("hex");
	const watch: FsWatch = {
		watchId,
		path: watchPath,
		target: target as TargetCondition,
		mode,
		timeoutAt,
		addedAt: rt.now(),
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
	};

	let seedError: string | undefined;
	try {
		// Use the injectable snapshot (rt.snapshot defaults to snapshotPath)
		const snap = rt.snapshot === snapshotPath
			? await snapshotPath(watchPath)
			: await rt.snapshot(watchPath);
		watch.baseline = snap;
	} catch (err) {
		seedError = (err as Error).message;
	}

	// For target='changed' the path must exist at add time — there's no mtime
	// to diff against otherwise.
	if (
		target === "changed" &&
		watch.baseline !== undefined &&
		!watch.baseline.exists
	) {
		const message =
			`file-system-watcher: target='changed' requires the path to exist at add time, ` +
			`but ${watchPath} is currently absent.`;
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}

	rt.watches[watchId] = watch;
	writeState(rt.pi, rt);

	// Set up fs.watch (mode != 'poll') for fast event notification.
	setupWatchFs(rt, watch);

	if (!rt.paused && !rt.scheduler.isRunning) startPolling(rt);
	rt.pi.events.emit("fs:change", {});
	refreshStatus(rt);

	const stateLabel =
		watch.baseline === undefined
			? "?"
			: watch.baseline.exists
				? "present"
				: "absent";
	const cappedNote = capped ? ` (capped from ${requestedSeconds}s)` : "";
	const timeoutLabel = ` timeout=${effectiveSeconds}s${cappedNote}`;
	const modeLabel = mode !== "auto" ? ` mode=${mode}` : "";
	const message = seedError
		? `file-system-watcher: added watch ${watchId} for ${watchPath} (target=${target}${timeoutLabel}${modeLabel}), but seeding failed (${seedError}). Will retry on next poll.`
		: `file-system-watcher: added watch ${watchId} for ${watchPath} (target=${target}${timeoutLabel}${modeLabel}) — baseline=${stateLabel}.`;
	return {
		content: toolText(message),
		details: {
			action: "add",
			ok: true,
			message,
			watchId,
			watches: Object.keys(rt.watches),
		},
	};
}

function handleRemove(rt: Runtime, params: ToolParams): ToolResultContent {
	const id = params.watchId?.trim() ?? "";
	if (!id) {
		const message = "file-system-watcher: 'remove' requires a watchId.";
		return { content: toolText(message), details: { action: "remove", ok: false, message } };
	}
	if (!(id in rt.watches)) {
		const message = `file-system-watcher: watch '${id}' not found.`;
		return { content: toolText(message), details: { action: "remove", ok: false, message } };
	}
	delete rt.watches[id];
	teardownWatchFs(rt, id);
	const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
	if (!anyActive) stopPolling(rt);
	writeState(rt.pi, rt);
	rt.pi.events.emit("fs:change", {});
	refreshStatus(rt);
	const message = `file-system-watcher: removed watch '${id}'. ${Object.keys(rt.watches).length} watch(es) remaining.`;
	return {
		content: toolText(message),
		details: { action: "remove", ok: true, message, watches: Object.keys(rt.watches) },
	};
}

function handleList(rt: Runtime): ToolResultContent {
	const ids = Object.keys(rt.watches);
	if (ids.length === 0) {
		const message = "file-system-watcher: no watches configured.";
		return {
			content: toolText(message),
			details: { action: "list", ok: true, message, watches: [] },
		};
	}
	const lines = ids.map((id) => {
		const w = rt.watches[id];
		if (!w) return `- [${id}] (missing)`;
		const state =
			w.baseline === undefined ? "?" : w.baseline.exists ? "present" : "absent";
		const term = w.terminal ? " [terminal]" : "";
		return `- [${id}] ${w.path} target=${w.target} mode=${w.mode} state=${state}${term}`;
	});
	const message = `file-system-watcher: ${ids.length} watch(es):\n${lines.join("\n")}`;
	return {
		content: toolText(message),
		details: { action: "list", ok: true, message, watches: ids },
	};
}

function handlePause(rt: Runtime): ToolResultContent {
	rt.paused = true;
	stopPolling(rt);
	writeState(rt.pi, rt);
	refreshStatus(rt);
	const message =
		"file-system-watcher: paused. Use the file_system_watcher resume action to re-enable polling.";
	return { content: toolText(message), details: { action: "pause", ok: true, message } };
}

function handleResume(rt: Runtime): ToolResultContent {
	rt.paused = false;
	writeState(rt.pi, rt);
	const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
	if (anyActive && !rt.scheduler.isRunning) startPolling(rt);
	refreshStatus(rt);
	const message = `file-system-watcher: resumed. Polling ${Object.keys(rt.watches).length} watch(es) every ${Math.round(rt.scheduler.intervalMs / 1000)}s.`;
	return { content: toolText(message), details: { action: "resume", ok: true, message } };
}

function handleStatus(rt: Runtime): ToolResultContent {
	const ids = Object.keys(rt.watches);
	const active = ids.filter((id) => !rt.watches[id]?.terminal).length;
	const terminal = ids.length - active;
	const label = rt.paused ? "paused" : "active";
	const message = [
		`file-system-watcher: ${label}`,
		`  watches: ${ids.length} total (${active} active, ${terminal} terminal)`,
		`  poll interval: ${Math.round(rt.scheduler.intervalMs / 1000)}s`,
	].join("\n");
	return { content: toolText(message), details: { action: "status", ok: true, message } };
}
