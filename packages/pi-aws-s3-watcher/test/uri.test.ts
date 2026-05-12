import { describe, expect, it } from "vitest";

import { parseS3Uri, S3UriError } from "../src/uri.js";

describe("parseS3Uri", () => {
	it("parses a simple s3://bucket/key URI", () => {
		expect(parseS3Uri("s3://my-bucket/path/to/object.txt")).toEqual({
			bucket: "my-bucket",
			key: "path/to/object.txt",
		});
	});

	it("accepts uppercase scheme", () => {
		expect(parseS3Uri("S3://my-bucket/k")).toEqual({ bucket: "my-bucket", key: "k" });
	});

	it("preserves embedded slashes in the key", () => {
		expect(parseS3Uri("s3://b/a/b/c")).toEqual({ bucket: "b", key: "a/b/c" });
	});

	it("rejects the wrong scheme", () => {
		expect(() => parseS3Uri("https://example.com/x")).toThrow(S3UriError);
	});

	it("rejects missing key", () => {
		expect(() => parseS3Uri("s3://my-bucket")).toThrow(/must include an object key/);
	});

	it("rejects empty bucket", () => {
		expect(() => parseS3Uri("s3:///key")).toThrow(/empty bucket/);
	});

	it("rejects empty key", () => {
		expect(() => parseS3Uri("s3://b/")).toThrow(/empty key/);
	});

	it("rejects surrounding whitespace (caller's job to trim)", () => {
		expect(() => parseS3Uri(" s3://b/k ")).toThrow(/whitespace/);
	});
});
