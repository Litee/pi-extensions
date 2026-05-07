/**
 * Thin AWS CLI wrapper.
 *
 * All AWS Glue API calls are delegated to the `aws glue` CLI rather than an
 * npm SDK client, so the package carries zero runtime npm dependencies. The
 * real CLI is never called in tests — callers inject a {@link GlueClient}
 * stub instead.
 *
 * Excluded from coverage: this module is a thin `exec("aws glue …")` shim
 * and cannot be meaningfully unit-tested without running the actual CLI.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Error type
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
		ErrorMessage?: string;
		/** ISO-8601 timestamp when the run started. */
		StartedOn?: string;
		NumberOfWorkers?: number;
		/** e.g. "G.1X" | "G.2X" | "G.025X" | "Standard" | "Z.2X" */
		WorkerType?: string;
	};
}

export interface WorkflowRunNode {
	Name: string;
	Type: string;
	JobDetails?: {
		JobRuns?: Array<{
			JobRunState: string;
			StartedOn?: string;
			NumberOfWorkers?: number;
			WorkerType?: string;
		}>;
	};
	CrawlerDetails?: {
		Crawls?: Array<{ State: string }>;
	};
}

export interface WorkflowRunResponse {
	Run: {
		Status: string;
		Statistics?: {
			TotalActions?: number;
			SucceededActions?: number;
			FailedActions?: number;
			RunningActions?: number;
		};
		Graph?: {
			Nodes?: WorkflowRunNode[];
		};
	};
}

// ---------------------------------------------------------------------------
// Client interface (injected in production, stubbed in tests)
// ---------------------------------------------------------------------------

export interface GlueClient {
	getJobRun(
		jobName: string,
		runId: string,
		profile: string,
		region: string | undefined,
	): Promise<JobRunResponse>;

	getWorkflowRun(
		workflowName: string,
		runId: string,
		profile: string,
		region: string | undefined,
	): Promise<WorkflowRunResponse>;

	getLatestJobRunId(
		jobName: string,
		profile: string,
		region: string | undefined,
	): Promise<string>;

	getLatestWorkflowRunId(
		workflowName: string,
		profile: string,
		region: string | undefined,
	): Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function regionFlag(region: string | undefined): string {
	return region ? ` --region ${region}` : "";
}

async function awsCli(command: string): Promise<unknown> {
	try {
		const { stdout } = await execAsync(command, { timeout: 30_000 });
		return JSON.parse(stdout) as unknown;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new GlueCliError(`aws glue failed: ${msg}`);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a real {@link GlueClient} backed by the local `aws` CLI. */
export function createGlueClient(): GlueClient {
	return {
		async getJobRun(jobName, runId, profile, region) {
			const cmd = [
				"aws glue get-job-run",
				`--job-name ${JSON.stringify(jobName)}`,
				`--run-id ${JSON.stringify(runId)}`,
				`--profile ${JSON.stringify(profile)}`,
				regionFlag(region),
				"--output json",
			].join(" ");
			return (await awsCli(cmd)) as JobRunResponse;
		},

		async getWorkflowRun(workflowName, runId, profile, region) {
			const cmd = [
				"aws glue get-workflow-run",
				`--name ${JSON.stringify(workflowName)}`,
				`--run-id ${JSON.stringify(runId)}`,
				"--include-graph",
				`--profile ${JSON.stringify(profile)}`,
				regionFlag(region),
				"--output json",
			].join(" ");
			return (await awsCli(cmd)) as WorkflowRunResponse;
		},

		async getLatestJobRunId(jobName, profile, region) {
			const cmd = [
				"aws glue get-job-runs",
				`--job-name ${JSON.stringify(jobName)}`,
				"--max-results 1",
				`--profile ${JSON.stringify(profile)}`,
				regionFlag(region),
				"--output json",
			].join(" ");
			const result = (await awsCli(cmd)) as { JobRuns?: Array<{ Id?: string }> };
			const id = result.JobRuns?.[0]?.Id;
			if (!id) throw new GlueCliError(`No runs found for job '${jobName}'`);
			return id;
		},

		async getLatestWorkflowRunId(workflowName, profile, region) {
			const cmd = [
				"aws glue get-workflow-runs",
				`--name ${JSON.stringify(workflowName)}`,
				"--max-results 1",
				`--profile ${JSON.stringify(profile)}`,
				regionFlag(region),
				"--output json",
			].join(" ");
			const result = (await awsCli(cmd)) as {
				Runs?: Array<{ WorkflowRunId?: string }>;
			};
			const wfRunId = result.Runs?.[0]?.WorkflowRunId;
			if (!wfRunId) throw new GlueCliError(`No runs found for workflow '${workflowName}'`);
			return wfRunId;
		},
	};
}
