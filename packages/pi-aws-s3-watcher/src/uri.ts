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
 *  2. If `maxLen <= 1`, hard-slice to `maxLen`.
 *  3. If not an `s3://` URI, return `uri.slice(0, maxLen - 1) + '…'`.
 *  4. Parse into `prefix = "s3://bucket/"`, `middle[]` (all segments except
 *     last), and `last` (filename).
 *  5. If no middle segments, fallback truncate: `uri.slice(0, maxLen - 1) + '…'`.
 *  6. Find the most informative ellipsis form that still fits — try forms from
 *     most-compressed to least-compressed, keeping the last one that fits:
 *       keep=0: `s3://bucket/…/last`
 *       keep=1: `s3://bucket/seg0/…/last`
 *       … up to keep = middle.length - 1
 *     Since each successive form is strictly longer, iteration stops at the
 *     first form that exceeds `maxLen`.
 *  7. If no ellipsis form fits, fallback truncate: `uri.slice(0, maxLen - 1) + '…'`.
 *
 * Uses a single `…` (U+2026 HORIZONTAL ELLIPSIS, 1 char) throughout.
 * The last path segment (filename) is always preserved when any ellipsis form fits.
 */
export function compressS3Uri(uri: string, maxLen: number): string {
	if (uri.length <= maxLen) return uri;
	if (maxLen <= 1) return uri.slice(0, maxLen);

	const lower = uri.toLowerCase();
	if (!lower.startsWith("s3://")) {
		return uri.slice(0, maxLen - 1) + "\u2026";
	}

	const rest = uri.slice("s3://".length);
	const slashIdx = rest.indexOf("/");
	if (slashIdx === -1) {
		return uri.slice(0, maxLen - 1) + "\u2026";
	}

	const bucket = rest.slice(0, slashIdx);
	const key = rest.slice(slashIdx + 1);
	const prefix = `s3://${bucket}/`;

	const segments = key.split("/");
	if (segments.length <= 1) {
		return uri.slice(0, maxLen - 1) + "\u2026";
	}

	const last = segments[segments.length - 1]!;
	const middle = segments.slice(0, -1);

	// Find the most informative (largest keep) ellipsis form that still fits.
	// Since each successive candidate is strictly longer, stop at first overshoot.
	let best: string | null = null;
	for (let keep = 0; keep < middle.length; keep++) {
		const candidate =
			keep === 0
				? `${prefix}\u2026/${last}`
				: `${prefix}${middle.slice(0, keep).join("/")}/\u2026/${last}`;
		if (candidate.length <= maxLen) {
			best = candidate;
		} else {
			break;
		}
	}
	if (best !== null) return best;

	// No ellipsis form fits — fall back to end-truncation
	return uri.slice(0, maxLen - 1) + "\u2026";
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
