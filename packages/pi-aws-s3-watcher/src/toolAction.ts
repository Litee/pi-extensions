/**
 * Tool-action handling for pi-aws-s3-watcher.
 *
 * The `s3_watcher` tool is registered into pi's tool registry at
 * session_start but starts INACTIVE. The LLM must activate it via
 * manage_tools({action:"activate",tools:["s3_watcher"]}) before use.
 */

import { randomBytes } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { writeState } from "./persistence.js";
import { snapshotObject } from "./poller.js";
import {
	refreshStatus,
	startPolling,
	stopPolling,
	type Runtime,
} from "./runtime.js";
import type { S3Watch, TargetCondition } from "./types.js";
import { parseS3Uri, S3UriError } from "./uri.js";

// ---------------------------------------------------------------------------
// Tool parameters (TypeBox)
// ---------------------------------------------------------------------------

export const MAX_TIMEOUT_SECONDS = 72 * 60 * 60; // 259_200 s — hard ceiling for all watches

// ---------------------------------------------------------------------------

export const S3WatcherParams = Type.Object({
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
				"add: start watching an S3 object URI. " +
				"remove: stop watching by watchId. " +
				"list: show all watches. " +
				"pause / resume: toggle polling globally (persisted). " +
				"status: show runtime state (paused, watch count, poll interval).",
		},
	),
	uri: Type.Optional(
		Type.String({
			description:
				"Object URI in s3://bucket/key form (required for 'add').",
		}),
	),
	target: Type.Optional(
		Type.Union(
			[
				Type.Literal("exists"),
				Type.Literal("updated"),
				Type.Literal("removed"),
			],
			{
				description:
					"Condition to wait for (required for 'add'). 'exists': fire when the object appears. 'updated': fire when ETag/size changes from baseline (object must exist at add time). 'removed': fire when the object is deleted.",
			},
		),
	),
	profile: Type.Optional(
		Type.String({ description: "AWS credentials profile (required for 'add')." }),
	),
	region: Type.Optional(
		Type.String({ description: "AWS region. Falls back to profile default when omitted." }),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"Optional. Cap the watch at this many seconds; defaults to 72 h (259200 s) if omitted. Values above 72 h are silently capped at 72 h.",
		}),
	),
	watchId: Type.Optional(
		Type.String({ description: "Watch ID returned by 'add', required for 'remove'." }),
	),
});

// ---------------------------------------------------------------------------
// Tool registration (once-only)
// ---------------------------------------------------------------------------

let toolRegistered = false;

/** Test-only. */
export function resetToolRegisteredForTests(): void {
	toolRegistered = false;
}

export function registerToolIfNeeded(pi: ExtensionAPI, rt: Runtime): void {
	if (toolRegistered) return;
	toolRegistered = true;
	pi.registerTool({
		name: "s3_watcher",
		label: "S3 Watcher",
		description:
			"Watch an S3 object URI for existence, update, or removal. " +
			"Polls HeadObject at increasing intervals (60s → 15min) and fires " +
			"exactly one chat notification when the target condition is met " +
			"(or when an optional timeout elapses). " +
			"Actions: add, remove, list, pause, resume, status.",
		parameters: S3WatcherParams,
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
	uri?: string | undefined;
	target?: string | undefined;
	profile?: string | undefined;
	region?: string | undefined;
	timeoutSeconds?: number | undefined;
	watchId?: string | undefined;
};

const TARGETS: ReadonlySet<TargetCondition> = new Set<TargetCondition>([
	"exists",
	"updated",
	"removed",
]);

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
			const message = `s3-watcher: unknown action ${JSON.stringify(params.action)}.`;
			return {
				content: toolText(message),
				details: { action: params.action, ok: false, message },
			};
		}
	}
}

async function handleAdd(rt: Runtime, params: ToolParams): Promise<ToolResultContent> {
	const uri = params.uri?.trim() ?? "";
	if (!uri) {
		const message = "s3-watcher: 'add' requires 'uri' (s3://bucket/key).";
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}
	let parsed;
	try {
		parsed = parseS3Uri(uri);
	} catch (err) {
		const msg = err instanceof S3UriError ? err.message : String(err);
		const message = `s3-watcher: ${msg}`;
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}

	const target = params.target?.trim() ?? "";
	if (!TARGETS.has(target as TargetCondition)) {
		const message =
			"s3-watcher: 'add' requires target to be 'exists', 'updated', or 'removed'.";
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}
	const profile = params.profile?.trim() ?? "";
	if (!profile) {
		const message = "s3-watcher: 'add' requires a profile.";
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}
	const region = params.region?.trim() || undefined;

	const requestedSeconds = params.timeoutSeconds;
	if (requestedSeconds !== undefined) {
		if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
			const message =
				"s3-watcher: 'timeoutSeconds' must be a positive finite number.";
			return { content: toolText(message), details: { action: "add", ok: false, message } };
		}
	}
	const capped = requestedSeconds !== undefined && requestedSeconds > MAX_TIMEOUT_SECONDS;
	const effectiveSeconds = requestedSeconds !== undefined
		? Math.min(requestedSeconds, MAX_TIMEOUT_SECONDS)
		: MAX_TIMEOUT_SECONDS;
	const timeoutAt = rt.now() + effectiveSeconds * 1000;

	const watchId = randomBytes(4).toString("hex");
	const watch: S3Watch = {
		watchId,
		bucket: parsed.bucket,
		key: parsed.key,
		profile,
		region,
		target: target as TargetCondition,
		timeoutAt,
		addedAt: rt.now(),
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
	};

	let seedError: string | undefined;
	try {
		watch.baseline = await snapshotObject(rt.client, watch);
	} catch (err) {
		seedError = (err as Error).message;
	}

	// For target='updated' the baseline must exist — there's no ETag to diff
	// against otherwise. Reject the add up-front rather than silently never fire.
	if (target === "updated" && watch.baseline !== undefined && !watch.baseline.exists) {
		const message =
			`s3-watcher: target='updated' requires the object to exist at add-time, ` +
			`but s3://${parsed.bucket}/${parsed.key} is currently absent.`;
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}

	rt.watches[watchId] = watch;
	writeState(rt.pi, rt);
	if (!rt.paused && !rt.scheduler.isRunning) startPolling(rt);
	rt.pi.events.emit("s3:change", {});
	refreshStatus(rt);

	const stateLabel = watch.baseline === undefined
		? "?"
		: watch.baseline.exists
			? "present"
			: "absent";
	const cappedNote = capped ? ` (capped from ${requestedSeconds}s)` : "";
	const timeoutLabel = ` timeout=${effectiveSeconds}s${cappedNote}`;
	const message = seedError
		? `s3-watcher: added watch ${watchId} for s3://${parsed.bucket}/${parsed.key} (target=${target}${timeoutLabel}), but seeding failed (${seedError}). Will retry on next poll.`
		: `s3-watcher: added watch ${watchId} for s3://${parsed.bucket}/${parsed.key} (target=${target}${timeoutLabel}) — baseline=${stateLabel}.`;
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
		const message = "s3-watcher: 'remove' requires a watchId.";
		return { content: toolText(message), details: { action: "remove", ok: false, message } };
	}
	if (!(id in rt.watches)) {
		const message = `s3-watcher: watch '${id}' not found.`;
		return { content: toolText(message), details: { action: "remove", ok: false, message } };
	}
	delete rt.watches[id];
	const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
	if (!anyActive) stopPolling(rt);
	writeState(rt.pi, rt);
	rt.pi.events.emit("s3:change", {});
	refreshStatus(rt);
	const message = `s3-watcher: removed watch '${id}'. ${Object.keys(rt.watches).length} watch(es) remaining.`;
	return {
		content: toolText(message),
		details: { action: "remove", ok: true, message, watches: Object.keys(rt.watches) },
	};
}

function handleList(rt: Runtime): ToolResultContent {
	const ids = Object.keys(rt.watches);
	if (ids.length === 0) {
		const message = "s3-watcher: no watches configured.";
		return { content: toolText(message), details: { action: "list", ok: true, message, watches: [] } };
	}
	const lines = ids.map((id) => {
		const w = rt.watches[id];
		if (!w) return `- [${id}] (missing)`;
		const state = w.baseline === undefined
			? "?"
			: w.baseline.exists
				? "present"
				: "absent";
		const term = w.terminal ? " [terminal]" : "";
		return `- [${id}] s3://${w.bucket}/${w.key} target=${w.target} state=${state}${term}`;
	});
	const message = `s3-watcher: ${ids.length} watch(es):\n${lines.join("\n")}`;
	return { content: toolText(message), details: { action: "list", ok: true, message, watches: ids } };
}

function handlePause(rt: Runtime): ToolResultContent {
	rt.paused = true;
	stopPolling(rt);
	writeState(rt.pi, rt);
	refreshStatus(rt);
	const message = "s3-watcher: paused. Use the s3_watcher resume action to re-enable polling.";
	return { content: toolText(message), details: { action: "pause", ok: true, message } };
}

function handleResume(rt: Runtime): ToolResultContent {
	rt.paused = false;
	writeState(rt.pi, rt);
	const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
	if (anyActive && !rt.scheduler.isRunning) startPolling(rt);
	refreshStatus(rt);
	const message = `s3-watcher: resumed. Polling ${Object.keys(rt.watches).length} watch(es) every ${Math.round(rt.scheduler.intervalMs / 1000)}s.`;
	return { content: toolText(message), details: { action: "resume", ok: true, message } };
}

function handleStatus(rt: Runtime): ToolResultContent {
	const ids = Object.keys(rt.watches);
	const active = ids.filter((id) => !rt.watches[id]?.terminal).length;
	const terminal = ids.length - active;
	const label = rt.paused ? "paused" : "active";
	const message = [
		`s3-watcher: ${label}`,
		`  watches: ${ids.length} total (${active} active, ${terminal} terminal)`,
		`  poll interval: ${Math.round(rt.scheduler.intervalMs / 1000)}s`,
	].join("\n");
	return { content: toolText(message), details: { action: "status", ok: true, message } };
}
