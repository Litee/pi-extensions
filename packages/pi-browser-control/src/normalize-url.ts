/**
 * URL normalization helper.
 *
 * Rules:
 *  1. Remove the fragment (#...) and everything after it.
 *  2. Sort query parameters alphabetically by name (stable).
 *  3. Return null if the URL is null/empty, not parseable, or not http:/https:.
 *  4. Values are re-encoded via URLSearchParams form-encoding (`%20`→`+`, etc.),
 *     so output is canonicalized rather than byte-preserved.
 */

export function normalizeUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	// Remove fragment
	parsed.hash = "";
	// Sort query params by name (stable: preserve relative order of same-named params)
	const entries = [...parsed.searchParams.entries()];
	entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	parsed.search = "";
	entries.forEach(([k, v]) => parsed.searchParams.append(k, v));
	return parsed.toString();
}
