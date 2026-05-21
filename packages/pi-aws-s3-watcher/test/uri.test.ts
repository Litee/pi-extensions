import { describe, expect, it } from "vitest";

import { compressS3Uri, parseS3Uri, S3UriError } from "../src/uri.js";

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

describe("compressS3Uri", () => {
	it("returns URI as-is when shorter than maxLen", () => {
		const uri = "s3://b/key.txt";
		expect(compressS3Uri(uri, 20)).toBe(uri);
	});

	it("returns URI as-is on exact fit", () => {
		const uri = "s3://b/key.txt";
		expect(compressS3Uri(uri, uri.length)).toBe(uri);
	});

	it("hard-slices when maxLen <= 3 (too small for ellipsis)", () => {
		// maxLen<=3: cannot fit "..." so just slice to maxLen characters
		expect(compressS3Uri("s3://b/key.txt", 2)).toBe("s3");
		expect(compressS3Uri("s3://b/key.txt", 3)).toBe("s3:");
	});

	it("compresses the leftmost overlong middle segment first", () => {
		// "s3://b/long/file.txt" = 20 chars, maxLen 18
		expect(compressS3Uri("s3://b/long/file.txt", 18)).toBe("s3://b/l/file.txt");
	});

	it("compresses multiple middle segments progressively until it fits", () => {
		// "s3://b/2024/01/results/out.json" = 31 chars, maxLen 25
		// compress "2024"→"2": "s3://b/2/01/results/out.json" = 28 > 25
		// compress "01"→"0":   "s3://b/2/0/results/out.json"  = 27 > 25
		// compress "results"→"r": "s3://b/2/0/r/out.json"      = 21 <= 25 ✓
		expect(compressS3Uri("s3://b/2024/01/results/out.json", 25)).toBe(
			"s3://b/2/0/r/out.json",
		);
	});

	it("never shortens the last path segment (filename)", () => {
		// After compressing all middle segments the filename must still be intact
		// "s3://b/alpha/beta/filename.csv" = 30 chars
		// maxLen=23: compress "alpha"→"a", "beta"→"b" → "s3://b/a/b/filename.csv" = 23 chars ✓
		const result = compressS3Uri("s3://b/alpha/beta/filename.csv", 23);
		expect(result).toContain("filename.csv");
	});

	it("falls back to '...' truncation when even full compression doesn't fit", () => {
		// bucket prefix alone is 27 chars, maxLen=10 → all compression still > 10
		const result = compressS3Uri(
			"s3://very-long-bucket-name/a/b/c/d.txt",
			10,
		);
		expect(result).toHaveLength(10);
		expect(result).toMatch(/\.\.\.$/u);
	});

	it("single-segment key (no middle) falls back to '...' truncation", () => {
		// s3://b/longfilename.txt = 22 chars, maxLen=10
		// substring(0, 7) = "s3://b/" + "..." = "s3://b/..." (10 chars)
		const result = compressS3Uri("s3://b/longfilename.txt", 10);
		expect(result).toHaveLength(10);
		expect(result).toMatch(/\.\.\.$/u);
		expect(result).toBe("s3://b/...");
	});

	it("skips already-single-char middle segments and compresses the next one", () => {
		// s3://b/a/b/longfolder/file.txt — "a" and "b" are len-1, skip them
		// s3://b/a/b/longfolder/file.txt = 30 chars, maxLen=25
		// "a" skip, "b" skip, compress "longfolder"→"l": "s3://b/a/b/l/file.txt" = 21 <= 25 ✓
		expect(compressS3Uri("s3://b/a/b/longfolder/file.txt", 25)).toBe(
			"s3://b/a/b/l/file.txt",
		);
	});

	it("falls back to end-truncation for non-s3:// URIs", () => {
		// substring(0, 9) = "https://e" + "..." = "https://e..." (12 chars)
		const result = compressS3Uri("https://example.com/very/long/path", 12);
		expect(result).toHaveLength(12);
		expect(result).toBe("https://e...");
	});
});
