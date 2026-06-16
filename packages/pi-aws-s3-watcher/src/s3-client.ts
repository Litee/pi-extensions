/**
 * AWS S3 API client backed by the AWS SDK v3.
 *
 * Uses `@aws-sdk/client-s3` rather than shelling out to the `aws` CLI.
 * Benefits:
 *   - Credential providers run in-process — no subprocess stderr leaking
 *     into the terminal.
 *   - SDK errors propagate as-is; the poll loop classifies them by `.name`.
 *   - No per-call subprocess spawn overhead.
 *
 * SDK clients are cached inside each {@link createS3Client} call by
 * `"profile:region"` so we don't recreate them on every poll.
 */

import type { S3Client as AwsS3Client } from "@aws-sdk/client-s3";

import { createCachedSdkClientFactory, makeIsNotFoundError } from "pi-watcher-core/aws";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface HeadObjectResult {
	exists: boolean;
	/** Quoted ETag as returned by S3 (only present when `exists === true`). */
	etag?: string;
	/** Size in bytes (only present when `exists === true`). */
	contentLength?: number;
}

// ---------------------------------------------------------------------------
// Client interface (injected in production, stubbed in tests)
// ---------------------------------------------------------------------------

export interface S3Client {
	headObject: (
		bucket: string,
		key: string,
		profile: string,
		region: string | undefined,
	) => Promise<HeadObjectResult>;
}

// ---------------------------------------------------------------------------
// Error-name classification
// ---------------------------------------------------------------------------

const NOT_FOUND_NAMES = new Set(["NotFound", "NoSuchKey", "404"]);

/**
 * Detect the narrow "object absent" case.
 *
 * S3 HeadObject returns a 404 either as `NotFound` (when the bucket exists
 * but the key does not) or `NoSuchKey` (when the key is missing inside an
 * accessible bucket). Some HTTP-level shims also surface the raw `"404"`.
 *
 * Every OTHER error (403, throttling, auth-expiry, network) propagates so
 * the poll loop can classify it appropriately.
 */
export const isNotFoundError = makeIsNotFoundError(NOT_FOUND_NAMES);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a real {@link S3Client} backed by the AWS SDK v3. */
export function createS3Client(): S3Client {
	const getSdkClient = createCachedSdkClientFactory(async (profile: string, region: string | undefined): Promise<AwsS3Client> => {
		const { S3Client } = await import("@aws-sdk/client-s3");
		const { fromIni } = await import("@aws-sdk/credential-providers");
		return new S3Client({
			credentials: fromIni({ profile }),
			...(region !== undefined ? { region } : {}),
		});
	});

	return {
		async headObject(bucket, key, profile, region) {
			const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
			try {
				const out = await (await getSdkClient(profile, region)).send(
					new HeadObjectCommand({ Bucket: bucket, Key: key }),
				);
				const result: HeadObjectResult = { exists: true };
				if (typeof out.ETag === "string") result.etag = out.ETag;
				if (typeof out.ContentLength === "number") {
					result.contentLength = out.ContentLength;
				}
				return result;
			} catch (err) {
				if (isNotFoundError(err)) return { exists: false };
				throw err;
			}
		},
	};
}
