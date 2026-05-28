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

describe('compressS3Uri — ellipsis strategy', () => {
	it('returns URI unchanged when it already fits', () => {
		const uri = 's3://bucket/key.txt'
		expect(compressS3Uri(uri, 80)).toBe(uri)
	})

	it('returns URI unchanged when exactly maxLen', () => {
		const uri = 's3://bucket/key.txt'
		expect(compressS3Uri(uri, uri.length)).toBe(uri)
	})

	it('hard-slices when maxLen <= 1', () => {
		expect(compressS3Uri('s3://b/k', 1)).toBe('s')
		expect(compressS3Uri('s3://b/k', 0)).toBe('')
	})

	it('collapses all middle segments to … when keep=0 fits', () => {
		// s3://b/…/file.txt = 18 chars
		expect(compressS3Uri('s3://b/very/long/path/file.txt', 18)).toBe('s3://b/…/file.txt')
	})

	it('keeps one prefix segment when keep=0 does not fit but keep=1 does', () => {
		// s3://b/a/…/file.txt = 20 chars
		expect(compressS3Uri('s3://b/a/long/path/file.txt', 20)).toBe('s3://b/a/…/file.txt')
	})

	it('preserves the filename (last segment) in full', () => {
		// s3://bucket/…/longfilename.parquet = 34 chars; maxLen=35 lets keep=0 fit
		const result = compressS3Uri('s3://bucket/a/b/c/longfilename.parquet', 35)
		expect(result).toContain('longfilename.parquet')
		expect(result.length).toBeLessThanOrEqual(35)
	})

	it('falls back to end-truncation with … when no ellipsis variant fits', () => {
		// prefix "s3://verylongbucket/" alone is 21 chars, maxLen=10
		const result = compressS3Uri('s3://verylongbucket/a/b/file.txt', 10)
		expect(result).toHaveLength(10)
		expect(result.endsWith('…')).toBe(true)
	})

	it('falls back to end-truncation for single-segment keys (no middle)', () => {
		const result = compressS3Uri('s3://bucket/longfilename.txt', 10)
		expect(result).toHaveLength(10)
		expect(result.endsWith('…')).toBe(true)
	})

	it('falls back to end-truncation for non-s3 URIs', () => {
		const result = compressS3Uri('https://example.com/very/long/path', 12)
		expect(result).toHaveLength(12)
		expect(result.endsWith('…')).toBe(true)
	})

	it('handles URIs with no path separator after bucket', () => {
		const result = compressS3Uri('s3://bucketonly', 5)
		expect(result.length).toBeLessThanOrEqual(5)
		expect(result.endsWith('…')).toBe(true)
	})

	it('uses single … char (not ...)', () => {
		const result = compressS3Uri('s3://b/very/long/path/file.txt', 18)
		expect(result).not.toContain('...')
		expect(result).toContain('…')
	})

	it('real-world example: long DynamoDB export path', () => {
		const uri = 's3://andreyli-experiments-825765387814-us-east-1/2026-03-16-ims-dump/20260317-ims-ddb-export/20260317/AWSDynamoDB/01773752049869-f6f098b7/_started'
		const result = compressS3Uri(uri, 80)
		expect(result.length).toBeLessThanOrEqual(80)
		expect(result).toContain('andreyli-experiments-825765387814-us-east-1')  // bucket preserved
		expect(result).toContain('_started')  // last segment preserved
		expect(result).toContain('…')
	})
})
