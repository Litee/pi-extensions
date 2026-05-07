/**
 * Types shared across the pi-aws-glue-watcher modules.
 *
 * Mirrors the state tracked by the Python reference watchers
 * (watch_glue_job.py / watch_glue_workflow.py) so change-detection
 * behaviour stays in lock-step: job state + error message for jobs;
 * workflow status + action statistics + per-node failure tracking
 * for workflows.
 */

/** Target kind — discriminates job watches from workflow watches. */
export type WatchType = "job" | "workflow";

/** AWS Glue job states that mark a run as permanently finished. */
export const JOB_TERMINAL_STATES = new Set([
	"SUCCEEDED", "FAILED", "STOPPED", "ERROR", "TIMEOUT",
]);

/** AWS Glue workflow run statuses that mark a run as permanently finished. */
export const WORKFLOW_TERMINAL_STATES = new Set([
	"COMPLETED", "STOPPED", "ERROR",
]);

/** Node states treated as failures when scanning a workflow graph. */
export const NODE_FAILURE_STATES = new Set(["FAILED", "ERROR", "TIMEOUT"]);

// ---------------------------------------------------------------------------
// Baseline snapshots
// ---------------------------------------------------------------------------

/**
 * Point-in-time snapshot for a Glue job run. Serialises cleanly through
 * JSON; no special types.
 */
export interface JobBaseline {
	/** e.g. "RUNNING", "SUCCEEDED" */
	state: string;
	errorMessage: string;
	/** ISO-8601 timestamp when the run started (from AWS Glue API). */
	startedOn?: string;
	/** Configured number of workers for this run. */
	numberOfWorkers?: number;
	/** Worker type, e.g. "G.1X", "G.2X", "G.025X", "Standard". */
	workerType?: string;
}

/** Per-node snapshot stored inside a WorkflowBaseline. JOB nodes only. */
export interface WorkflowNodeInfo {
	name: string;
	state: string;
	startedOn?: string;
	numberOfWorkers?: number;
	workerType?: string;
}

/**
 * Point-in-time snapshot for a Glue workflow run. Includes action
 * statistics and the set of node names already reported as failed, so
 * re-processing a known failure after a restart never emits a duplicate
 * alert.
 */
export interface WorkflowBaseline {
	/** e.g. "RUNNING", "COMPLETED" */
	state: string;
	totalActions: number;
	succeededActions: number;
	failedActions: number;
	runningActions: number;
	/** Node names already reported as failed — prevents duplicate node_failure events. */
	reportedFailedNodes: string[];
	/** JOB nodes present in the workflow run graph. Empty until graph is populated. */
	nodes?: WorkflowNodeInfo[];
}

/** Union type so a single `baseline` field covers both target kinds. */
export type WatchBaseline = JobBaseline | WorkflowBaseline;

// ---------------------------------------------------------------------------
// Watch record
// ---------------------------------------------------------------------------

/**
 * A single active watch. One record per (type, name, runId) tuple.
 * All mutable fields are updated in-place by the poll loop.
 */
export interface GlueWatch {
	watchId: string;
	type: WatchType;
	/** Glue job name or workflow name. */
	name: string;
	/** Glue job run ID (jr_…) or workflow run ID (wr_…). */
	runId: string;
	/** AWS credentials profile passed to `aws glue` CLI. */
	profile: string;
	/** AWS region; `undefined` falls back to the profile default. */
	region: string | undefined;
	addedAt: number;
	lastPolledAt: number | undefined;
	/**
	 * Last observed state. `undefined` when the baseline seeding on `add`
	 * failed — the poll loop will retry on the next tick.
	 */
	baseline: WatchBaseline | undefined;
	/** `true` once the run has reached a terminal state. Polling stops for this watch. */
	terminal: boolean;
	/**
	 * Number of consecutive poll failures for this watch. Reset to 0 on the
	 * first successful poll. Used to threshold warning notifications and to
	 * detect recovery.
	 */
	consecutiveErrors: number;
}

/** Map of watchId → GlueWatch. Serialisable to JSON as-is. */
export type WatchMap = Record<string, GlueWatch>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A single detected change emitted by the poll loop. */
export interface GlueEvent {
	watchId: string;
	type: WatchType;
	name: string;
	runId: string;
	eventType: "state_changed" | "node_failure";
	/** State before this event (empty string when no prior baseline). */
	previousState: string;
	newState: string;
	/** Human-readable one-liner. */
	summary: string;
	/** Bullet-list line for chat messages (includes "• " prefix). */
	formatted: string;
	/** `true` when newState is a terminal state for this watch type. */
	isTerminal: boolean;
	/** Only set for `node_failure` events. */
	nodeName?: string;
}
