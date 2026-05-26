/**
 * EC2 instance change detection.
 *
 * Pure module: no environment access, no persistence, no setInterval.
 * All I/O goes through the injected {@link Ec2Client}.
 *
 * Public surface:
 *   - {@link snapshotInstance}  — fetch current baseline, no diff.
 *   - {@link detectChanges}     — fetch + diff, emit at most one event.
 *   - {@link buildTimeoutEvent} — build a timeout event.
 */

import type { Ec2Client, InstanceStateResult } from "./ec2-client.js";
import {
	ALWAYS_TERMINAL_STATES,
	OPT_TERMINAL_STATES,
	type Ec2Baseline,
	type Ec2Event,
	type Ec2Watch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return `true` iff `state` is terminal given the watch's `stopOnStopped` flag. */
export function isTerminalState(
	state: string,
	stopOnStopped: boolean,
): boolean {
	if (ALWAYS_TERMINAL_STATES.has(state as never)) return true;
	if (stopOnStopped && OPT_TERMINAL_STATES.has(state as never)) return true;
	return false;
}

function buildNotFoundEvent(watch: Ec2Watch): Ec2Event {
	const summary = `EC2 instance ${watch.instanceId} was not found`;
	return {
		watchId: watch.watchId,
		instanceId: watch.instanceId,
		eventType: "not_found",
		previousState: watch.baseline?.state ?? "",
		newState: "",
		summary,
		formatted: `• ${summary} ✗`,
		isTerminal: true,
	};
}

function buildStateChangedEvent(
	watch: Ec2Watch,
	prevState: string,
	newState: string,
	terminal: boolean,
	nameTag: string | undefined,
): Ec2Event {
	const label = nameTag ? `${watch.instanceId} (${nameTag})` : watch.instanceId;
	const termIcon = terminal ? " ✓" : "";
	const summary = `EC2 ${label}: ${prevState} → ${newState}${termIcon}`;
	return {
		watchId: watch.watchId,
		instanceId: watch.instanceId,
		eventType: "state_changed",
		previousState: prevState as import("./types.js").Ec2InstanceState,
		newState: newState as import("./types.js").Ec2InstanceState,
		summary,
		formatted: `• ${summary}`,
		isTerminal: terminal,
	};
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type SnapshotResult = InstanceStateResult;

/** Fetch the current state of an EC2 instance with no diffing. */
export async function snapshotInstance(
	client: Ec2Client,
	watch: Ec2Watch,
): Promise<SnapshotResult> {
	return client.describeInstance(watch.instanceId, watch.profile, watch.region);
}

// ---------------------------------------------------------------------------
// detectChanges
// ---------------------------------------------------------------------------

export interface DetectChangesResult {
	/** At most one event per call. */
	events: Ec2Event[];
	/** Updated baseline to persist back into the watch record. `undefined` when instance not found. */
	newBaseline: Ec2Baseline | undefined;
	/**
	 * `true` iff any observable change was detected (state flip, not-found).
	 */
	observedChange: boolean;
}

/**
 * Poll an EC2 instance, diff against the watch's current baseline, and return
 * any events plus the refreshed baseline.
 */
export async function detectChanges(
	client: Ec2Client,
	watch: Ec2Watch,
): Promise<DetectChangesResult> {
	const now = await snapshotInstance(client, watch);

	// Instance not found
	if (now.notFound) {
		return {
			events: [buildNotFoundEvent(watch)],
			newBaseline: undefined,
			observedChange: true,
		};
	}

	const newState = now.state;
	if (!newState) {
		// No state returned — treat as no change, keep existing baseline.
		return {
			events: [],
			newBaseline: watch.baseline,
			observedChange: false,
		};
	}

	const newBaseline: Ec2Baseline = {
		state: newState,
		...(now.nameTag !== undefined ? { nameTag: now.nameTag } : {}),
		...(now.stateTransitionReason !== undefined
			? { stateTransitionReason: now.stateTransitionReason }
			: {}),
		...(now.availabilityZone !== undefined ? { availabilityZone: now.availabilityZone } : {}),
		...(now.instanceType !== undefined ? { instanceType: now.instanceType } : {}),
	};

	const prev = watch.baseline;

	// No prior baseline — install and emit no event.
	if (prev === undefined) {
		return {
			events: [],
			newBaseline,
			observedChange: false,
		};
	}

	const prevState = prev.state;

	// No state change
	if (prevState === newState) {
		return {
			events: [],
			newBaseline,
			observedChange: false,
		};
	}

	// State changed
	const terminal = isTerminalState(newState, watch.stopOnStopped);
	const event = buildStateChangedEvent(watch, prevState, newState, terminal, now.nameTag);
	return {
		events: [event],
		newBaseline,
		observedChange: true,
	};
}

// ---------------------------------------------------------------------------
// Timeout event
// ---------------------------------------------------------------------------

/** Build a `timeout` event for a watch whose `timeoutAt` has elapsed. */
export function buildTimeoutEvent(watch: Ec2Watch): Ec2Event {
	const summary = `EC2 instance ${watch.instanceId} timed out`;
	return {
		watchId: watch.watchId,
		instanceId: watch.instanceId,
		eventType: "timeout",
		previousState: watch.baseline?.state ?? "",
		newState: "",
		summary,
		formatted: `• ${summary} ✗`,
		isTerminal: true,
	};
}
