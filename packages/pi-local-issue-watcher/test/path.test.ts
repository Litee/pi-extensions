import { describe, expect, it } from "vitest";

import { abbreviatePath } from "../src/path.js";

describe("abbreviatePath", () => {
	it("returns empty string unchanged", () => {
		expect(abbreviatePath("")).toBe("");
	});

	it("returns '/' unchanged (root)", () => {
		expect(abbreviatePath("/")).toBe("/");
	});

	it("abbreviates an absolute multi-segment path (spec example)", () => {
		expect(abbreviatePath("/home/user/projects/tracker")).toBe(
			"/h/u/p/tracker",
		);
	});

	it("preserves the leading dot on dotfile segments (spec example)", () => {
		expect(abbreviatePath("/Users/alice/.pi/skills")).toBe("/U/a/.p/skills");
	});

	it("leaves a single-segment absolute path alone", () => {
		expect(abbreviatePath("/tracker")).toBe("/tracker");
	});

	it("handles a ~/ prefix — single segment is unchanged", () => {
		expect(abbreviatePath("~/tracker")).toBe("~/tracker");
	});

	it("handles a ~/ prefix — multi-segment is abbreviated", () => {
		expect(abbreviatePath("~/projects/skill-issue-tracker")).toBe(
			"~/p/skill-issue-tracker",
		);
	});

	it("handles a ./ prefix (spec example)", () => {
		expect(abbreviatePath("./foo/bar/baz")).toBe("./f/b/baz");
	});

	it("handles a bare relative path (no prefix)", () => {
		expect(abbreviatePath("foo/bar/baz")).toBe("f/b/baz");
	});

	it("leaves a single bare segment alone", () => {
		expect(abbreviatePath("foo")).toBe("foo");
	});

	it("collapses empty segments from double slashes", () => {
		expect(abbreviatePath("/foo//bar/baz")).toBe("/f/b/baz");
	});

	it("strips a trailing slash before processing", () => {
		expect(abbreviatePath("/foo/bar/baz/")).toBe("/f/b/baz");
	});

	it("leaves ~/ alone when there is no segment after it", () => {
		expect(abbreviatePath("~/")).toBe("~/");
	});

	it("leaves ./ alone when there is no segment after it", () => {
		expect(abbreviatePath("./")).toBe("./");
	});

	// -- unicode ------------------------------------------------------------

	it("takes the first grapheme (single-codepoint unicode)", () => {
		// é as a single codepoint (U+00E9).
		expect(abbreviatePath("/café/résumé/file")).toBe("/c/r/file");
	});

	it("takes the first grapheme (combining-mark unicode)", () => {
		// "é" written as e + U+0301 combining acute = two codepoints, one grapheme.
		expect(abbreviatePath("/cafe\u0301/file")).toBe("/c/file");
	});

	it("preserves the leading dot + first grapheme on unicode dotfiles", () => {
		expect(abbreviatePath("/home/.café/file")).toBe("/h/.c/file");
	});

	it("handles a '.' segment literally (two dots remain two dots)", () => {
		// Spec doesn't call this out explicitly, but segments starting with '.'
		// keep their leading dot. A segment that is literally ".." is a segment
		// starting with '.' whose second grapheme is also '.', so it stays "..".
		expect(abbreviatePath("/foo/../bar")).toBe("/f/../bar");
	});
});
