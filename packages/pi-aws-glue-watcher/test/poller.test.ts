import { describe, expect, it, vi } from "vitest";

import type { GlueClient, JobRunResponse, WorkflowRunNode, WorkflowRunResponse } from "../src/cli-client.js";
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

	it("returns an updated baseline even when no events were emitted", async () => {
		const watch = makeJobWatch({ state: "RUNNING", errorMessage: "" });
		const { newBaseline } = await detectJobChanges(makeJobClient("RUNNING"), watch);
		expect((newBaseline as JobBaseline).state).toBe("RUNNING");
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
});
