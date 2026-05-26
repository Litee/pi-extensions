import {
	DescribeInstancesCommand,
	EC2Client as AwsEc2Client,
	StartInstancesCommand,
	StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEc2Client, isNotFoundError } from "../src/ec2-client.js";

vi.mock("@aws-sdk/client-ec2", async () => {
	const actual = await vi.importActual<typeof import("@aws-sdk/client-ec2")>(
		"@aws-sdk/client-ec2",
	);
	return {
		...actual,
		EC2Client: vi.fn(),
	};
});
vi.mock("@aws-sdk/credential-providers", () => ({
	fromIni: vi.fn().mockReturnValue({}),
}));

describe("createEc2Client", () => {
	let mockSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.mocked(AwsEc2Client).mockClear();
		mockSend = vi.fn();
		vi.mocked(AwsEc2Client).mockImplementation(function (this: { send: unknown }) {
			this.send = mockSend;
		});
	});

	it("stopInstance sends StopInstancesCommand with correct InstanceIds", async () => {
		mockSend.mockResolvedValue({});
		const client = createEc2Client();
		await client.stopInstance("i-1234abcd", "p", "us-east-1");
		const call = mockSend.mock.calls[0]![0] as StopInstancesCommand;
		expect(call).toBeInstanceOf(StopInstancesCommand);
		expect(call.input).toEqual({ InstanceIds: ["i-1234abcd"] });
	});

	it("startInstance sends StartInstancesCommand with correct InstanceIds", async () => {
		mockSend.mockResolvedValue({});
		const client = createEc2Client();
		await client.startInstance("i-1234abcd", "p", "us-east-1");
		const call = mockSend.mock.calls[0]![0] as StartInstancesCommand;
		expect(call).toBeInstanceOf(StartInstancesCommand);
		expect(call.input).toEqual({ InstanceIds: ["i-1234abcd"] });
	});

	it("describeInstance returns state and metadata on success", async () => {
		mockSend.mockResolvedValue({
			Reservations: [
				{
					Instances: [
						{
							State: { Name: "running" },
							Tags: [{ Key: "Name", Value: "my-instance" }],
							StateTransitionReason: "User initiated",
							Placement: { AvailabilityZone: "us-east-1a" },
							InstanceType: "t3.micro",
						},
					],
				},
			],
		});
		const client = createEc2Client();
		const result = await client.describeInstance("i-1234abcd", "p", "us-east-1");
		expect(result.state).toBe("running");
		expect(result.nameTag).toBe("my-instance");
		expect(result.stateTransitionReason).toBe("User initiated");
		expect(result.availabilityZone).toBe("us-east-1a");
		expect(result.instanceType).toBe("t3.micro");
		expect(result.notFound).toBeUndefined();
		// Verify we sent a DescribeInstancesCommand with the correct instance id.
		const call = mockSend.mock.calls[0]![0] as DescribeInstancesCommand;
		expect(call).toBeInstanceOf(DescribeInstancesCommand);
		expect(call.input).toEqual({ InstanceIds: ["i-1234abcd"] });
	});

	it("returns {notFound:true} when Reservations is empty", async () => {
		mockSend.mockResolvedValue({ Reservations: [] });
		const client = createEc2Client();
		const result = await client.describeInstance("i-1234abcd", "p", "us-east-1");
		expect(result.notFound).toBe(true);
	});

	it("returns {notFound:true} when Instances is empty", async () => {
		mockSend.mockResolvedValue({ Reservations: [{ Instances: [] }] });
		const client = createEc2Client();
		const result = await client.describeInstance("i-1234abcd", "p", "us-east-1");
		expect(result.notFound).toBe(true);
	});

	it("returns {notFound:true} for an InvalidInstanceID.NotFound error", async () => {
		const err = Object.assign(new Error("not found"), {
			name: "InvalidInstanceID.NotFound",
		});
		mockSend.mockRejectedValue(err);
		const client = createEc2Client();
		const result = await client.describeInstance("i-1234abcd", "p", "us-east-1");
		expect(result.notFound).toBe(true);
	});

	it("returns {notFound:true} for $metadata.httpStatusCode===404", async () => {
		const err = Object.assign(new Error("Not Found"), {
			name: "SomeOtherName",
			$metadata: { httpStatusCode: 404 },
		});
		mockSend.mockRejectedValue(err);
		const client = createEc2Client();
		const result = await client.describeInstance("i-1234abcd", "p", "us-east-1");
		expect(result.notFound).toBe(true);
	});

	it("propagates non-404 errors", async () => {
		const err = Object.assign(new Error("auth failed"), {
			name: "CredentialsProviderError",
		});
		mockSend.mockRejectedValue(err);
		const client = createEc2Client();
		await expect(client.describeInstance("i-1234abcd", "p", "us-east-1")).rejects.toBe(err);
	});

	it("reuses the same client for the same profile+region", async () => {
		mockSend.mockResolvedValue({ Reservations: [] });
		const client = createEc2Client();
		await client.describeInstance("i-1234abcd", "p", "us-east-1");
		await client.describeInstance("i-abcd1234", "p", "us-east-1");
		expect(vi.mocked(AwsEc2Client)).toHaveBeenCalledTimes(1);
	});

	it("creates a new client for a different profile", async () => {
		mockSend.mockResolvedValue({ Reservations: [] });
		const client = createEc2Client();
		await client.describeInstance("i-1234abcd", "p1", "us-east-1");
		await client.describeInstance("i-1234abcd", "p2", "us-east-1");
		expect(vi.mocked(AwsEc2Client)).toHaveBeenCalledTimes(2);
	});

	it("omits optional fields when AWS does not return them", async () => {
		mockSend.mockResolvedValue({
			Reservations: [
				{
					Instances: [
						{
							State: { Name: "stopped" },
						},
					],
				},
			],
		});
		const client = createEc2Client();
		const result = await client.describeInstance("i-1234abcd", "p", undefined);
		expect(result.state).toBe("stopped");
		expect(result.nameTag).toBeUndefined();
		expect(result.stateTransitionReason).toBeUndefined();
		expect(result.availabilityZone).toBeUndefined();
		expect(result.instanceType).toBeUndefined();
	});
});

describe("isNotFoundError", () => {
	it("returns true for InvalidInstanceID.NotFound", () => {
		expect(isNotFoundError({ name: "InvalidInstanceID.NotFound" })).toBe(true);
	});
	it("returns true for InvalidInstanceId.NotFound (lower-case 'd')", () => {
		expect(isNotFoundError({ name: "InvalidInstanceId.NotFound" })).toBe(true);
	});
	it("returns true for $metadata.httpStatusCode === 404", () => {
		expect(isNotFoundError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
	});
	it("returns false for AccessDenied", () => {
		expect(isNotFoundError({ name: "AccessDenied" })).toBe(false);
	});
	it("returns false for null/undefined/non-objects", () => {
		expect(isNotFoundError(null)).toBe(false);
		expect(isNotFoundError(undefined)).toBe(false);
		expect(isNotFoundError("404")).toBe(false);
	});
});
