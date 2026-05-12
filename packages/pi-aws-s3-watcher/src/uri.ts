/**
 * Parse an `s3://bucket/key` URI into its bucket and key components.
 *
 * Rules:
 *   - Scheme must be exactly `s3://` (case-insensitive).
 *   - Bucket must be non-empty and must not contain `/`.
 *   - Key must be non-empty. Leading/trailing whitespace is rejected.
 *   - Any path segments after the bucket are joined back into the key.
 */
export interface S3Uri {
	bucket: string;
	key: string;
}

export class S3UriError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "S3UriError";
	}
}

export function parseS3Uri(raw: string): S3Uri {
	if (typeof raw !== "string") {
		throw new S3UriError("S3 URI must be a string");
	}
	const trimmed = raw.trim();
	if (trimmed !== raw) {
		throw new S3UriError("S3 URI must not contain leading/trailing whitespace");
	}
	const lower = trimmed.toLowerCase();
	if (!lower.startsWith("s3://")) {
		throw new S3UriError(`S3 URI must start with 's3://': ${JSON.stringify(raw)}`);
	}
	const rest = trimmed.slice("s3://".length);
	const slashIdx = rest.indexOf("/");
	if (slashIdx === -1) {
		throw new S3UriError(`S3 URI must include an object key: ${JSON.stringify(raw)}`);
	}
	const bucket = rest.slice(0, slashIdx);
	const key = rest.slice(slashIdx + 1);
	if (bucket === "") {
		throw new S3UriError(`S3 URI has an empty bucket: ${JSON.stringify(raw)}`);
	}
	if (key === "") {
		throw new S3UriError(`S3 URI has an empty key: ${JSON.stringify(raw)}`);
	}
	return { bucket, key };
}
