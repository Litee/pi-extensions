import { HeadObjectCommand, S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createS3Client, isNotFoundError } from "../src/s3-client.js";

vi.mock("@aws-sdk/client-s3", async () => {
	const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>(
		"@aws-sdk/client-s3",
	);
	return {
		...actual,
		S3Client: vi.fn(),
	};
});
vi.mock("@aws-sdk/credential-providers", () => ({
	fromIni: vi.fn().mockReturnValue({}),
}));

describe("createS3Client", () => {
	let mockSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.mocked(AwsS3Client).mockClear();
		mockSend = vi.fn();
		vi.mocked(AwsS3Client).mockImplementation(function (this: { send: unknown }) {
			this.send = mockSend;
		});
	});

	it("headObject maps a successful response to {exists, etag, contentLength}", async () => {
		mockSend.mockResolvedValue({ ETag: '"abc"', ContentLength: 17 });
		const client = createS3Client();
		const out = await client.headObject("b", "k", "p", "us-east-1");
		expect(out).toEqual({ exists: true, etag: '"abc"', contentLength: 17 });
		// Assert we actually sent a HeadObjectCommand with the right inputs.
		const call = mockSend.mock.calls[0]![0] as HeadObjectCommand;
		expect(call).toBeInstanceOf(HeadObjectCommand);
		expect(call.input).toEqual({ Bucket: "b", Key: "k" });
	});

	it("headObject returns {exists:false} for a NotFound error", async () => {
		const err = Object.assign(new Error("Not Found"), { name: "NotFound" });
		mockSend.mockRejectedValue(err);
		const client = createS3Client();
		await expect(client.headObject("b", "k", "p", "us-east-1")).resolves.toEqual({
			exists: false,
		});
	});

	it("headObject returns {exists:false} for a NoSuchKey error", async () => {
		const err = Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
		mockSend.mockRejectedValue(err);
		const client = createS3Client();
		await expect(client.headObject("b", "k", "p", "us-east-1")).resolves.toEqual({
			exists: false,
		});
	});

	it("headObject returns {exists:false} when $metadata.httpStatusCode === 404", async () => {
		const err = Object.assign(new Error("Not Found"), {
			name: "UnexpectedName",
			$metadata: { httpStatusCode: 404 },
		});
		mockSend.mockRejectedValue(err);
		const client = createS3Client();
		await expect(client.headObject("b", "k", "p", "us-east-1")).resolves.toEqual({
			exists: false,
		});
	});

	it("non-404 SDK errors propagate as-is (no wrapping)", async () => {
		const err = Object.assign(new Error("token expired"), {
			name: "CredentialsProviderError",
		});
		mockSend.mockRejectedValue(err);
		const client = createS3Client();
		await expect(client.headObject("b", "k", "p", "us-east-1")).rejects.toBe(err);
	});

	it("reuses the same AwsS3Client instance for same profile+region", async () => {
		mockSend.mockResolvedValue({ ETag: '"x"', ContentLength: 1 });
		const client = createS3Client();
		await client.headObject("b", "k1", "p", "us-east-1");
		await client.headObject("b", "k2", "p", "us-east-1");
		expect(vi.mocked(AwsS3Client)).toHaveBeenCalledTimes(1);
	});

	it("creates a new AwsS3Client for a different profile", async () => {
		mockSend.mockResolvedValue({ ETag: '"x"', ContentLength: 1 });
		const client = createS3Client();
		await client.headObject("b", "k", "p1", "us-east-1");
		await client.headObject("b", "k", "p2", "us-east-1");
		expect(vi.mocked(AwsS3Client)).toHaveBeenCalledTimes(2);
	});
});

describe("isNotFoundError", () => {
	it("returns true for a NotFound error.name", () => {
		expect(isNotFoundError({ name: "NotFound" })).toBe(true);
	});
	it("returns true for a NoSuchKey error.name", () => {
		expect(isNotFoundError({ name: "NoSuchKey" })).toBe(true);
	});
	it("returns true for $metadata.httpStatusCode === 404", () => {
		expect(isNotFoundError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
	});
	it("returns false for an arbitrary error", () => {
		expect(isNotFoundError({ name: "AccessDenied" })).toBe(false);
	});
	it("returns false for null / undefined / non-objects", () => {
		expect(isNotFoundError(null)).toBe(false);
		expect(isNotFoundError(undefined)).toBe(false);
		expect(isNotFoundError("404")).toBe(false);
	});
});
