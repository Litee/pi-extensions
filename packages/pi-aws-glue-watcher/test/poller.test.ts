import { describe, expect, it, vi } from "vitest";

import type { GlueClient, JobRunResponse, WorkflowRunNode, WorkflowRunResponse } from "../src/glue-client.js";
import {
	detectJobChanges,
	detectWorkflowChanges,
	snapshotJobRun,
	snapshotWorkflowRun,
} from "../src/poller.js";
import type { GlueWatch, JobBaseline, WorkflowBaseline } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobWatch(baseline?: GlueWatch["baseline"]): GlueWatch {
	return {
		watchId: "aabbccdd",
		type: "job",
		name: "my-etl-job",
		runId: "jr_abc123",
		profile: "my-profile",
		region: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline,
		terminal: false,
		consecutiveErrors: 0,
	};
}

function makeWorkflowWatch(baseline?: GlueWatch["baseline"]): GlueWatch {
	return {
		watchId: "aabbccdd",
		type: "workflow",
		name: "my-workflow",
		runId: "wr_abc123",
		profile: "my-profile",
		region: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline,
		terminal: false,
		consecutiveErrors: 0,
	};
}

function makeJobClient(state: string, errorMessage = ""): GlueClient {
	return {
		getJobRun: vi.fn().mockResolvedValue({
			JobRun: { JobRunState: state, ErrorMessage: errorMessage },
		} satisfies JobRunResponse),
		getWorkflowRun: vi.fn(),
		getLatestJobRunId: vi.fn(),
		getLatestWorkflowRunId: vi.fn(),
		stopJobRun: vi.fn().mockResolvedValue(undefined),
		stopWorkflowRun: vi.fn().mockResolvedValue(undefined),
	};
}

function makeWorkflowClient(
	status: string,
	stats?: WorkflowRunResponse["Run"]["Statistics"],
	nodes?: WorkflowRunNode[],
): GlueClient {
	return {
		getJobRun: vi.fn(),
		getWorkflowRun: vi.fn().mockResolvedValue({
			Run: {
				Status: status,
				Statistics: stats ?? {
					TotalActions: 2,
					SucceededActions: 0,
					FailedActions: 0,
					RunningActions: 2,
				},
				Graph: { Nodes: nodes ?? [] },
			},
		} satisfies WorkflowRunResponse),
		getLatestJobRunId: vi.fn(),
		getLatestWorkflowRunId: vi.fn(),
		stopJobRun: vi.fn().mockResolvedValue(undefined),
		stopWorkflowRun: vi.fn().mockResolvedValue(undefined),
	};
}

// ---------------------------------------------------------------------------
// snapshotJobRun
// ---------------------------------------------------------------------------

describe("snapshotJobRun", () => {
	it("returns the current job state as a baseline snapshot", async () => {
		const client = makeJobClient("RUNNING", "");
		const watch = makeJobWatch();
		const baseline = await snapshotJobRun(client, watch);
		expect(baseline.state).toBe("RUNNING");
		expect(baseline.errorMessage).toBe("");
	});

	it("passes job name, run ID, profile, and region to the client", async () => {
		const client = makeJobClient("STARTING");
		const watch = { ...makeJobWatch(), name: "etl", runId: "jr_001", profile: "prod", region: "eu-west-1" };
		await snapshotJobRun(client, watch);
		expect(client.getJobRun).toHaveBeenCalledWith("etl", "jr_001", "prod", "eu-west-1");
	});
});

// ---------------------------------------------------------------------------
// snapshotWorkflowRun
// ---------------------------------------------------------------------------

describe("snapshotWorkflowRun", () => {
	it("returns the current workflow state as a baseline snapshot", async () => {
		const client = makeWorkflowClient("RUNNING", {
			TotalActions: 4,
			SucceededActions: 2,
			FailedActions: 0,
			RunningActions: 2,
		});
		const watch = makeWorkflowWatch();
		const baseline = await snapshotWorkflowRun(client, watch);
		expect(baseline.state).toBe("RUNNING");
		expect(baseline.totalActions).toBe(4);
		expect(baseline.succeededActions).toBe(2);
	});

	it("seeds reportedFailedNodes with nodes already in a failure state", async () => {
		const nodes: WorkflowRunNode[] = [
			{ Name: "job-a", Type: "JOB", JobDetails: { JobRuns: [{ JobRunState: "FAILED" }] } },
			{ Name: "job-b", Type: "JOB", JobDetails: { JobRuns: [{ JobRunState: "RUNNING" }] } },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		expect(baseline.reportedFailedNodes).toContain("job-a");
		expect(baseline.reportedFailedNodes).not.toContain("job-b");
	});
});

// ---------------------------------------------------------------------------
// detectJobChanges
// ---------------------------------------------------------------------------

describe("detectJobChanges", () => {
	it("emits no events when state is unchanged", async () => {
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const { events } = await detectJobChanges(makeJobClient("RUNNING"), watch);
		expect(events).toHaveLength(0);
	});

	it("emits a state_changed event when state changes", async () => {
		const watch = makeJobWatch({ state: "STARTING", errorMessage: "" });
		const { events, newBaseline } = await detectJobChanges(makeJobClient("RUNNING"), watch);
		expect(events).toHaveLength(1);
		expect(events[0]!.eventType).toBe("state_changed");
		expect(events[0]!.previousState).toBe("STARTING");
		expect(events[0]!.newState).toBe("RUNNING");
		expect(events[0]!.isTerminal).toBe(false);
		expect((newBaseline as JobBaseline).state).toBe("RUNNING");
	});

	it("marks isTerminal=true and appends ✓ for SUCCEEDED", async () => {
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const { events } = await detectJobChanges(makeJobClient("SUCCEEDED"), watch);
		expect(events[0]!.isTerminal).toBe(true);
		expect(events[0]!.formatted).toContain("✓");
	});

	it("marks isTerminal=true and appends ✗ for FAILED", async () => {
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const { events } = await detectJobChanges(makeJobClient("FAILED"), watch);
		expect(events[0]!.isTerminal).toBe(true);
		expect(events[0]!.formatted).toContain("✗");
	});

	it("shows '?' for previous state when no baseline exists", async () => {
		const watch = makeJobWatch(undefined); // no baseline
		const { events } = await detectJobChanges(makeJobClient("RUNNING"), watch);
		expect(events).toHaveLength(1);
		expect(events[0]!.previousState).toBe("");
		expect(events[0]!.formatted).toContain("?");
	});

	it("includes optional job-run fields (StartedOn, NumberOfWorkers, WorkerType) in baseline when present", async () => {
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: {
					JobRunState: "RUNNING",
					ErrorMessage: "",
					StartedOn: "2026-01-01T00:00:00Z",
					NumberOfWorkers: 10,
					WorkerType: "G.1X",
				},
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn().mockResolvedValue(undefined),
			stopWorkflowRun: vi.fn().mockResolvedValue(undefined),
		};
		const watch = makeJobWatch({ state: "STARTING", errorMessage: "" });
		const { newBaseline } = await detectJobChanges(client, watch);
		const b = newBaseline as JobBaseline;
		expect(b.startedOn).toBe("2026-01-01T00:00:00Z");
		expect(b.numberOfWorkers).toBe(10);
		expect(b.workerType).toBe("G.1X");
	});
});

// ---------------------------------------------------------------------------
// detectWorkflowChanges
// ---------------------------------------------------------------------------

describe("detectWorkflowChanges", () => {
	const runningBaseline: WorkflowBaseline = {
		state: "RUNNING",
		totalActions: 4,
		succeededActions: 2,
		failedActions: 0,
		runningActions: 2,
		reportedFailedNodes: [],
	};

	it("emits no events when status and nodes are unchanged", async () => {
		const watch = makeWorkflowWatch(runningBaseline);
		const client = makeWorkflowClient(
			"RUNNING",
			{ TotalActions: 4, SucceededActions: 2, FailedActions: 0, RunningActions: 2 },
		);
		const { events } = await detectWorkflowChanges(client, watch);
		expect(events).toHaveLength(0);
	});

	it("emits state_changed when workflow status changes", async () => {
		const watch = makeWorkflowWatch(runningBaseline);
		const client = makeWorkflowClient(
			"COMPLETED",
			{ TotalActions: 4, SucceededActions: 4, FailedActions: 0, RunningActions: 0 },
		);
		const { events } = await detectWorkflowChanges(client, watch);
		const stateEv = events.find((e) => e.eventType === "state_changed");
		expect(stateEv).toBeDefined();
		expect(stateEv!.newState).toBe("COMPLETED");
		expect(stateEv!.isTerminal).toBe(true);
		expect(stateEv!.formatted).toContain("✓");
	});

	it("emits node_failure for a newly failed job node", async () => {
		const watch = makeWorkflowWatch(runningBaseline);
		const nodes: WorkflowRunNode[] = [
			{ Name: "job-a", Type: "JOB", JobDetails: { JobRuns: [{ JobRunState: "FAILED" }] } },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const { events, newBaseline } = await detectWorkflowChanges(client, watch);
		const failEv = events.find((e) => e.eventType === "node_failure");
		expect(failEv).toBeDefined();
		expect(failEv!.nodeName).toBe("job-a");
		expect(failEv!.formatted).toContain("FAILED ✗");
		expect((newBaseline as WorkflowBaseline).reportedFailedNodes).toContain("job-a");
	});

	it("emits node_failure for a newly failed crawler node", async () => {
		const watch = makeWorkflowWatch(runningBaseline);
		const nodes: WorkflowRunNode[] = [
			{ Name: "crawl-step", Type: "CRAWLER", CrawlerDetails: { Crawls: [{ State: "FAILED" }] } },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const { events } = await detectWorkflowChanges(client, watch);
		const failEv = events.find((e) => e.eventType === "node_failure");
		expect(failEv!.nodeName).toBe("crawl-step");
	});

	it("does not re-emit node_failure for already-reported nodes", async () => {
		const watch = makeWorkflowWatch({
			...runningBaseline,
			reportedFailedNodes: ["job-a"],
		});
		const nodes: WorkflowRunNode[] = [
			{ Name: "job-a", Type: "JOB", JobDetails: { JobRuns: [{ JobRunState: "FAILED" }] } },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const { events } = await detectWorkflowChanges(client, watch);
		expect(events.filter((e) => e.eventType === "node_failure")).toHaveLength(0);
	});

	it("accumulates reportedFailedNodes from baseline and newly detected failures", async () => {
		const watch = makeWorkflowWatch({
			...runningBaseline,
			reportedFailedNodes: ["job-a"],
		});
		const nodes: WorkflowRunNode[] = [
			{ Name: "job-a", Type: "JOB", JobDetails: { JobRuns: [{ JobRunState: "FAILED" }] } },
			{ Name: "job-b", Type: "JOB", JobDetails: { JobRuns: [{ JobRunState: "FAILED" }] } },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const { newBaseline } = await detectWorkflowChanges(client, watch);
		const reported = (newBaseline as WorkflowBaseline).reportedFailedNodes;
		expect(reported).toContain("job-a");
		expect(reported).toContain("job-b");
	});

	it("treats a node with no JobDetails as having empty state (covers optional-chain fallback)", async () => {
		const watch = makeWorkflowWatch(runningBaseline);
		const nodes: WorkflowRunNode[] = [
			// Type JOB but no JobDetails → nodeState returns ""
			{ Name: "ghost-job", Type: "JOB" },
			// Type CRAWLER with empty Crawls → nodeState returns ""
			{ Name: "ghost-crawler", Type: "CRAWLER", CrawlerDetails: { Crawls: [] } },
			// Unknown type → nodeState returns ""
			{ Name: "unknown", Type: "TRIGGER" },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		// None of the nodes are in a failure state, so no node_failure events
		const { events } = await detectWorkflowChanges(client, watch);
		expect(events.filter((e) => e.eventType === "node_failure")).toHaveLength(0);
	});

	it("handles undefined baseline (no previous state) without throwing", async () => {
		// Exercises: previous?.reportedFailedNodes ?? [] and previous?.state ?? ""
		const watch = makeWorkflowWatch(undefined); // no baseline
		const nodes: WorkflowRunNode[] = [
			{ Name: "job-a", Type: "JOB", JobDetails: { JobRuns: [{ JobRunState: "FAILED" }] } },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const { events, newBaseline } = await detectWorkflowChanges(client, watch);
		// previous state was "" so it differs from RUNNING → state_changed event
		const stateEv = events.find((e) => e.eventType === "state_changed");
		expect(stateEv).toBeDefined();
		// Node failure should still be reported
		const failEv = events.find((e) => e.eventType === "node_failure");
		expect(failEv).toBeDefined();
		expect((newBaseline as WorkflowBaseline).reportedFailedNodes).toContain("job-a");
	});

	it("handles undefined Statistics in workflow run response", async () => {
		// Exercises the resp.Run.Statistics ?? {} fallback
		const watch = makeWorkflowWatch(runningBaseline);
		const client: GlueClient = {
			...makeWorkflowClient("COMPLETED"),
			getWorkflowRun: vi.fn().mockResolvedValue({
				Run: { Status: "COMPLETED" }, // no Statistics, no Graph
			}),
		};
		const { newBaseline } = await detectWorkflowChanges(client, watch);
		expect((newBaseline as WorkflowBaseline).totalActions).toBe(0);
	});

	it("includes optional node-level fields (StartedOn, NumberOfWorkers, WorkerType) in node info when present", async () => {
		// Exercises the truthy branches of the optional spreads in detectWorkflowChanges
		const watch = makeWorkflowWatch(runningBaseline);
		const nodes: WorkflowRunNode[] = [
			{
				Name: "job-a",
				Type: "JOB",
				JobDetails: {
					JobRuns: [{
						JobRunState: "RUNNING",
						StartedOn: "2026-01-01T00:00:00Z",
						NumberOfWorkers: 5,
						WorkerType: "G.2X",
					}],
				},
			},
		];
		const client = makeWorkflowClient("RUNNING", { TotalActions: 1 }, nodes);
		const { newBaseline } = await detectWorkflowChanges(client, watch);
		const nodeInfos = (newBaseline as WorkflowBaseline).nodes ?? [];
		const node = nodeInfos.find((n) => n.name === "job-a");
		expect(node?.startedOn).toBe("2026-01-01T00:00:00Z");
		expect(node?.numberOfWorkers).toBe(5);
		expect(node?.workerType).toBe("G.2X");
	});
});

// ---------------------------------------------------------------------------
// timeoutMinutes capture (#0014)
// ---------------------------------------------------------------------------

describe("snapshotJobRun — timeoutMinutes", () => {
	it("populates timeoutMinutes when SDK returns Timeout > 0", async () => {
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: { JobRunState: "RUNNING", ErrorMessage: "", Timeout: 30 },
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(), getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(), stopJobRun: vi.fn(), stopWorkflowRun: vi.fn(),
		};
		const baseline = await snapshotJobRun(client, makeJobWatch());
		expect(baseline.timeoutMinutes).toBe(30);
	});

	it("omits timeoutMinutes when Timeout is 0 (inherit job default)", async () => {
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: { JobRunState: "RUNNING", ErrorMessage: "", Timeout: 0 },
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(), getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(), stopJobRun: vi.fn(), stopWorkflowRun: vi.fn(),
		};
		const baseline = await snapshotJobRun(client, makeJobWatch());
		expect(baseline.timeoutMinutes).toBeUndefined();
	});

	it("omits timeoutMinutes when Timeout is absent", async () => {
		const baseline = await snapshotJobRun(makeJobClient("RUNNING"), makeJobWatch());
		expect(baseline.timeoutMinutes).toBeUndefined();
	});
});

describe("detectJobChanges — TIMEOUT event includes timeout suffix", () => {
	it("appends (timeout: Xm) when state transitions to TIMEOUT and timeoutMinutes is known", async () => {
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: { JobRunState: "TIMEOUT", ErrorMessage: "", Timeout: 30 },
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(), getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(), stopJobRun: vi.fn(), stopWorkflowRun: vi.fn(),
		};
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const { events } = await detectJobChanges(client, watch);
		expect(events).toHaveLength(1);
		expect(events[0]!.formatted).toContain("(timeout: 30m)");
		expect(events[0]!.summary).toContain("(timeout: 30m)");
	});

	it("does NOT append timeout suffix for non-TIMEOUT terminal states", async () => {
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: { JobRunState: "FAILED", ErrorMessage: "oom", Timeout: 30 },
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(), getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(), stopJobRun: vi.fn(), stopWorkflowRun: vi.fn(),
		};
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const { events } = await detectJobChanges(client, watch);
		expect(events[0]!.formatted).not.toContain("timeout:");
	});

	it("does NOT append timeout suffix when Timeout is absent", async () => {
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const { events } = await detectJobChanges(makeJobClient("TIMEOUT"), watch);
		expect(events[0]!.formatted).not.toContain("timeout:");
	});
});

// ---------------------------------------------------------------------------
// Additional snapshot coverage: optional fields
// ---------------------------------------------------------------------------

describe("snapshotJobRun — optional fields", () => {
	it("includes CompletedOn when present in the response", async () => {
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: {
					JobRunState: "SUCCEEDED",
					ErrorMessage: "",
					CompletedOn: "2024-01-01T01:00:00Z",
				},
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(), getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(), stopJobRun: vi.fn(), stopWorkflowRun: vi.fn(),
		};
		const baseline = await snapshotJobRun(client, makeJobWatch());
		expect(baseline.completedOn).toBe("2024-01-01T01:00:00Z");
	});

	it("omits CompletedOn when absent from response", async () => {
		const client = makeJobClient("RUNNING");
		const baseline = await snapshotJobRun(client, makeJobWatch());
		expect(baseline.completedOn).toBeUndefined();
	});
});

describe("snapshotWorkflowRun — node optional fields", () => {
	it("includes CompletedOn, NumberOfWorkers, WorkerType, and timeout for workflow nodes", async () => {
		const nodes: WorkflowRunNode[] = [
			{
				Name: "step-1",
				Type: "JOB",
				JobDetails: {
					JobRuns: [{
						JobRunState: "SUCCEEDED",
						CompletedOn: "2024-01-01T01:00:00Z",
						NumberOfWorkers: 5,
						WorkerType: "G.2X",
						Timeout: 30,
					}],
				},
			},
		];
		const client = makeWorkflowClient("COMPLETED", {}, nodes);
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		const node = baseline.nodes![0]!;
		expect(node.completedOn).toBe("2024-01-01T01:00:00Z");
		expect(node.numberOfWorkers).toBe(5);
		expect(node.workerType).toBe("G.2X");
		expect(node.timeoutMinutes).toBe(30);
	});

	it("excludes CompletedOn/NumberOfWorkers/WorkerType when absent", async () => {
		const nodes: WorkflowRunNode[] = [
			{
				Name: "step-1",
				Type: "JOB",
				JobDetails: { JobRuns: [{ JobRunState: "RUNNING" }] },
			},
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		const node = baseline.nodes![0]!;
		expect(node.completedOn).toBeUndefined();
		expect(node.numberOfWorkers).toBeUndefined();
		expect(node.workerType).toBeUndefined();
	});

	it("excludes timeoutMinutes when Timeout is 0", async () => {
		const nodes: WorkflowRunNode[] = [
			{
				Name: "step-1",
				Type: "JOB",
				JobDetails: { JobRuns: [{ JobRunState: "RUNNING", Timeout: 0 }] },
			},
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		expect(baseline.nodes![0]?.timeoutMinutes).toBeUndefined();
	});

	it("returns unknown-type node state as empty string via nodeState fallback", async () => {
		const nodes: WorkflowRunNode[] = [
			{ Name: "trigger-node", Type: "TRIGGER", JobDetails: undefined, CrawlerDetails: undefined },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		// TRIGGER type is not JOB/CRAWLER, nodeState returns "" → not in reportedFailedNodes
		expect(baseline.reportedFailedNodes).not.toContain("trigger-node");
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: snapshotWorkflowRun — partial stats (missing fields → ?? 0)
// ---------------------------------------------------------------------------

describe("snapshotWorkflowRun — partial statistics (missing stat fields hit ?? 0)", () => {
	it("defaults failedActions and runningActions to 0 when absent from statistics", async () => {
		// Exercises the `?? 0` fallback branches for FailedActions / RunningActions
		// in snapshotWorkflowRun (poller.ts line ~115).
		const client: GlueClient = {
			getJobRun: vi.fn(),
			getWorkflowRun: vi.fn().mockResolvedValue({
				Run: {
					Status: "RUNNING",
					Statistics: {
						TotalActions: 3,
						SucceededActions: 1,
						// FailedActions and RunningActions intentionally absent
					},
					Graph: { Nodes: [] },
				},
			} satisfies WorkflowRunResponse),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn(),
			stopWorkflowRun: vi.fn(),
		};
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		expect(baseline.totalActions).toBe(3);
		expect(baseline.succeededActions).toBe(1);
		expect(baseline.failedActions).toBe(0);   // ?? 0 branch
		expect(baseline.runningActions).toBe(0);  // ?? 0 branch
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: detectWorkflowChanges — node optional fields (completedOn, timeoutMinutes)
// ---------------------------------------------------------------------------

describe("detectWorkflowChanges — node completedOn and timeoutMinutes in new baseline", () => {
	const runningBaseline: WorkflowBaseline = {
		state: "RUNNING",
		totalActions: 1,
		succeededActions: 0,
		failedActions: 0,
		runningActions: 1,
		reportedFailedNodes: [],
	};

	it("includes completedOn in node info when the job run has CompletedOn set", async () => {
		// Exercises the truthy branch of `run?.CompletedOn !== undefined` (poller.ts ~line 273).
		const nodes: WorkflowRunNode[] = [
			{
				Name: "step-done",
				Type: "JOB",
				JobDetails: {
					JobRuns: [{
						JobRunState: "SUCCEEDED",
						StartedOn: "2024-01-01T00:00:00Z",
						CompletedOn: "2024-01-01T00:05:00Z",
					}],
				},
			},
		];
		const client = makeWorkflowClient("RUNNING", { TotalActions: 1 }, nodes);
		const watch = makeWorkflowWatch(runningBaseline);
		const { newBaseline } = await detectWorkflowChanges(client, watch);
		const nodeInfo = (newBaseline as WorkflowBaseline).nodes?.find((n) => n.name === "step-done");
		expect(nodeInfo?.completedOn).toBe("2024-01-01T00:05:00Z");
	});

	it("includes timeoutMinutes in node info when Timeout > 0", async () => {
		// Exercises the truthy branch of `run?.Timeout != null && run.Timeout > 0`
		// (poller.ts ~line 268) and the resulting `timeoutMinutes !== undefined` spread
		// (poller.ts ~line 276).
		const nodes: WorkflowRunNode[] = [
			{
				Name: "step-timeout",
				Type: "JOB",
				JobDetails: {
					JobRuns: [{
						JobRunState: "RUNNING",
						Timeout: 45,
					}],
				},
			},
		];
		const client = makeWorkflowClient("RUNNING", { TotalActions: 1 }, nodes);
		const watch = makeWorkflowWatch(runningBaseline);
		const { newBaseline } = await detectWorkflowChanges(client, watch);
		const nodeInfo = (newBaseline as WorkflowBaseline).nodes?.find((n) => n.name === "step-timeout");
		expect(nodeInfo?.timeoutMinutes).toBe(45);
	});

	it("omits timeoutMinutes from node info when Timeout is 0 (inherit job default)", async () => {
		// Exercises the false branch of `run.Timeout > 0` (returns undefined → no spread).
		const nodes: WorkflowRunNode[] = [
			{
				Name: "step-no-timeout",
				Type: "JOB",
				JobDetails: {
					JobRuns: [{
						JobRunState: "RUNNING",
						Timeout: 0,
					}],
				},
			},
		];
		const client = makeWorkflowClient("RUNNING", { TotalActions: 1 }, nodes);
		const watch = makeWorkflowWatch(runningBaseline);
		const { newBaseline } = await detectWorkflowChanges(client, watch);
		const nodeInfo = (newBaseline as WorkflowBaseline).nodes?.find((n) => n.name === "step-no-timeout");
		expect(nodeInfo?.timeoutMinutes).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: ?? "" fallback paths for undefined Status / JobRunState
// ---------------------------------------------------------------------------

describe("snapshotWorkflowRun — undefined Status ?? '' fallback (line 112)", () => {
	it("defaults state to empty string when Run.Status is undefined", async () => {
		// Exercises `resp.Run.Status ?? ""` when the API returns no Status field.
		const client: GlueClient = {
			getJobRun: vi.fn(),
			getWorkflowRun: vi.fn().mockResolvedValue({
				Run: {
					// Status intentionally absent → undefined → ?? "" returns ""
					Status: undefined as unknown as string,
					Statistics: {},
					Graph: { Nodes: [] },
				},
			} satisfies WorkflowRunResponse),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn(),
			stopWorkflowRun: vi.fn(),
		};
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		expect(baseline.state).toBe("");
	});
});

describe("detectJobChanges — undefined JobRunState ?? '' fallback (lines 152-153)", () => {
	it("defaults state and errorMessage to empty string when fields are absent from JobRun", async () => {
		// Exercises `resp.JobRun.JobRunState ?? ""` and `resp.JobRun.ErrorMessage ?? ""`
		// when the API returns a JobRun with undefined state/error fields.
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: {
					// JobRunState and ErrorMessage intentionally absent
					JobRunState: undefined as unknown as string,
					ErrorMessage: undefined,
				},
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn(),
			stopWorkflowRun: vi.fn(),
		};
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const { newBaseline } = await detectJobChanges(client, watch);
		const b = newBaseline as JobBaseline;
		expect(b.state).toBe("");
		expect(b.errorMessage).toBe("");
	});
});

describe("detectWorkflowChanges — undefined Run.Status ?? '' fallback (line 215)", () => {
	it("defaults nextState to empty string when Run.Status is absent", async () => {
		// Exercises `resp.Run.Status ?? ""` in detectWorkflowChanges.
		const client: GlueClient = {
			getJobRun: vi.fn(),
			getWorkflowRun: vi.fn().mockResolvedValue({
				Run: {
					Status: undefined as unknown as string,
					Statistics: {},
					Graph: { Nodes: [] },
				},
			} satisfies WorkflowRunResponse),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn(),
			stopWorkflowRun: vi.fn(),
		};
		const runningBaseline: WorkflowBaseline = {
			state: "RUNNING",
			totalActions: 0,
			succeededActions: 0,
			failedActions: 0,
			runningActions: 0,
			reportedFailedNodes: [],
		};
		// prev state = "RUNNING", next state = "" → state_changed event
		const { newBaseline } = await detectWorkflowChanges(client, makeWorkflowWatch(runningBaseline));
		const wfBase = newBaseline as WorkflowBaseline;
		expect(wfBase.state).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: snapshotJobRun — all optional fields truthy branches (lines 154-157)
// ---------------------------------------------------------------------------

describe("snapshotJobRun — all optional fields truthy branches", () => {
	it("includes StartedOn, NumberOfWorkers, WorkerType, and CompletedOn when all present", async () => {
		// Exercises the truthy branches of all optional spreads in detectJobChanges
		// (poller.ts lines 154, 155, 156, 157).
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: {
					JobRunState: "RUNNING",
					ErrorMessage: "",
					StartedOn: "2024-01-01T00:00:00Z",
					CompletedOn: "2024-01-01T01:00:00Z",
					NumberOfWorkers: 8,
					WorkerType: "G.2X",
				},
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn(),
			stopWorkflowRun: vi.fn(),
		};
		const watch = makeJobWatch({ state: "STARTING", errorMessage: "" });
		const { newBaseline } = await detectJobChanges(client, watch);
		const b = newBaseline as JobBaseline;
		expect(b.startedOn).toBe("2024-01-01T00:00:00Z");
		expect(b.completedOn).toBe("2024-01-01T01:00:00Z");
		expect(b.numberOfWorkers).toBe(8);
		expect(b.workerType).toBe("G.2X");
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: snapshotWorkflowRun — undefined Statistics and Graph (lines 112-113)
// ---------------------------------------------------------------------------

describe("snapshotWorkflowRun — undefined Statistics and Graph (lines 112-113)", () => {
	it("defaults Statistics to {} and Graph to [] when both are absent", async () => {
		// Exercises `resp.Run.Statistics ?? {}` (line 112) and
		// `resp.Run.Graph?.Nodes ?? []` (line 113) in snapshotWorkflowRun.
		const client: GlueClient = {
			getJobRun: vi.fn(),
			getWorkflowRun: vi.fn().mockResolvedValue({
				Run: {
					Status: "RUNNING",
					// Statistics and Graph intentionally absent
					Statistics: undefined,
					Graph: undefined,
				},
			} satisfies WorkflowRunResponse),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn(),
			stopWorkflowRun: vi.fn(),
		};
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		expect(baseline.totalActions).toBe(0);
		expect(baseline.succeededActions).toBe(0);
		expect(baseline.failedActions).toBe(0);
		expect(baseline.runningActions).toBe(0);
		expect(baseline.reportedFailedNodes).toEqual([]);
		expect(baseline.nodes).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: snapshotWorkflowRun — node optional fields (lines 125-126)
// ---------------------------------------------------------------------------

describe("snapshotWorkflowRun — node optional fields (lines 125-126)", () => {
	it("includes JobRunState and StartedOn in node info when JobDetails.JobRuns[0] has them", async () => {
		// Exercises `run?.JobRunState ?? ""` (line 125) and
		// `run?.StartedOn !== undefined ? { startedOn: ... } : {}` (line 126)
		// in snapshotWorkflowRun.
		const nodes: WorkflowRunNode[] = [
			{
				Name: "step-1",
				Type: "JOB",
				JobDetails: {
					JobRuns: [{
						JobRunState: "RUNNING",
						StartedOn: "2024-06-01T12:00:00Z",
					}],
				},
			},
		];
		const client = makeWorkflowClient("RUNNING", { TotalActions: 1 }, nodes);
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		const node = baseline.nodes?.[0];
		expect(node?.state).toBe("RUNNING");
		expect(node?.startedOn).toBe("2024-06-01T12:00:00Z");
	});

	it("returns empty string for JobRunState when JobDetails.JobRuns[0] is absent", async () => {
		// Exercises `run?.JobRunState ?? ""` (line 125) when run is undefined.
		const nodes: WorkflowRunNode[] = [
			{ Name: "no-run", Type: "JOB", JobDetails: undefined },
		];
		const client = makeWorkflowClient("RUNNING", {}, nodes);
		const baseline = await snapshotWorkflowRun(client, makeWorkflowWatch());
		expect(baseline.nodes?.[0]?.state).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Branch coverage: snapshotJobRun — optional spread truthy branches (lines 154-157)
// ---------------------------------------------------------------------------

describe("snapshotJobRun — optional spread truthy branches (lines 154-157)", () => {
	it("includes StartedOn, CompletedOn, NumberOfWorkers, WorkerType when all present", async () => {
		// Exercises the truthy branches of all optional spreads in snapshotJobRun
		// (poller.ts lines 154-157).
		const client: GlueClient = {
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: {
					JobRunState: "RUNNING",
					ErrorMessage: "",
					StartedOn: "2024-01-01T00:00:00Z",
					CompletedOn: "2024-01-01T01:00:00Z",
					NumberOfWorkers: 8,
					WorkerType: "G.2X",
				},
			} satisfies JobRunResponse),
			getWorkflowRun: vi.fn(),
			getLatestJobRunId: vi.fn(),
			getLatestWorkflowRunId: vi.fn(),
			stopJobRun: vi.fn(),
			stopWorkflowRun: vi.fn(),
		};
		const baseline = await snapshotJobRun(client, makeJobWatch());
		expect(baseline.startedOn).toBe("2024-01-01T00:00:00Z");
		expect(baseline.completedOn).toBe("2024-01-01T01:00:00Z");
		expect(baseline.numberOfWorkers).toBe(8);
		expect(baseline.workerType).toBe("G.2X");
	});
});
