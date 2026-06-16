/**
 * Branch-coverage gap-fill for src/s3-client.ts.
 *
 * The existing sdk-client.test.ts already covers the happy-path and the main
 * not-found error names.  These tests cover the remaining uncovered branches:
 *
 *  • headObject: ETag absent / ContentLength absent in the S3 response
 *  • getSdkClient: region === undefined  → spread {} (no `region` key)
 *  • isNotFoundError: $metadata exists but httpStatusCode !== 404
 */

import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createS3Client, isNotFoundError } from "../src/s3-client.js";

vi.mock("@aws-sdk/client-s3", async () => {
	const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>(
		"@aws-sdk/client-s3",
	);
	return { ...actual, S3Client: vi.fn() };
});
vi.mock("@aws-sdk/credential-providers", () => ({
	fromIni: vi.fn().mockReturnValue({}),
}));

describe("createS3Client — headObject response field branches", () => {
	let mockSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.mocked(AwsS3Client).mockClear();
		mockSend = vi.fn();
		vi.mocked(AwsS3Client).mockImplementation(function (this: { send: unknown }) {
			this.send = mockSend;
		});
	});

	it("omits etag when ETag is absent from the S3 response", async () => {
		// typeof out.ETag === "string" → false branch
		mockSend.mockResolvedValue({ ContentLength: 42 });
		const client = createS3Client();
		const out = await client.headObject("b", "k", "p", "us-east-1");
		expect(out.exists).toBe(true);
		expect(out).not.toHaveProperty("etag");
		expect(out.contentLength).toBe(42);
	});

	it("omits contentLength when ContentLength is absent from the S3 response", async () => {
		// typeof out.ContentLength === "number" → false branch
		mockSend.mockResolvedValue({ ETag: '"abc"' });
		const client = createS3Client();
		const out = await client.headObject("b", "k", "p", "us-east-1");
		expect(out.exists).toBe(true);
		expect(out.etag).toBe('"abc"');
		expect(out).not.toHaveProperty("contentLength");
	});

	it("returns {exists:true} with no extra fields when S3 response is empty", async () => {
		// both typeof branches → false
		mockSend.mockResolvedValue({});
		const client = createS3Client();
		const out = await client.headObject("b", "k", "p", "us-east-1");
		expect(out).toEqual({ exists: true });
	});

	it("omits contentLength when ContentLength is a non-number (string)", async () => {
		// typeof out.ContentLength === "number" → false when value is a string
		mockSend.mockResolvedValue({ ETag: '"abc"', ContentLength: "17" });
		const client = createS3Client();
		const out = await client.headObject("b", "k", "p", "us-east-1");
		expect(out.exists).toBe(true);
		expect(out).not.toHaveProperty("contentLength");
	});
});

describe("createS3Client — getSdkClient region branch", () => {
	let mockSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.mocked(AwsS3Client).mockClear();
		mockSend = vi.fn().mockResolvedValue({});
		vi.mocked(AwsS3Client).mockImplementation(function (this: { send: unknown }) {
			this.send = mockSend;
		});
	});

	it("constructs S3Client without a region key when region is undefined", async () => {
		// region !== undefined ? { region } : {}  → false (spread {})
		const client = createS3Client();
		await client.headObject("b", "k", "p", undefined);
		expect(vi.mocked(AwsS3Client)).toHaveBeenCalledTimes(1);
		const ctorArg = vi.mocked(AwsS3Client).mock.calls[0]![0] as Record<string, unknown>;
		expect(ctorArg).not.toHaveProperty("region");
	});

	it("caches the client by profile+undefined-region across calls", async () => {
		const client = createS3Client();
		await client.headObject("b", "k1", "p", undefined);
		await client.headObject("b", "k2", "p", undefined);
		// Same cache key "p:<default>" → only one constructor call
		expect(vi.mocked(AwsS3Client)).toHaveBeenCalledTimes(1);
	});
});

describe("isNotFoundError — $metadata httpStatusCode !== 404", () => {
	it("returns false when $metadata.httpStatusCode is 403 (not 404)", () => {
		// if (status === 404) return true  → false branch: falls through to return false
		expect(isNotFoundError({ $metadata: { httpStatusCode: 403 } })).toBe(false);
	});

	it("returns false when $metadata.httpStatusCode is 500", () => {
		expect(isNotFoundError({ $metadata: { httpStatusCode: 500 } })).toBe(false);
	});

	it("returns false when $metadata exists but httpStatusCode is absent", () => {
		// status === undefined → !== 404 → falls through to return false
		expect(isNotFoundError({ $metadata: {} })).toBe(false);
	});
});
