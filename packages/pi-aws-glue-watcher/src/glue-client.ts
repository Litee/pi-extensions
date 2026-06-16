/**
 * AWS Glue API client backed by the AWS SDK v3.
 *
 * Uses `@aws-sdk/client-glue` rather than shelling out to the `aws` CLI.
 * Benefits over the previous CLI approach:
 *   - Credential providers run in-process → no subprocess stderr leaking to
 *     the terminal (eliminates the "ws: [ERROR]: …" UI corruption).
 *   - SDK errors propagate as-is into the poll loop, which classifies them
 *     inline by `.name` (see runtime.ts catch block).
 *   - No per-call subprocess spawn overhead.
 *
 * SDK clients are cached inside each {@link createGlueClient} call by
 * `"profile:region"` so we don't recreate them on every poll. The `fromIni`
 * credential provider re-reads credentials from disk whenever they expire,
 * so an `aws sso login` refresh is picked up automatically.
 *
 * The {@link GlueClient} interface is unchanged — tests inject a stub, and
 * the poll loop never touches this module directly.
 */

import type { GlueClient as AwsGlueClient } from "@aws-sdk/client-glue";

import { createCachedSdkClientFactory } from "pi-watcher-core/aws";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class GlueCliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GlueCliError";
	}
}

// ---------------------------------------------------------------------------
// Response shapes (minimal — only fields the extension cares about)
// ---------------------------------------------------------------------------

export interface JobRunResponse {
	JobRun: {
		JobRunState: string;
		ErrorMessage?: string | undefined;
		/** ISO-8601 timestamp when the run started. */
		StartedOn?: string | undefined;
		/** ISO-8601 timestamp when the run reached a terminal state. */
		CompletedOn?: string | undefined;
		NumberOfWorkers?: number | undefined;
		/** e.g. "G.1X" | "G.2X" | "G.025X" | "Standard" | "Z.2X" */
		WorkerType?: string | undefined;
		/** Run-level timeout in minutes. 0 / absent means inherit job default. */
		Timeout?: number | undefined;
	};
}

export interface WorkflowRunNode {
	Name: string;
	Type: string;
	JobDetails?: {
		JobRuns?: Array<{
			JobRunState: string;
			StartedOn?: string | undefined;
			CompletedOn?: string | undefined;
			NumberOfWorkers?: number | undefined;
			WorkerType?: string | undefined;
			Timeout?: number | undefined;
		}>;
	} | undefined;
	CrawlerDetails?: {
		Crawls?: Array<{ State: string }>;
	} | undefined;
}

export interface WorkflowRunResponse {
	Run: {
		Status: string;
		Statistics?: {
			TotalActions?: number | undefined;
			SucceededActions?: number | undefined;
			FailedActions?: number | undefined;
			RunningActions?: number | undefined;
		} | undefined;
		Graph?: {
			Nodes?: WorkflowRunNode[];
		} | undefined;
	};
}

// ---------------------------------------------------------------------------
// Client interface (injected in production, stubbed in tests)
// ---------------------------------------------------------------------------

export interface GlueClient {
	getJobRun: (
		jobName: string,
		runId: string,
		profile: string,
		region: string | undefined,
	) => Promise<JobRunResponse>;

	getWorkflowRun: (
		workflowName: string,
		runId: string,
		profile: string,
		region: string | undefined,
	) => Promise<WorkflowRunResponse>;

	getLatestJobRunId: (
		jobName: string,
		profile: string,
		region: string | undefined,
	) => Promise<string>;

	getLatestWorkflowRunId: (
		workflowName: string,
		profile: string,
		region: string | undefined,
	) => Promise<string>;

	stopJobRun: (
		jobName: string,
		runId: string,
		profile: string,
		region: string | undefined,
	) => Promise<void>;

	stopWorkflowRun: (
		workflowName: string,
		runId: string,
		profile: string,
		region: string | undefined,
	) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a real {@link GlueClient} backed by the AWS SDK v3. */
export function createGlueClient(): GlueClient {
	const getSdkClient = createCachedSdkClientFactory(async (profile: string, region: string | undefined): Promise<AwsGlueClient> => {
		const { GlueClient } = await import("@aws-sdk/client-glue");
		const { fromIni } = await import("@aws-sdk/credential-providers");
		return new GlueClient({
			credentials: fromIni({ profile }),
			...(region !== undefined ? { region } : {}),
		});
	});

	return {
		async getJobRun(jobName, runId, profile, region) {
			const { GetJobRunCommand } = await import("@aws-sdk/client-glue");
			const out = await (await getSdkClient(profile, region)).send(
				new GetJobRunCommand({ JobName: jobName, RunId: runId }),
			);
			const jr = out.JobRun;
			return {
				JobRun: {
					JobRunState: jr?.JobRunState ?? "",
					ErrorMessage: jr?.ErrorMessage,
					StartedOn: jr?.StartedOn?.toISOString(),
					CompletedOn: jr?.CompletedOn?.toISOString(),
					NumberOfWorkers: jr?.NumberOfWorkers,
					WorkerType: jr?.WorkerType,
					Timeout: jr?.Timeout,
				},
			};
		},

		async getWorkflowRun(workflowName, runId, profile, region) {
			const { GetWorkflowRunCommand } = await import("@aws-sdk/client-glue");
			const out = await (await getSdkClient(profile, region)).send(
				new GetWorkflowRunCommand({ Name: workflowName, RunId: runId, IncludeGraph: true }),
			);
			const run = out.Run;
			const stats = run?.Statistics;
			return {
				Run: {
					Status: run?.Status ?? "",
					Statistics: stats !== undefined
						? {
								TotalActions: stats.TotalActions,
								SucceededActions: stats.SucceededActions,
								FailedActions: stats.FailedActions,
								RunningActions: stats.RunningActions,
						  }
						: undefined,
					Graph: run?.Graph !== undefined
						? {
								Nodes: (run.Graph.Nodes ?? []).map((n) => ({
									Name: n.Name ?? "",
									Type: n.Type ?? "",
									JobDetails: n.JobDetails !== undefined
										? {
												JobRuns: (n.JobDetails.JobRuns ?? []).map((jr) => ({
													JobRunState: jr.JobRunState ?? "",
													StartedOn: jr.StartedOn?.toISOString(),
													CompletedOn: jr.CompletedOn?.toISOString(),
													NumberOfWorkers: jr.NumberOfWorkers,
													WorkerType: jr.WorkerType,
													Timeout: jr.Timeout,
												})),
										  }
										: undefined,
									CrawlerDetails: n.CrawlerDetails !== undefined
										? {
												Crawls: (n.CrawlerDetails.Crawls ?? []).map((c) => ({
													State: c.State ?? "",
												})),
										  }
										: undefined,
								})),
						  }
						: undefined,
				},
			};
		},

		async getLatestJobRunId(jobName, profile, region) {
			const { GetJobRunsCommand } = await import("@aws-sdk/client-glue");
			const out = await (await getSdkClient(profile, region)).send(
				new GetJobRunsCommand({ JobName: jobName, MaxResults: 1 }),
			);
			const id = out.JobRuns?.[0]?.Id;
			if (!id) throw new GlueCliError(`No runs found for job '${jobName}'`);
			return id;
		},

		async getLatestWorkflowRunId(workflowName, profile, region) {
			const { GetWorkflowRunsCommand } = await import("@aws-sdk/client-glue");
			const out = await (await getSdkClient(profile, region)).send(
				new GetWorkflowRunsCommand({ Name: workflowName, MaxResults: 1 }),
			);
			const wfRunId = out.Runs?.[0]?.WorkflowRunId;
			if (!wfRunId) throw new GlueCliError(`No runs found for workflow '${workflowName}'`);
			return wfRunId;
		},

		async stopJobRun(jobName, runId, profile, region) {
			const { BatchStopJobRunCommand } = await import("@aws-sdk/client-glue");
			await (await getSdkClient(profile, region)).send(
				new BatchStopJobRunCommand({ JobName: jobName, JobRunIds: [runId] }),
			);
		},

		async stopWorkflowRun(workflowName, runId, profile, region) {
			const { StopWorkflowRunCommand } = await import("@aws-sdk/client-glue");
			await (await getSdkClient(profile, region)).send(
				new StopWorkflowRunCommand({ Name: workflowName, RunId: runId }),
			);
		},
	};
}
