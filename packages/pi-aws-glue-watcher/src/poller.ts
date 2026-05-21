/**
 * AWS Glue change detection.
 *
 * Pure(-ish) module: no environment access, no persistence, no setInterval.
 * All I/O goes through the injected {@link GlueClient} so tests can drop in
 * a stub implementation with canned responses.
 *
 * Public surface:
 *   - {@link snapshotJobRun}        — fetch job-run state, no diff.
 *   - {@link snapshotWorkflowRun}   — fetch workflow-run state, no diff.
 *   - {@link detectJobChanges}      — diff job state against a baseline.
 *   - {@link detectWorkflowChanges} — diff workflow state against a baseline
 *                                     and detect per-node failures.
 */

import type { GlueClient, WorkflowRunNode } from "./glue-client.js";
import {
	JOB_TERMINAL_STATES,
	NODE_FAILURE_STATES,
	WORKFLOW_TERMINAL_STATES,
	type GlueEvent,
	type GlueWatch,
	type JobBaseline,
	type WatchBaseline,
	type WorkflowBaseline,
	type WorkflowNodeInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract the current run-state from a workflow graph node. */
function nodeState(node: WorkflowRunNode): string {
	if (node.Type === "JOB") {
		return node.JobDetails?.JobRuns?.[0]?.JobRunState ?? "";
	}
	if (node.Type === "CRAWLER") {
		return node.CrawlerDetails?.Crawls?.[0]?.State ?? "";
	}
	return "";
}

/** Return the `✓` / `✗` suffix appended to terminal-state transitions. */
function terminalSuffix(state: string, isTerminal: boolean): string {
	if (!isTerminal) return "";
	return state === "SUCCEEDED" || state === "COMPLETED" ? " ✓" : " ✗";
}

// ---------------------------------------------------------------------------
// Snapshot functions (seed-time only — no diffing)
// ---------------------------------------------------------------------------

/**
 * Fetch the current state of a Glue job run and return a baseline snapshot.
 * No diffing — used when seeding a watch or when adding a new job via the
 * `glue_watcher add` tool.
 */
export async function snapshotJobRun(
	client: GlueClient,
	watch: GlueWatch,
): Promise<JobBaseline> {
	const resp = await client.getJobRun(watch.name, watch.runId, watch.profile, watch.region);
	const timeoutMinutes = resp.JobRun.Timeout != null && resp.JobRun.Timeout > 0
		? resp.JobRun.Timeout
		: undefined;
	return {
		state: resp.JobRun.JobRunState ?? "",
		errorMessage: resp.JobRun.ErrorMessage ?? "",
		...(resp.JobRun.StartedOn !== undefined ? { startedOn: resp.JobRun.StartedOn } : {}),
		...(resp.JobRun.CompletedOn !== undefined ? { completedOn: resp.JobRun.CompletedOn } : {}),
		...(resp.JobRun.NumberOfWorkers !== undefined ? { numberOfWorkers: resp.JobRun.NumberOfWorkers } : {}),
		...(resp.JobRun.WorkerType !== undefined ? { workerType: resp.JobRun.WorkerType } : {}),
		...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
	};
}

/**
 * Fetch the current state of a Glue workflow run and return a baseline
 * snapshot, including the names of any nodes already in a failure state so
 * they are not re-reported on the next poll.
 */
export async function snapshotWorkflowRun(
	client: GlueClient,
	watch: GlueWatch,
): Promise<WorkflowBaseline> {
	const resp = await client.getWorkflowRun(
		watch.name, watch.runId, watch.profile, watch.region,
	);
	const stats = resp.Run.Statistics ?? {};
	const nodes = resp.Run.Graph?.Nodes ?? [];
	const alreadyFailed = nodes
		.filter((n) => NODE_FAILURE_STATES.has(nodeState(n)))
		.map((n) => n.Name);
	const nodeInfos: WorkflowNodeInfo[] = nodes
		.filter((n) => n.Type === "JOB")
		.map((n) => {
			const run = n.JobDetails?.JobRuns?.[0];
			const timeoutMinutes = run?.Timeout != null && run.Timeout > 0 ? run.Timeout : undefined;
			const info: WorkflowNodeInfo = {
				name: n.Name,
				state: run?.JobRunState ?? "",
				...(run?.StartedOn !== undefined ? { startedOn: run.StartedOn } : {}),
				...(run?.CompletedOn !== undefined ? { completedOn: run.CompletedOn } : {}),
				...(run?.NumberOfWorkers !== undefined ? { numberOfWorkers: run.NumberOfWorkers } : {}),
				...(run?.WorkerType !== undefined ? { workerType: run.WorkerType } : {}),
				...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
			};
			return info;
		});
	return {
		state: resp.Run.Status ?? "",
		totalActions: stats.TotalActions ?? 0,
		succeededActions: stats.SucceededActions ?? 0,
		failedActions: stats.FailedActions ?? 0,
		runningActions: stats.RunningActions ?? 0,
		reportedFailedNodes: alreadyFailed,
		nodes: nodeInfos,
	};
}

// ---------------------------------------------------------------------------
// Change-detection result
// ---------------------------------------------------------------------------

export interface DetectChangesResult {
	events: GlueEvent[];
	/** Updated baseline to persist back into the watch record. */
	newBaseline: WatchBaseline;
}

// ---------------------------------------------------------------------------
// Job change detection
// ---------------------------------------------------------------------------

/**
 * Poll a Glue job run, diff against the watch's current baseline, and
 * return any state-change events plus the refreshed baseline.
 *
 * Emits at most one `state_changed` event per call (Glue runs advance
 * through at most one visible state per poll window).
 */
export async function detectJobChanges(
	client: GlueClient,
	watch: GlueWatch,
): Promise<DetectChangesResult> {
	const resp = await client.getJobRun(watch.name, watch.runId, watch.profile, watch.region);
	const timeoutMinutes = resp.JobRun.Timeout != null && resp.JobRun.Timeout > 0
		? resp.JobRun.Timeout
		: undefined;
	const newBaseline: JobBaseline = {
		state: resp.JobRun.JobRunState ?? "",
		errorMessage: resp.JobRun.ErrorMessage ?? "",
		...(resp.JobRun.StartedOn !== undefined ? { startedOn: resp.JobRun.StartedOn } : {}),
		...(resp.JobRun.CompletedOn !== undefined ? { completedOn: resp.JobRun.CompletedOn } : {}),
		...(resp.JobRun.NumberOfWorkers !== undefined ? { numberOfWorkers: resp.JobRun.NumberOfWorkers } : {}),
		...(resp.JobRun.WorkerType !== undefined ? { workerType: resp.JobRun.WorkerType } : {}),
		...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
	};

	const previous = watch.baseline as JobBaseline | undefined;
	const prevState = previous?.state ?? "";
	const nextState = newBaseline.state;
	const events: GlueEvent[] = [];

	if (prevState !== nextState) {
		const isTerminal = JOB_TERMINAL_STATES.has(nextState);
		const suffix = terminalSuffix(nextState, isTerminal);
		const timeoutSuffix = nextState === "TIMEOUT" && newBaseline.timeoutMinutes != null
			? ` (timeout: ${newBaseline.timeoutMinutes}m)`
			: "";
		events.push({
			watchId: watch.watchId,
			type: "job",
			name: watch.name,
			runId: watch.runId,
			eventType: "state_changed",
			previousState: prevState,
			newState: nextState,
			summary: `${watch.name} (${watch.runId}): ${prevState || "?"} \u2192 ${nextState}${suffix}${timeoutSuffix}`,
			formatted: `\u2022 ${watch.name} (${watch.runId}): ${prevState || "?"} \u2192 ${nextState}${suffix}${timeoutSuffix}`,
			isTerminal,
		});
	}

	return { events, newBaseline };
}

// ---------------------------------------------------------------------------
// Workflow change detection
// ---------------------------------------------------------------------------

/**
 * Poll a Glue workflow run, diff against the watch's current baseline, and
 * return any events (workflow state change and/or per-node failures) plus
 * the refreshed baseline.
 *
 * Node failures that were already in `baseline.reportedFailedNodes` are
 * silently skipped to prevent duplicate alerts across restarts.
 */
export async function detectWorkflowChanges(
	client: GlueClient,
	watch: GlueWatch,
): Promise<DetectChangesResult> {
	const resp = await client.getWorkflowRun(
		watch.name, watch.runId, watch.profile, watch.region,
	);
	const stats = resp.Run.Statistics ?? {};
	const nodes: WorkflowRunNode[] = resp.Run.Graph?.Nodes ?? [];
	const previous = watch.baseline as WorkflowBaseline | undefined;
	const alreadyReported = new Set(previous?.reportedFailedNodes ?? []);

	const events: GlueEvent[] = [];
	const prevState = previous?.state ?? "";
	const nextState = resp.Run.Status ?? "";

	// Workflow-level state change
	if (prevState !== nextState) {
		const isTerminal = WORKFLOW_TERMINAL_STATES.has(nextState);
		const suffix = terminalSuffix(nextState, isTerminal);
		events.push({
			watchId: watch.watchId,
			type: "workflow",
			name: watch.name,
			runId: watch.runId,
			eventType: "state_changed",
			previousState: prevState,
			newState: nextState,
			summary: `${watch.name} (${watch.runId}): ${prevState || "?"} → ${nextState}${suffix}`,
			formatted: `• ${watch.name} (${watch.runId}): ${prevState || "?"} → ${nextState}${suffix}`,
			isTerminal,
		});
	}

	// Per-node failure detection (newly failed nodes only)
	const newlyFailed: string[] = [];
	for (const node of nodes) {
		const st = nodeState(node);
		if (NODE_FAILURE_STATES.has(st) && !alreadyReported.has(node.Name)) {
			newlyFailed.push(node.Name);
			events.push({
				watchId: watch.watchId,
				type: "workflow",
				name: watch.name,
				runId: watch.runId,
				eventType: "node_failure",
				previousState: "",
				newState: st,
				summary: `${watch.name} (${watch.runId}): node '${node.Name}' → ${st} ✗`,
				formatted: `• ${watch.name} (${watch.runId}): node '${node.Name}' → ${st} ✗`,
				isTerminal: false,
				nodeName: node.Name,
			});
		}
	}

	const newBaseline: WorkflowBaseline = {
		state: nextState,
		totalActions: stats.TotalActions ?? 0,
		succeededActions: stats.SucceededActions ?? 0,
		failedActions: stats.FailedActions ?? 0,
		runningActions: stats.RunningActions ?? 0,
		reportedFailedNodes: [...(previous?.reportedFailedNodes ?? []), ...newlyFailed],
		nodes: nodes
			.filter((n) => n.Type === "JOB")
			.map((n) => {
				const run = n.JobDetails?.JobRuns?.[0];
				const timeoutMinutes = run?.Timeout != null && run.Timeout > 0 ? run.Timeout : undefined;
				const info: WorkflowNodeInfo = {
					name: n.Name,
					state: run?.JobRunState ?? "",
					...(run?.StartedOn !== undefined ? { startedOn: run.StartedOn } : {}),
					...(run?.CompletedOn !== undefined ? { completedOn: run.CompletedOn } : {}),
					...(run?.NumberOfWorkers !== undefined ? { numberOfWorkers: run.NumberOfWorkers } : {}),
					...(run?.WorkerType !== undefined ? { workerType: run.WorkerType } : {}),
					...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
				};
				return info;
			}),
	};

	return { events, newBaseline };
}
