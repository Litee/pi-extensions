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
		} as unknown as typeof AwsGlueClient);
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
});
