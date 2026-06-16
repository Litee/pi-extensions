/**
 * Branch-coverage gap-fill for ec2-client.ts.
 *
 * Covers the branch not exercised by sdk-client.test.ts:
 *   - L127: instance.LaunchTime instanceof Date → true branch
 */

import {
	DescribeInstancesCommand,
	EC2Client as AwsEc2Client,
} from "@aws-sdk/client-ec2";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEc2Client } from "../src/ec2-client.js";

vi.mock("@aws-sdk/client-ec2", async () => {
	const actual = await vi.importActual<typeof import("@aws-sdk/client-ec2")>(
		"@aws-sdk/client-ec2",
	);
	return { ...actual, EC2Client: vi.fn() };
});
vi.mock("@aws-sdk/credential-providers", () => ({
	fromIni: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// isNotFoundError — $metadata present but httpStatusCode !== 404 (L62 false branch)
// ---------------------------------------------------------------------------

import { isNotFoundError } from "../src/ec2-client.js";

describe("isNotFoundError — $metadata with non-404 httpStatusCode", () => {
	it("returns false when $metadata is present but httpStatusCode is 500 (L62 false branch)", () => {
		// metadata check passes (object), but status !== 404 → falls through to return false
		expect(
			isNotFoundError({
				name: "InternalServerError",
				$metadata: { httpStatusCode: 500 },
			}),
		).toBe(false);
	});

	it("returns false when $metadata is present with httpStatusCode undefined (L62 false branch)", () => {
		expect(isNotFoundError({ $metadata: {} })).toBe(false);
	});
});

describe("createEc2Client — describeInstance LaunchTime branch", () => {
	let mockSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.mocked(AwsEc2Client).mockClear();
		mockSend = vi.fn();
		vi.mocked(AwsEc2Client).mockImplementation(function (
			this: { send: unknown },
		) {
			this.send = mockSend;
		});
	});

	it("returns launchTime when LaunchTime is a Date instance (L127 true branch)", async () => {
		const launchDate = new Date("2024-04-01T10:00:00.000Z");
		mockSend.mockResolvedValue({
			Reservations: [
				{
					Instances: [
						{
							State: { Name: "running" },
							LaunchTime: launchDate,
						},
					],
				},
			],
		});

		const client = createEc2Client();
		const result = await client.describeInstance("i-1234abcd", "p", "us-east-1");

		expect(result.state).toBe("running");
		expect(result.launchTime).toBeInstanceOf(Date);
		expect(result.launchTime).toEqual(launchDate);

		const call = mockSend.mock.calls[0]![0] as DescribeInstancesCommand;
		expect(call).toBeInstanceOf(DescribeInstancesCommand);
	});

	it("omits launchTime when LaunchTime is not a Date (L127 false branch — already covered, kept for symmetry)", async () => {
		mockSend.mockResolvedValue({
			Reservations: [
				{
					Instances: [
						{
							State: { Name: "stopped" },
							// LaunchTime absent → not a Date
						},
					],
				},
			],
		});

		const client = createEc2Client();
		const result = await client.describeInstance("i-1234abcd", "p", "us-east-1");

		expect(result.state).toBe("stopped");
		expect(result.launchTime).toBeUndefined();
	});
});
