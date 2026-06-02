/**
 * Tests for src/normalize-url.ts
 *
 * Covers the normalization spec:
 *  1. Remove the fragment (#...) and everything after it.
 *  2. Sort query parameters alphabetically by name (stable sort).
 *  3. Return null for null/empty, unparseable, or non-http/https URLs.
 *  4. Values are re-encoded via URLSearchParams form-encoding (`%20`→`+`, etc.), so output is canonicalized rather than byte-preserved.
 */

import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../src/normalize-url.js";

// ---------------------------------------------------------------------------
// Null / invalid inputs → null
// ---------------------------------------------------------------------------

describe("normalizeUrl — invalid/unsupported inputs → null", () => {
	it("returns null for null", () => {
		expect(normalizeUrl(null)).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(normalizeUrl(undefined)).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(normalizeUrl("")).toBeNull();
	});

	it("returns null for an unparseable string", () => {
		expect(normalizeUrl("not a url at all!!!")).toBeNull();
	});

	it("returns null for about:newtab", () => {
		expect(normalizeUrl("about:newtab")).toBeNull();
	});

	it("returns null for moz-extension:// URLs", () => {
		expect(normalizeUrl("moz-extension://abc-def/popup.html")).toBeNull();
	});

	it("returns null for file:// URLs", () => {
		expect(normalizeUrl("file:///Users/me/index.html")).toBeNull();
	});

	it("returns null for ftp:// URLs", () => {
		expect(normalizeUrl("ftp://example.com/file.txt")).toBeNull();
	});

	it("returns null for chrome:// URLs", () => {
		expect(normalizeUrl("chrome://newtab/")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Fragment removal
// ---------------------------------------------------------------------------

describe("normalizeUrl — fragment removal", () => {
	it("strips the fragment from an HTTP URL", () => {
		expect(normalizeUrl("http://example.com/page#section")).toBe("http://example.com/page");
	});

	it("strips the fragment from an HTTPS URL", () => {
		expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
	});

	it("strips the fragment when combined with query params", () => {
		expect(normalizeUrl("https://example.com/page?b=2&a=1#hash")).toBe(
			"https://example.com/page?a=1&b=2",
		);
	});

	it("leaves URL unchanged when there is no fragment", () => {
		expect(normalizeUrl("https://example.com/page")).toBe("https://example.com/page");
	});
});

// ---------------------------------------------------------------------------
// Query parameter sorting
// ---------------------------------------------------------------------------

describe("normalizeUrl — query param sorting", () => {
	it("sorts params alphabetically by name", () => {
		expect(normalizeUrl("https://example.com/?z=1&a=2&m=3")).toBe(
			"https://example.com/?a=2&m=3&z=1",
		);
	});

	it("leaves already-sorted params unchanged", () => {
		expect(normalizeUrl("https://example.com/?a=1&b=2&c=3")).toBe(
			"https://example.com/?a=1&b=2&c=3",
		);
	});

	it("preserves relative order of params with identical names (stable sort)", () => {
		const result = normalizeUrl("https://example.com/?tag=first&tag=second&a=x");
		// 'a' sorts before 'tag'; 'tag=first' must precede 'tag=second'
		expect(result).toBe("https://example.com/?a=x&tag=first&tag=second");
	});

	it("drops the '?' when there are no query params", () => {
		const result = normalizeUrl("https://example.com/path");
		expect(result).toBe("https://example.com/path");
		expect(result).not.toContain("?");
	});

	it("handles a single query param with no reordering needed", () => {
		expect(normalizeUrl("https://example.com/?q=hello")).toBe(
			"https://example.com/?q=hello",
		);
	});
});

// ---------------------------------------------------------------------------
// Fragment + query params combined
// ---------------------------------------------------------------------------

describe("normalizeUrl — fragment and query params together", () => {
	it("sorts params AND strips fragment", () => {
		expect(normalizeUrl("https://example.com/search?z=last&a=first#top")).toBe(
			"https://example.com/search?a=first&z=last",
		);
	});
});

// ---------------------------------------------------------------------------
// https: scheme is normalized
// ---------------------------------------------------------------------------

describe("normalizeUrl — https scheme", () => {
	it("normalizes a plain https URL", () => {
		expect(normalizeUrl("https://www.example.com/")).toBe("https://www.example.com/");
	});

	it("normalizes https URL with query params", () => {
		expect(normalizeUrl("https://www.example.com/?c=3&b=2&a=1")).toBe(
			"https://www.example.com/?a=1&b=2&c=3",
		);
	});
});

// ---------------------------------------------------------------------------
// URL with no query params, no fragment → pass-through (unchanged)
// ---------------------------------------------------------------------------

describe("normalizeUrl — no-op cases", () => {
	it("returns the canonical form for a simple URL", () => {
		// new URL('https://example.com') normalizes to 'https://example.com/'
		expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
	});

	it("preserves path", () => {
		expect(normalizeUrl("https://example.com/a/b/c")).toBe("https://example.com/a/b/c");
	});
});
