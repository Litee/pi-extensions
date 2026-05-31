/**
 * Unit tests for the SDK-backed createGlueClient() factory.
 *
 * Verifies that SDK errors propagate as-is (no wrapping), that GlueCliError
 * is thrown for business-logic failures (no runs found), and that the
 * per-factory client cache reuses AwsGlueClient instances correctly.
 *
 * The real AwsGlueClient and fromIni are mocked so no AWS credentials or
 * network access are required.
 */

import { GlueClient as AwsGlueClient } from "@aws-sdk/client-glue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GlueCliError, createGlueClient } from "../src/glue-client.js";

vi.mock("@aws-sdk/client-glue");
vi.mock("@aws-sdk/credential-providers", () => ({
	fromIni: vi.fn().mockReturnValue({}),
}));

describe("createGlueClient", () => {
	let mockSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.mocked(AwsGlueClient).mockClear();
		mockSend = vi.fn();
		vi.mocked(AwsGlueClient).mockImplementation(function (this: { send: unknown }) {
			this.send = mockSend;
		});
	});

	it("SDK errors propagate as-is (no wrapping)", async () => {
		const sdkErr = Object.assign(new Error("token expired"), { name: "CredentialsProviderError" });
		mockSend.mockRejectedValue(sdkErr);
		const client = createGlueClient();
		await expect(client.getJobRun("j", "r", "prof", "us-east-1")).rejects.toBe(sdkErr);
	});

	it("getLatestJobRunId throws GlueCliError when no runs found", async () => {
		mockSend.mockResolvedValue({ JobRuns: [] });
		const client = createGlueClient();
		await expect(client.getLatestJobRunId("j", "prof", "us-east-1")).rejects.toBeInstanceOf(GlueCliError);
	});

	it("getLatestWorkflowRunId throws GlueCliError when no runs found", async () => {
		mockSend.mockResolvedValue({ Runs: [] });
		const client = createGlueClient();
		await expect(client.getLatestWorkflowRunId("wf", "prof", "us-east-1")).rejects.toBeInstanceOf(GlueCliError);
	});

	it("reuses the same AwsGlueClient instance for the same profile+region", async () => {
		mockSend.mockResolvedValue({ JobRun: { JobRunState: "RUNNING" } });
		const client = createGlueClient();
		await client.getJobRun("j", "r", "prof", "us-east-1");
		await client.getJobRun("j2", "r2", "prof", "us-east-1");
		expect(vi.mocked(AwsGlueClient)).toHaveBeenCalledTimes(1);
	});

	it("creates a new AwsGlueClient for a different profile", async () => {
		mockSend.mockResolvedValue({ JobRun: { JobRunState: "RUNNING" } });
		const client = createGlueClient();
		await client.getJobRun("j", "r", "prof-a", "us-east-1");
		await client.getJobRun("j", "r", "prof-b", "us-east-1");
		expect(vi.mocked(AwsGlueClient)).toHaveBeenCalledTimes(2);
	});

	it("uses a '<default>' cache key when region is undefined", async () => {
		mockSend.mockResolvedValue({ JobRun: { JobRunState: "RUNNING" } });
		const client = createGlueClient();
		await client.getJobRun("j", "r", "prof", undefined);
		await client.getJobRun("j2", "r2", "prof", undefined);
		// Same profile + undefined region → same SDK client
		expect(vi.mocked(AwsGlueClient)).toHaveBeenCalledTimes(1);
	});

	it("creates a new AwsGlueClient for a different region", async () => {
		mockSend.mockResolvedValue({ JobRun: { JobRunState: "RUNNING" } });
		const client = createGlueClient();
		await client.getJobRun("j", "r", "prof", "us-east-1");
		await client.getJobRun("j", "r", "prof", "eu-west-1");
		expect(vi.mocked(AwsGlueClient)).toHaveBeenCalledTimes(2);
	});

	it("getJobRun returns normalised response with dates as ISO strings", async () => {
		const startDate = new Date("2024-01-01T10:00:00.000Z");
		const endDate = new Date("2024-01-01T11:00:00.000Z");
		mockSend.mockResolvedValue({
			JobRun: {
				JobRunState: "SUCCEEDED",
				ErrorMessage: undefined,
				StartedOn: startDate,
				CompletedOn: endDate,
				NumberOfWorkers: 5,
				WorkerType: "G.1X",
				Timeout: 60,
			},
		});
		const client = createGlueClient();
		const result = await client.getJobRun("job", "run", "prof", "us-east-1");
		expect(result.JobRun.JobRunState).toBe("SUCCEEDED");
		expect(result.JobRun.StartedOn).toBe(startDate.toISOString());
		expect(result.JobRun.CompletedOn).toBe(endDate.toISOString());
		expect(result.JobRun.NumberOfWorkers).toBe(5);
		expect(result.JobRun.WorkerType).toBe("G.1X");
		expect(result.JobRun.Timeout).toBe(60);
	});

	it("getJobRun handles undefined jr fields gracefully", async () => {
		mockSend.mockResolvedValue({ JobRun: undefined });
		const client = createGlueClient();
		const result = await client.getJobRun("job", "run", "prof", "us-east-1");
		expect(result.JobRun.JobRunState).toBe("");
		expect(result.JobRun.StartedOn).toBeUndefined();
		expect(result.JobRun.CompletedOn).toBeUndefined();
	});

	it("getWorkflowRun returns normalised response with statistics", async () => {
		mockSend.mockResolvedValue({
			Run: {
				Status: "COMPLETED",
				Statistics: {
					TotalActions: 4,
					SucceededActions: 3,
					FailedActions: 1,
					RunningActions: 0,
				},
				Graph: { Nodes: [] },
			},
		});
		const client = createGlueClient();
		const result = await client.getWorkflowRun("wf", "run", "prof", "us-east-1");
		expect(result.Run.Status).toBe("COMPLETED");
		expect(result.Run.Statistics?.TotalActions).toBe(4);
		expect(result.Run.Statistics?.SucceededActions).toBe(3);
	});

	it("getWorkflowRun returns undefined statistics when absent", async () => {
		mockSend.mockResolvedValue({
			Run: { Status: "RUNNING", Statistics: undefined, Graph: undefined },
		});
		const client = createGlueClient();
		const result = await client.getWorkflowRun("wf", "run", "prof", "us-east-1");
		expect(result.Run.Statistics).toBeUndefined();
		expect(result.Run.Graph).toBeUndefined();
	});

	it("getWorkflowRun normalises nodes with JobDetails and CrawlerDetails", async () => {
		const startDate = new Date("2024-01-01T09:00:00.000Z");
		mockSend.mockResolvedValue({
			Run: {
				Status: "RUNNING",
				Graph: {
					Nodes: [
						{
							Name: "job-node",
							Type: "JOB",
							JobDetails: {
								JobRuns: [
									{
										JobRunState: "RUNNING",
										StartedOn: startDate,
										CompletedOn: undefined,
										NumberOfWorkers: 2,
										WorkerType: "G.2X",
										Timeout: 120,
									},
								],
							},
							CrawlerDetails: undefined,
						},
						{
							Name: "crawler-node",
							Type: "CRAWLER",
							JobDetails: undefined,
							CrawlerDetails: {
								Crawls: [{ State: "SUCCEEDED" }],
							},
						},
					],
				},
			},
		});
		const client = createGlueClient();
		const result = await client.getWorkflowRun("wf", "run", "prof", "us-east-1");
		const nodes = result.Run.Graph?.Nodes ?? [];
		expect(nodes).toHaveLength(2);
		const jobNode = nodes[0]!;
		expect(jobNode.Name).toBe("job-node");
		expect(jobNode.JobDetails?.JobRuns?.[0]?.JobRunState).toBe("RUNNING");
		expect(jobNode.JobDetails?.JobRuns?.[0]?.StartedOn).toBe(startDate.toISOString());
		expect(jobNode.JobDetails?.JobRuns?.[0]?.CompletedOn).toBeUndefined();
		expect(jobNode.CrawlerDetails).toBeUndefined();
		const crawlerNode = nodes[1]!;
		expect(crawlerNode.CrawlerDetails?.Crawls?.[0]?.State).toBe("SUCCEEDED");
		expect(crawlerNode.JobDetails).toBeUndefined();
	});

	it("getWorkflowRun handles nodes with empty JobRuns and Crawls arrays", async () => {
		mockSend.mockResolvedValue({
			Run: {
				Status: "RUNNING",
				Graph: {
					Nodes: [
						{
							Name: "empty-job",
							Type: "JOB",
							JobDetails: { JobRuns: undefined },
							CrawlerDetails: { Crawls: undefined },
						},
					],
				},
			},
		});
		const client = createGlueClient();
		const result = await client.getWorkflowRun("wf", "run", "prof", "us-east-1");
		const nodes = result.Run.Graph?.Nodes ?? [];
		expect(nodes[0]?.JobDetails?.JobRuns).toEqual([]);
		expect(nodes[0]?.CrawlerDetails?.Crawls).toEqual([]);
	});

	it("getLatestJobRunId returns the run ID when found", async () => {
		mockSend.mockResolvedValue({ JobRuns: [{ Id: "jr_abc123" }] });
		const client = createGlueClient();
		const id = await client.getLatestJobRunId("my-job", "prof", "us-east-1");
		expect(id).toBe("jr_abc123");
	});

	it("getLatestWorkflowRunId returns the run ID when found", async () => {
		mockSend.mockResolvedValue({ Runs: [{ WorkflowRunId: "wr_abc123" }] });
		const client = createGlueClient();
		const id = await client.getLatestWorkflowRunId("my-wf", "prof", "us-east-1");
		expect(id).toBe("wr_abc123");
	});

	it("stopJobRun sends BatchStopJobRunCommand", async () => {
		mockSend.mockResolvedValue({});
		const client = createGlueClient();
		await expect(client.stopJobRun("my-job", "jr_123", "prof", "us-east-1")).resolves.toBeUndefined();
		expect(mockSend).toHaveBeenCalledOnce();
	});

	it("stopJobRun works with undefined region", async () => {
		mockSend.mockResolvedValue({});
		const client = createGlueClient();
		await expect(client.stopJobRun("my-job", "jr_123", "prof", undefined)).resolves.toBeUndefined();
		expect(mockSend).toHaveBeenCalledOnce();
	});

	it("stopWorkflowRun sends StopWorkflowRunCommand", async () => {
		mockSend.mockResolvedValue({});
		const client = createGlueClient();
		await expect(client.stopWorkflowRun("my-wf", "wr_123", "prof", "us-east-1")).resolves.toBeUndefined();
		expect(mockSend).toHaveBeenCalledOnce();
	});

	it("stopWorkflowRun works with undefined region", async () => {
		mockSend.mockResolvedValue({});
		const client = createGlueClient();
		await expect(client.stopWorkflowRun("my-wf", "wr_123", "prof", undefined)).resolves.toBeUndefined();
		expect(mockSend).toHaveBeenCalledOnce();
	});

	it("getJobRun with partial optional fields (only some defined)", async () => {
		mockSend.mockResolvedValue({
			JobRun: {
				JobRunState: "RUNNING",
				ErrorMessage: "some error",
				// No StartedOn, CompletedOn, etc.
			},
		});
		const client = createGlueClient();
		const result = await client.getJobRun("job", "run", "prof", "us-east-1");
		expect(result.JobRun.JobRunState).toBe("RUNNING");
		expect(result.JobRun.ErrorMessage).toBe("some error");
		expect(result.JobRun.StartedOn).toBeUndefined();
		expect(result.JobRun.CompletedOn).toBeUndefined();
	});
});
