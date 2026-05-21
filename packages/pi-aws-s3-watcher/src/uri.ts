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

/**
 * Compress a long S3 URI for display within `maxLen` characters.
 *
 * Strategy (in order):
 *  1. If it already fits, return as-is.
 *  2. Parse into `s3://bucket/` prefix + middle path segments + last segment.
 *     Compress middle segments to their first letter, left-to-right, until it fits.
 *  3. If still too long after all segments are compressed, fall back to
 *     end-truncation with "..." (3 ASCII dots, not ellipsis char).
 *
 * The last path segment (filename) is always preserved in full.
 * Segments that are already one character long are skipped.
 */
export function compressS3Uri(uri: string, maxLen: number): string {
	if (uri.length <= maxLen) return uri;
	// Guard: if maxLen is too small to even fit "...", just slice hard.
	if (maxLen <= 3) return uri.substring(0, maxLen);

	const lower = uri.toLowerCase();
	if (!lower.startsWith("s3://")) {
		return uri.substring(0, maxLen - 3) + "...";
	}

	const rest = uri.slice("s3://".length);
	const slashIdx = rest.indexOf("/");
	if (slashIdx === -1) {
		return uri.substring(0, maxLen - 3) + "...";
	}

	const bucket = rest.slice(0, slashIdx);
	const key = rest.slice(slashIdx + 1);
	const prefix = `s3://${bucket}/`;

	const segments = key.split("/");
	// Nothing to compress if there's only one segment (no middle segments)
	if (segments.length <= 1) {
		return uri.substring(0, maxLen - 3) + "...";
	}

	const last = segments[segments.length - 1]!;
	const middle = segments.slice(0, -1);

	// Compress middle segments left-to-right until it fits
	for (let i = 0; i < middle.length; i++) {
		if (middle[i]!.length > 1) {
			middle[i] = middle[i]![0]!;
			const candidate = `${prefix}${middle.join("/")}/${last}`;
			if (candidate.length <= maxLen) return candidate;
		}
	}

	// All middle segments compressed — try the full-compressed form
	const compressed = `${prefix}${middle.join("/")}/${last}`;
	if (compressed.length <= maxLen) return compressed;

	// Still too long: truncate from end
	return compressed.substring(0, maxLen - 3) + "...";
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
