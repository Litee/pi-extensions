/**
 * pi-aws-ec2-watcher — pi extension entrypoint.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createWatcherMessageRenderer } from "pi-watcher-core/renderer";
import { seedMissingBaselines } from "pi-watcher-core/seed-baselines";
import { reconcileToolActivation, removeToolFromActive } from "pi-watcher-core/tool-activation";
import { extractUiSurface } from "pi-watcher-core/ui-surface";

import { runEc2WatcherCommand } from "./command.js";
import { loadConfig } from "./config.js";
import { buildStartupChatMessage } from "./format.js";
import { rehydrateStateFromSession, writeState } from "./persistence.js";
import { snapshotInstance } from "./poller.js";
import {
	CUSTOM_MESSAGE_TYPE,
	makeRuntime,
	refreshStatus,
	startPolling,
	stopPolling,
	TOOL_NAME,
	type Runtime,
} from "./runtime.js";
import { createEc2Client, type Ec2Client } from "./ec2-client.js";
import { registerToolIfNeeded } from "./toolAction.js";
import { Ec2Widget } from "./ui/ec2-widget.js";

export function createExtensionWithClient(pi: ExtensionAPI, client: Ec2Client): void {
	const rt: Runtime = makeRuntime(pi, client);
	rt.widget = new Ec2Widget(pi, () => rt.watches, () => rt.scheduler.intervalMs);

	pi.on("session_start", async (_event, ctx) => {
		rt.ui = extractUiSurface(ctx);

		registerToolIfNeeded(pi, rt);

		const state = rehydrateStateFromSession(ctx);
		rt.watches = state?.watches ?? {};
		rt.paused = state?.paused ?? false;
		rt.enabled = state?.enabled ?? false;
		const { defaultDisplayMode } = loadConfig();
		rt.displayMode = state?.displayMode ?? defaultDisplayMode ?? "widget";

		if (!rt.enabled) {
			removeToolFromActive(pi, TOOL_NAME);
		}

		await seedMissingBaselines(Object.values(rt.watches), {
			snapshot: async (watch) => {
				const r = await snapshotInstance(client, watch);
				if (r.notFound) throw new Error("Instance not found");
				if (!r.state) throw new Error("No state returned");
				const baseline: import("./types.js").Ec2Baseline = { state: r.state };
				if (r.nameTag !== undefined) baseline.nameTag = r.nameTag;
				if (r.stateTransitionReason !== undefined) baseline.stateTransitionReason = r.stateTransitionReason;
				if (r.availabilityZone !== undefined) baseline.availabilityZone = r.availabilityZone;
				if (r.instanceType !== undefined) baseline.instanceType = r.instanceType;
				return baseline;
			},
			onError: (watch, err) => {
				rt.pi.appendEntry("ec2-watcher:seed-error", {
					instanceId: watch.instanceId,
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
				pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content: buildStartupChatMessage(rt.watches, new Date()),
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			});
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		const intent = reconcileToolActivation(TOOL_NAME, rt.enabled, pi.getActiveTools());
		if (intent === "activate") {
			rt.enabled = true;
			writeState(pi, rt);
			const anyActive = Object.values(rt.watches).some((w) => !w.terminal);
			if (!rt.paused && anyActive && !rt.scheduler.isRunning) startPolling(rt);
			refreshStatus(rt);
		} else if (intent === "deactivate") {
			rt.enabled = false;
			writeState(pi, rt);
			refreshStatus(rt);
		}
		// Always update widget ctx so ec2:change events fired after an 'add'
		// in the same or subsequent turn can refresh the widget. Without this,
		// ctx is nulled out by hide() when show() is called with no watches
		// (at activate-time), and refresh() can never re-show the panel.
		if (rt.displayMode === "widget") rt.widget?.show(ctx);
		else rt.widget?.hide(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopPolling(rt);
		try {
			rt.widget?.hide(ctx);
			rt.widget?.destroy();
		} catch {
			/* noop */
		}
		rt.ui = null;
	});

	pi.registerMessageRenderer(
		CUSTOM_MESSAGE_TYPE,
		createWatcherMessageRenderer("pi-aws-ec2-watcher"),
	);

	pi.registerCommand("ec2-watcher", {
		description: "Open the EC2 instance watcher menu",
		handler: (args, ctx) => runEc2WatcherCommand(args, ctx, rt),
	});
}

export default function ec2InstanceWatcher(pi: ExtensionAPI): void {
	const client = createEc2Client();
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
export { runEc2WatcherCommand } from "./command.js";
export {
	handleToolAction,
	MAX_TIMEOUT_SECONDS,
	registerToolIfNeeded,
	resetToolRegisteredForTests,
} from "./toolAction.js";
export { STATE_CUSTOM_TYPE } from "./persistence.js";
export {
	buildStatusLine,
	buildChangeChatMessage,
	buildStartupChatMessage,
} from "./format.js";
export { snapshotInstance, detectChanges, buildTimeoutEvent } from "./poller.js";
export { createEc2Client, isNotFoundError } from "./ec2-client.js";
export { isValidInstanceId, validateInstanceId, InstanceIdError } from "./instanceId.js";
export type { Ec2Client, InstanceStateResult } from "./ec2-client.js";
export type {
	Ec2Watch,
	Ec2Event,
	WatchMap,
	Ec2Baseline,
	Ec2InstanceState,
} from "./types.js";
