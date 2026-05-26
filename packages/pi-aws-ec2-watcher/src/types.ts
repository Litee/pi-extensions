/**
 * Types shared across the pi-aws-ec2-watcher modules.
 */

/** EC2 instance lifecycle states (as returned by the AWS API). */
export type Ec2InstanceState =
	| "pending"
	| "running"
	| "shutting-down"
	| "terminated"
	| "stopping"
	| "stopped";

/**
 * States from which an EC2 instance never returns. `terminated` is always
 * terminal; `stopped` is terminal when the watch has `stopOnStopped=true`.
 */
export const ALWAYS_TERMINAL_STATES: ReadonlySet<Ec2InstanceState> = new Set<Ec2InstanceState>([
	"terminated",
]);

/** States that are terminal only when `stopOnStopped===true`. */
export const OPT_TERMINAL_STATES: ReadonlySet<Ec2InstanceState> = new Set<Ec2InstanceState>([
	"stopped",
]);

/**
 * Point-in-time observation of an EC2 instance.
 */
export interface Ec2Baseline {
	state: Ec2InstanceState;
	/** Value of the `Name` tag (if present). */
	nameTag?: string;
	/** Human-readable reason for the last state transition (if provided by AWS). */
	stateTransitionReason?: string;
	/** Availability zone, e.g. `us-east-1a`. */
	availabilityZone?: string;
	/** Instance type, e.g. `t3.micro`. */
	instanceType?: string;
}

/** A single active watch. One record per `watchId`. */
export interface Ec2Watch {
	watchId: string;
	instanceId: string;
	/** AWS credentials profile. */
	profile: string;
	/** AWS region; `undefined` falls back to the profile default. */
	region: string | undefined;
	/**
	 * When `true`, the watch is considered terminal once the instance
	 * reaches `stopped` state (in addition to the always-terminal
	 * `terminated` state).
	 */
	stopOnStopped: boolean;
	/**
	 * Absolute epoch ms at which a `timeout` event fires. `undefined` means
	 * no timeout.
	 */
	timeoutAt: number | undefined;
	addedAt: number;
	lastPolledAt: number | undefined;
	/**
	 * Last observed state. `undefined` when seeding on `add` failed — the
	 * poll loop will retry on the next tick.
	 */
	baseline: Ec2Baseline | undefined;
	/** `true` once the instance has reached a terminal state OR the timeout elapsed. */
	terminal: boolean;
	/** Consecutive poll failures; reset to 0 on success. */
	consecutiveErrors: number;
}

/** Map of watchId → Ec2Watch. Serialisable to JSON as-is. */
export type WatchMap = Record<string, Ec2Watch>;

/** A single detected event emitted by the poll loop. */
export interface Ec2Event {
	watchId: string;
	instanceId: string;
	/**
	 * `state_changed`: the instance state changed from `previousState` to `newState`.
	 * `not_found`: the instance was not found in the AWS account/region.
	 * `timeout`: `timeoutAt` elapsed before a terminal state was reached.
	 */
	eventType: "state_changed" | "not_found" | "timeout";
	/** Previous state, empty string when no prior baseline. */
	previousState: Ec2InstanceState | "";
	/** New state, empty string for `not_found`/`timeout`. */
	newState: Ec2InstanceState | "";
	/** Human-readable one-liner. */
	summary: string;
	/** Bullet-list line for chat messages (includes `"• "` prefix). */
	formatted: string;
	/** `true` when this event marks the watch as done. */
	isTerminal: boolean;
}
