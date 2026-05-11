import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { GlueClient, JobRunResponse, WorkflowRunResponse } from "../src/glue-client.js";
import { makeRuntime, POLL_ERROR_THRESHOLD, POLL_INTERVAL_MS, pollOnce } from "../src/runtime.js";
import {
	handleToolAction,
	registerToolIfNeeded,
	resetToolRegisteredForTests,
} from "../src/toolAction.js";
import type { GlueWatch } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		registerTool: vi.fn(),
		getActiveTools: vi.fn().mockReturnValue([]),
		setActiveTools: vi.fn(),
		events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
	};
}

function makeClient(): GlueClient {
	return {
		getJobRun: vi.fn().mockResolvedValue({
			JobRun: { JobRunState: "RUNNING", ErrorMessage: "" },
		} satisfies JobRunResponse),
		getWorkflowRun: vi.fn().mockResolvedValue({
			Run: {
				Status: "RUNNING",
				Statistics: { TotalActions: 2, SucceededActions: 0, FailedActions: 0, RunningActions: 2 },
				Graph: { Nodes: [] },
			},
		} satisfies WorkflowRunResponse),
		getLatestJobRunId: vi.fn().mockResolvedValue("jr_latest123"),
		getLatestWorkflowRunId: vi.fn().mockResolvedValue("wr_latest456"),
		stopJobRun: vi.fn().mockResolvedValue(undefined),
		stopWorkflowRun: vi.fn().mockResolvedValue(undefined),
	};
}

function makeWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
	return {
		watchId: "aabbccdd",
		type: "job",
		name: "my-etl-job",
		runId: "jr_abc123",
		profile: "my-profile",
		region: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: { state: "RUNNING", errorMessage: "" },
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
	resetToolRegisteredForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// registerToolIfNeeded
// ---------------------------------------------------------------------------

describe("registerToolIfNeeded", () => {
	it("calls pi.registerTool exactly once even when invoked multiple times", () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		const piApi = pi as unknown as ExtensionAPI;

		registerToolIfNeeded(piApi, rt);
		registerToolIfNeeded(piApi, rt);
		registerToolIfNeeded(piApi, rt);

		expect(pi.registerTool).toHaveBeenCalledOnce();
	});

	it("registers a tool with the name glue_watcher", () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		registerToolIfNeeded(pi as unknown as ExtensionAPI, rt);

		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "glue_watcher" }),
		);
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — add
// ---------------------------------------------------------------------------

describe("handleToolAction — add", () => {
	it("adds a job watch and seeds baseline when runId is provided", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		const result = await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "my-etl-job",
			runId: "jr_abc123",
			profile: "my-profile",
		});

		expect(result.details.ok).toBe(true);
		expect(Object.keys(rt.watches)).toHaveLength(1);
		const watch = Object.values(rt.watches)[0]!;
		expect(watch.type).toBe("job");
		expect(watch.name).toBe("my-etl-job");
		expect(watch.runId).toBe("jr_abc123");
		expect(watch.baseline).toBeDefined();
	});

	it("adds a workflow watch and seeds baseline", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		const result = await handleToolAction(rt, {
			action: "add",
			type: "workflow",
			name: "my-workflow",
			runId: "wr_def456",
			profile: "my-profile",
		});

		expect(result.details.ok).toBe(true);
		const watch = Object.values(rt.watches)[0]!;
		expect(watch.type).toBe("workflow");
	});

	it("fetches the latest run ID when runId is omitted for a job", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "my-etl-job",
			profile: "my-profile",
		});

		expect(client.getLatestJobRunId).toHaveBeenCalledWith("my-etl-job", "my-profile", undefined);
		const watch = Object.values(rt.watches)[0]!;
		expect(watch.runId).toBe("jr_latest123");
	});

	it("fetches the latest workflow run ID when runId is omitted", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);

		await handleToolAction(rt, {
			action: "add",
			type: "workflow",
			name: "my-workflow",
			profile: "my-profile",
		});

		expect(client.getLatestWorkflowRunId).toHaveBeenCalledWith("my-workflow", "my-profile", undefined);
	});

	it("returns an error when type is missing", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "add", name: "job", profile: "p" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("type");
	});

	it("returns an error when name is missing", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "add", type: "job", profile: "p" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("name");
	});

	it("returns an error when profile is missing", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "add", type: "job", name: "my-job" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("profile");
	});

	it("returns an error when fetching the latest run ID fails", async () => {
		const pi = makePi();
		const client = makeClient();
		(client.getLatestJobRunId as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("no runs found"),
		);
		const rt = makeRuntime(pi, client);
		const result = await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "my-job",
			profile: "p",
		});
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("no runs found");
	});

	it("still adds the watch when baseline seeding fails", async () => {
		const pi = makePi();
		const client = makeClient();
		(client.getJobRun as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("permission denied"),
		);
		const rt = makeRuntime(pi, client);
		const result = await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "my-job",
			runId: "jr_123",
			profile: "p",
		});
		expect(result.details.ok).toBe(true);
		expect(Object.keys(rt.watches)).toHaveLength(1);
		expect(Object.values(rt.watches)[0]!.baseline).toBeUndefined();
	});

	it("persists state after adding a watch", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		await handleToolAction(rt, {
			action: "add",
			type: "job",
			name: "j",
			runId: "jr_1",
			profile: "p",
		});
		expect(pi.appendEntry).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — remove
// ---------------------------------------------------------------------------

describe("handleToolAction — remove", () => {
	it("removes an existing watch by watchId", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.watches["aabb"] = makeWatch({ watchId: "aabb" });

		const result = await handleToolAction(rt, { action: "remove", watchId: "aabb" });

		expect(result.details.ok).toBe(true);
		expect(rt.watches["aabb"]).toBeUndefined();
	});

	it("returns an error for an unknown watchId", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "remove", watchId: "nonexistent" });
		expect(result.details.ok).toBe(false);
	});

	it("returns an error when watchId is omitted", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "remove" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("watchId");
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — list
// ---------------------------------------------------------------------------

describe("handleToolAction — list", () => {
	it("returns an appropriate message when no watches exist", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "list" });
		expect(result.details.ok).toBe(true);
		expect(result.details.message).toContain("no watches");
		expect(result.details.watches).toEqual([]);
	});

	it("lists all watches with their name and state", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.watches["aabb"] = makeWatch({
			watchId: "aabb",
			name: "my-etl-job",
			baseline: { state: "RUNNING", errorMessage: "" },
		});

		const result = await handleToolAction(rt, { action: "list" });

		expect(result.details.message).toContain("my-etl-job");
		expect(result.details.message).toContain("RUNNING");
		expect(result.details.watches).toContain("aabb");
	});

	it("marks terminal watches with [terminal] in the list output", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.watches["aabb"] = makeWatch({ watchId: "aabb", terminal: true });

		const result = await handleToolAction(rt, { action: "list" });

		expect(result.details.message).toContain("[terminal]");
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — pause / resume
// ---------------------------------------------------------------------------

describe("handleToolAction — pause / resume", () => {
	it("sets paused=true on the runtime", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		await handleToolAction(rt, { action: "pause" });
		expect(rt.paused).toBe(true);
	});

	it("clears paused=false on the runtime", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.paused = true;
		await handleToolAction(rt, { action: "resume" });
		expect(rt.paused).toBe(false);
	});

	it("persists state when pausing", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		await handleToolAction(rt, { action: "pause" });
		expect(pi.appendEntry).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — status
// ---------------------------------------------------------------------------

describe("handleToolAction — status", () => {
	it("returns a summary with enabled/disabled and active watch counts", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", terminal: false });
		rt.watches["bb"] = makeWatch({ watchId: "bb", terminal: true });

		const result = await handleToolAction(rt, { action: "status" });

		expect(result.details.ok).toBe(true);
		expect(result.details.message).toContain("enabled");
		expect(result.details.message).toContain("2 total");
		expect(result.details.message).toContain("1 active");
		expect(result.details.message).toContain("1 terminal");
	});

	it("shows 'paused' when the runtime is paused", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		rt.paused = true;

		const result = await handleToolAction(rt, { action: "status" });

		expect(result.details.message).toContain("paused");
	});

	it("shows the current poll interval in seconds", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());

		const result = await handleToolAction(rt, { action: "status" });

		const expectedSeconds = Math.round(POLL_INTERVAL_MS / 1000);
		expect(result.details.message).toContain(`${expectedSeconds}s`);
	});
});

// ---------------------------------------------------------------------------
// handleToolAction — unknown action
// ---------------------------------------------------------------------------

describe("handleToolAction — unknown action", () => {
	it("returns ok=false for an unrecognised action", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeClient());
		const result = await handleToolAction(rt, { action: "bogus" });
		expect(result.details.ok).toBe(false);
		expect(result.details.message).toContain("unknown action");
	});
});

// ---------------------------------------------------------------------------
// pollOnce
// ---------------------------------------------------------------------------

describe("pollOnce", () => {
	it("does nothing when paused", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.paused = true;
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa" });

		await pollOnce(rt);

		expect(client.getJobRun).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does nothing when not enabled", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = false;
		rt.watches["aa"] = makeWatch({ watchId: "aa" });

		await pollOnce(rt);

		expect(client.getJobRun).not.toHaveBeenCalled();
	});

	it("does not call sendMessage when there are no events", async () => {
		const pi = makePi();
		const client = makeClient(); // getJobRun returns RUNNING, baseline is RUNNING
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "RUNNING", errorMessage: "" },
		});

		await pollOnce(rt);

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("sends a chat message when a state change is detected", async () => {
		const pi = makePi();
		const client = makeClient(); // getJobRun returns RUNNING
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "STARTING", errorMessage: "" }, // differs from RUNNING
		});

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [{ customType: string; content: string }, unknown];
		expect(msg.customType).toBe("pi-aws-glue-watcher");
		expect(msg.content).toContain("STARTING");
		expect(msg.content).toContain("RUNNING");
	});

	it("marks a watch as terminal when a terminal state is detected", async () => {
		const pi = makePi();
		const client: GlueClient = {
			...makeClient(),
			getJobRun: vi.fn().mockResolvedValue({
				JobRun: { JobRunState: "SUCCEEDED", ErrorMessage: "" },
			} satisfies JobRunResponse),
		};
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "RUNNING", errorMessage: "" },
		});

		await pollOnce(rt);

		expect(rt.watches["aa"].terminal).toBe(true);
	});

	it("skips terminal watches during polling", async () => {
		const pi = makePi();
		const client = makeClient();
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", terminal: true });

		await pollOnce(rt);

		expect(client.getJobRun).not.toHaveBeenCalled();
	});

	it("continues polling other watches after one throws", async () => {
		const pi = makePi();
		const client = makeClient();
		(client.getJobRun as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValueOnce({
				JobRun: { JobRunState: "RUNNING", ErrorMessage: "" },
			} satisfies JobRunResponse);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", baseline: { state: "RUNNING", errorMessage: "" } });
		rt.watches["bb"] = makeWatch({ watchId: "bb", runId: "jr_xyz", baseline: { state: "STARTING", errorMessage: "" } });

		// Should not throw even though first call fails
		await expect(pollOnce(rt)).resolves.not.toThrow();
	});

	it("persists state after detecting changes", async () => {
		const pi = makePi();
		const client = makeClient(); // returns RUNNING
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({
			watchId: "aa",
			baseline: { state: "STARTING", errorMessage: "" },
		});

		await pollOnce(rt);

		expect(pi.appendEntry).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// pollOnce — error backoff + recovery
// ---------------------------------------------------------------------------

describe("pollOnce — consecutive error tracking", () => {
	it("increments consecutiveErrors on each poll failure", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun").mockRejectedValue(new Error("timeout"));
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", baseline: { state: "RUNNING", errorMessage: "" } });

		await pollOnce(rt);
		expect(rt.watches["aa"].consecutiveErrors).toBe(1);
		await pollOnce(rt);
		expect(rt.watches["aa"].consecutiveErrors).toBe(2);
	});

	it("resets consecutiveErrors to 0 on a successful poll", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun")
			.mockRejectedValueOnce(new Error("timeout"))
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce({ JobRun: { JobRunState: "RUNNING", ErrorMessage: "" } } satisfies JobRunResponse);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", baseline: { state: "RUNNING", errorMessage: "" } });

		await pollOnce(rt);
		await pollOnce(rt);
		expect(rt.watches["aa"].consecutiveErrors).toBe(2);

		await pollOnce(rt);
		expect(rt.watches["aa"].consecutiveErrors).toBe(0);
	});

	it("sends a warning chat message exactly once when threshold is reached", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun").mockRejectedValue(
			Object.assign(new Error("token expired — internal detail"), { name: "CredentialsProviderError" }),
		);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", consecutiveErrors: POLL_ERROR_THRESHOLD - 1, baseline: { state: "RUNNING", errorMessage: "" } });

		// This poll pushes it to threshold — warning should fire
		await pollOnce(rt);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [msg] = pi.sendMessage.mock.calls[0]! as [{ content: string }];
		expect(msg.content).toContain("⚠");
		expect(msg.content).toContain("aa");
		expect(msg.content).toContain("authentication");

		// Subsequent polls should NOT send additional threshold messages
		await pollOnce(rt);
		await pollOnce(rt);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("sends a recovery message (triggerTurn: false) after error streak clears", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun").mockResolvedValue({ JobRun: { JobRunState: "RUNNING", ErrorMessage: "" } } satisfies JobRunResponse);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		// Pre-load with a streak above threshold
		rt.watches["aa"] = makeWatch({ watchId: "aa", consecutiveErrors: POLL_ERROR_THRESHOLD, baseline: { state: "RUNNING", errorMessage: "" } });

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [msg, opts] = pi.sendMessage.mock.calls[0]! as [{ content: string }, { triggerTurn?: boolean } | undefined];
		expect(msg.content).toContain("✓");
		expect(msg.content).toContain("aa");
		expect(msg.content).toContain(`${POLL_ERROR_THRESHOLD} consecutive error`);
		expect(opts?.triggerTurn).toBe(false);
	});

	it("does not send a recovery message when error count was below threshold", async () => {
		const pi = makePi();
		const client = makeClient();
		vi.spyOn(client, "getJobRun").mockResolvedValue({ JobRun: { JobRunState: "RUNNING", ErrorMessage: "" } } satisfies JobRunResponse);
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["aa"] = makeWatch({ watchId: "aa", consecutiveErrors: 2, baseline: { state: "RUNNING", errorMessage: "" } });

		await pollOnce(rt);

		// No change in state, no recovery message (streak below threshold)
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(rt.watches["aa"].consecutiveErrors).toBe(0);
	});
});

describe("POLL_INTERVAL_MAX_MS", () => {
	it("is 15 minutes (900_000 ms)", () => {
		expect(POLL_ERROR_THRESHOLD).toBe(5);
	});
});
