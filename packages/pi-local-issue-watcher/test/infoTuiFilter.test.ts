/**
 * Pure-unit tests for `filterItemsBySubstring` — the case-insensitive
 * substring filter lifted out of `infoTui.ts`'s SelectList override.
 */

import { describe, expect, it } from "vitest";

import { filterItemsBySubstring } from "../src/infoTuiFilter.js";

interface Item {
	value: string;
	label: string;
}

const items: readonly Item[] = [
	{ value: "/a/b/c/0001.json", label: "my-skill #0001 — First issue" },
	{ value: "/a/b/c/0002.json", label: "my-skill #0002 — Second THING" },
	{ value: "/a/b/c/0003.json", label: "other-skill #0003 — Third" },
];

const getLabel = (it: Item): string => it.label;

describe("filterItemsBySubstring", () => {
	it("returns all items unchanged for empty needle", () => {
		expect(filterItemsBySubstring(items, "", getLabel)).toEqual(items);
	});

	it.each([
		["first", ["/a/b/c/0001.json"], "substring match"],
		["FIRST", ["/a/b/c/0001.json"], "case-insensitive match"],
		["thing", ["/a/b/c/0002.json"], "case-insensitive vs uppercase label"],
		["skill", items.map((i) => i.value), "matches all"],
		["other-skill", ["/a/b/c/0003.json"], "match on prefix subword"],
		["#0002", ["/a/b/c/0002.json"], "match includes punctuation"],
		["zzz-nope", [], "no match returns empty"],
	])("needle %j → %j (%s)", (needle, expected) => {
		const out = filterItemsBySubstring(items, needle, getLabel);
		expect(out.map((i) => i.value)).toEqual(expected);
	});

	it("does NOT match against the value (only getText output)", () => {
		// Needle appears in .value but never in the label; current bug
		// fix point is "don't match the path".
		expect(
			filterItemsBySubstring(items, "0001.json", getLabel).map((i) => i.value),
		).toEqual([]);
	});

	it("preserves original order", () => {
		const out = filterItemsBySubstring(items, "skill", getLabel);
		expect(out).toEqual(items);
	});

	it("works on an empty input array", () => {
		expect(filterItemsBySubstring([], "anything", getLabel)).toEqual([]);
	});
});
