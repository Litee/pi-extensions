/**
 * Tool-action handling for pi-aws-ec2-watcher.
 */

import { randomBytes } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { writeState } from "./persistence.js";
import { snapshotInstance } from "./poller.js";
import {
	refreshStatus,
	startPolling,
	stopPolling,
	type Runtime,
} from "./runtime.js";
import { validateInstanceId, InstanceIdError } from "./instanceId.js";

// ---------------------------------------------------------------------------
// Tool parameters (TypeBox)
// ---------------------------------------------------------------------------

export const MAX_TIMEOUT_SECONDS = 72 * 60 * 60; // 259_200 s

export const Ec2WatcherParams = Type.Object({
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
				"add: start watching an EC2 instance by ID. " +
				"remove: stop watching by watchId. " +
				"list: show all watches. " +
				"pause / resume: toggle polling globally (persisted). " +
				"status: show runtime state (paused, watch count, poll interval).",
		},
	),
	instanceId: Type.Optional(
		Type.String({
			description:
				"EC2 instance ID in the format i-[0-9a-f]{8,17} (required for 'add').",
		}),
	),
	profile: Type.Optional(
		Type.String({ description: "AWS credentials profile (required for 'add')." }),
	),
	region: Type.Optional(
		Type.String({
			description: "AWS region. Falls back to profile default when omitted.",
		}),
	),
	stopOnStopped: Type.Optional(
		Type.Boolean({
			description:
				"When true, the watch is marked terminal when the instance reaches 'stopped' state. Defaults to false.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"Optional. Cap the watch at this many seconds. Values above 72 h (259200 s) are capped. Defaults to 72 h (259200 s) if omitted.",
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
		name: "ec2_instance_watcher",
		label: "EC2 Instance Watcher",
		description:
			"Watch an AWS EC2 instance for state transitions (pending → running → stopping → stopped → terminated). " +
			"Polls DescribeInstances at increasing intervals (60s → 10min) and fires a chat notification " +
			"whenever the instance state changes. " +
			"Actions: add, remove, list, pause, resume, status.",
		parameters: Ec2WatcherParams,
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
	instanceId?: string | undefined;
	profile?: string | undefined;
	region?: string | undefined;
	stopOnStopped?: boolean | undefined;
	timeoutSeconds?: number | undefined;
	watchId?: string | undefined;
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
			const message = `ec2-watcher: unknown action ${JSON.stringify(params.action)}.`;
			return {
				content: toolText(message),
				details: { action: params.action, ok: false, message },
			};
		}
	}
}

async function handleAdd(rt: Runtime, params: ToolParams): Promise<ToolResultContent> {
	const instanceIdRaw = params.instanceId?.trim() ?? "";
	if (!instanceIdRaw) {
		const message = "ec2-watcher: 'add' requires 'instanceId' (e.g. i-0a1b2c3d4e5f67890).";
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}

	let instanceId: string;
	try {
		instanceId = validateInstanceId(instanceIdRaw);
	} catch (err) {
		const msg = err instanceof InstanceIdError ? err.message : String(err);
		const message = `ec2-watcher: ${msg}`;
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}

	const profile = params.profile?.trim() ?? "";
	if (!profile) {
		const message = "ec2-watcher: 'add' requires a profile.";
		return { content: toolText(message), details: { action: "add", ok: false, message } };
	}
	const region = params.region?.trim() || undefined;
	const stopOnStopped = params.stopOnStopped ?? false;

	const requestedSeconds = params.timeoutSeconds;
	if (requestedSeconds !== undefined) {
		if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
			const message = "ec2-watcher: 'timeoutSeconds' must be a positive finite number.";
			return { content: toolText(message), details: { action: "add", ok: false, message } };
		}
	}
	const capped = requestedSeconds !== undefined && requestedSeconds > MAX_TIMEOUT_SECONDS;
	const effectiveSeconds =
		requestedSeconds !== undefined
			? Math.min(requestedSeconds, MAX_TIMEOUT_SECONDS)
			: MAX_TIMEOUT_SECONDS;
	const timeoutAt = rt.now() + effectiveSeconds * 1000;

	const watchId = randomBytes(4).toString("hex");
	const watch = {
		watchId,
		instanceId,
		profile,
		region,
		stopOnStopped,
		timeoutAt,
		addedAt: rt.now(),
		lastPolledAt: undefined as number | undefined,
		baseline: undefined as import("./types.js").Ec2Baseline | undefined,
		terminal: false,
		consecutiveErrors: 0,
	};

	let seedError: string | undefined;
	try {
		const snapshot = await snapshotInstance(rt.client, watch);
		if (snapshot.notFound) {
			const message = `ec2-watcher: instance '${instanceId}' was not found in profile '${profile}'${region ? ` / region '${region}'` : ""}. Verify the instance ID, profile, and region.`;
			return { content: toolText(message), details: { action: "add", ok: false, message } };
		}
		// Build baseline from snapshot
		if (!snapshot.state) {
			const message = `ec2-watcher: instance '${instanceId}' has no state available. Cannot set up watch.`;
			return { content: toolText(message), details: { action: "add", ok: false, message } };
		}
		watch.baseline = {
			state: snapshot.state,
			...(snapshot.nameTag !== undefined ? { nameTag: snapshot.nameTag } : {}),
			...(snapshot.stateTransitionReason !== undefined
				? { stateTransitionReason: snapshot.stateTransitionReason }
				: {}),
			...(snapshot.availabilityZone !== undefined
				? { availabilityZone: snapshot.availabilityZone }
				: {}),
			...(snapshot.instanceType !== undefined ? { instanceType: snapshot.instanceType } : {}),
		};
	} catch (err) {
		seedError = (err as Error).message;
	}

	rt.watches[watchId] = watch;
	writeState(rt.pi, rt);
	if (!rt.paused && !rt.scheduler.isRunning) startPolling(rt);
	rt.pi.events.emit("ec2:change", {});
	refreshStatus(rt);

	const stateLabel = watch.baseline?.state ?? "?";
	const cappedNote = capped ? ` (capped from ${requestedSeconds}s)` : "";
	const timeoutLabel = ` timeout=${effectiveSeconds}s${cappedNote}`;
	const message = seedError
		? `ec2-watcher: added watch ${watchId} for ${instanceId}${timeoutLabel}, but seeding failed (${seedError}). Will retry on next poll.`
		: `ec2-watcher: added watch ${watchId} for ${instanceId}${timeoutLabel} — state=${stateLabel}.`;
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
		const message = "ec2-watcher: 'remove' requires a watchId.";
		return { content: toolText(message), details: { action: "remove", ok: false, message } };
	}
	if (!(id in rt.watches)) {
		const message = `ec2-watcher: watch '${id}' not found.`;
		return { content: toolText(message), details: { action: "remove", ok: false, message } };
	}
	delete rt.watches[id];
	const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
	if (!anyActive) stopPolling(rt);
	writeState(rt.pi, rt);
	rt.pi.events.emit("ec2:change", {});
	refreshStatus(rt);
	const message = `ec2-watcher: removed watch '${id}'. ${Object.keys(rt.watches).length} watch(es) remaining.`;
	return {
		content: toolText(message),
		details: {
			action: "remove",
			ok: true,
			message,
			watches: Object.keys(rt.watches),
		},
	};
}

function handleList(rt: Runtime): ToolResultContent {
	const ids = Object.keys(rt.watches);
	if (ids.length === 0) {
		const message = "ec2-watcher: no watches configured.";
		return {
			content: toolText(message),
			details: { action: "list", ok: true, message, watches: [] },
		};
	}
	const lines = ids.map((id) => {
		const w = rt.watches[id];
		if (!w) return `- [${id}] (missing)`;
		const state = w.baseline?.state ?? "?";
		const term = w.terminal ? " [terminal]" : "";
		return `- [${id}] ${w.instanceId} state=${state}${term}`;
	});
	const message = `ec2-watcher: ${ids.length} watch(es):\n${lines.join("\n")}`;
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
		"ec2-watcher: paused. Use the ec2_instance_watcher resume action to re-enable polling.";
	return { content: toolText(message), details: { action: "pause", ok: true, message } };
}

function handleResume(rt: Runtime): ToolResultContent {
	rt.paused = false;
	writeState(rt.pi, rt);
	const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
	if (anyActive && !rt.scheduler.isRunning) startPolling(rt);
	refreshStatus(rt);
	const message = `ec2-watcher: resumed. Polling ${Object.keys(rt.watches).length} watch(es) every ${Math.round(rt.scheduler.intervalMs / 1000)}s.`;
	return { content: toolText(message), details: { action: "resume", ok: true, message } };
}

function handleStatus(rt: Runtime): ToolResultContent {
	const ids = Object.keys(rt.watches);
	const active = ids.filter((id) => !rt.watches[id]?.terminal).length;
	const terminal = ids.length - active;
	const label = rt.paused ? "paused" : "active";
	const message = [
		`ec2-watcher: ${label}`,
		`  watches: ${ids.length} total (${active} active, ${terminal} terminal)`,
		`  poll interval: ${Math.round(rt.scheduler.intervalMs / 1000)}s`,
	].join("\n");
	return { content: toolText(message), details: { action: "status", ok: true, message } };
}
