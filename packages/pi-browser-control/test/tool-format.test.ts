/**
 * Tests for src/tool-format.ts
 * Pure formatting functions extracted from the old index.ts.
 */

import { describe, it, expect } from "vitest";

import {
	fromNow,
	formatTabLine,
	buildListTabsResult,
	buildTabContentResult,
	type SlimBrowserTab,
	type TabContentData,
} from "../src/tool-format.js";

// ---------------------------------------------------------------------------
// fromNow
// ---------------------------------------------------------------------------

describe("fromNow", () => {
	const now = Date.now();

	it("a few seconds ago", () => {
		expect(fromNow(now - 10_000)).toMatch(/seconds ago/);
	});
	it("a minute ago", () => {
		expect(fromNow(now - 65_000)).toMatch(/minute ago/);
	});
	it("minutes ago", () => {
		expect(fromNow(now - 10 * 60_000)).toMatch(/minutes ago/);
	});
	it("an hour ago", () => {
		expect(fromNow(now - 70 * 60_000)).toMatch(/hour ago/);
	});
	it("hours ago", () => {
		expect(fromNow(now - 5 * 3_600_000)).toMatch(/hours ago/);
	});
	it("a day ago", () => {
		expect(fromNow(now - 30 * 3_600_000)).toMatch(/day ago/);
	});
	it("days ago", () => {
		expect(fromNow(now - 5 * 86_400_000)).toMatch(/days ago/);
	});
	it("a month ago", () => {
		expect(fromNow(now - 36 * 86_400_000)).toMatch(/month ago/);
	});
	it("months ago", () => {
		expect(fromNow(now - 60 * 86_400_000)).toMatch(/months ago/);
	});
	it("a year ago", () => {
		expect(fromNow(now - 400 * 86_400_000)).toMatch(/year ago/);
	});
	it("years ago", () => {
		expect(fromNow(now - 800 * 86_400_000)).toMatch(/years ago/);
	});
});

// ---------------------------------------------------------------------------
// formatTabLine
// ---------------------------------------------------------------------------

describe("formatTabLine", () => {
	it("formats a tab with all fields", () => {
		const tab: SlimBrowserTab = {
			id: 5,
			url: "https://example.com",
			title: "Example",
			lastAccessed: Date.now() - 5_000,
			normalizedUrl: "https://example.com/",
		};
		const line = formatTabLine(tab);
		expect(line).toContain("tab id=5");
		expect(line).toContain("tab url=https://example.com");
		expect(line).toContain("tab title=Example");
		expect(line).toContain("last accessed=");
		expect(line).toContain("normalized url=https://example.com/");
	});

	it("shows 'unknown' when lastAccessed is absent", () => {
		const tab: SlimBrowserTab = { id: 1, url: "https://x.com", title: "X", normalizedUrl: "https://x.com/" };
		expect(formatTabLine(tab)).toContain("last accessed=unknown");
	});
});

// ---------------------------------------------------------------------------
// buildListTabsResult
// ---------------------------------------------------------------------------

const SAMPLE_TABS: SlimBrowserTab[] = [
	{ id: 1, url: "https://a.com", title: "A", lastAccessed: Date.now() - 60_000, normalizedUrl: "https://a.com/" },
	{ id: 2, url: "https://b.com", title: "B", lastAccessed: Date.now() - 3_600_000, normalizedUrl: "https://b.com/" },
	{ id: 3, url: "https://c.com", title: "C", normalizedUrl: "https://c.com/" },
];

describe("buildListTabsResult", () => {
	it("returns a pagination header + one line per tab", () => {
		const { content } = buildListTabsResult(SAMPLE_TABS, 0, 100);
		const texts = content.map((c) => c.text);
		expect(texts[0]).toMatch(/Showing tabs 1-3 of 3/);
		expect(texts[1]).toMatch(/tab id=1/);
		expect(texts[2]).toMatch(/tab id=2/);
		expect(texts[3]).toMatch(/tab id=3/);
	});

	it("applies offset pagination", () => {
		const { content } = buildListTabsResult(SAMPLE_TABS, 1, 1);
		const texts = content.map((c) => c.text);
		expect(texts[0]).toMatch(/Showing tabs 2-2 of 3/);
		expect(texts[0]).toMatch(/offset=2/);
		expect(content).toHaveLength(2);
		expect(texts[1]).toMatch(/tab id=2/);
	});

	it("caps limit to 500", () => {
		const many: SlimBrowserTab[] = Array.from({ length: 600 }, (_, i) => ({
			id: i,
			url: `https://t${i}.com`,
			title: `T${i}`,
			normalizedUrl: `https://t${i}.com/`,
		}));
		const { content } = buildListTabsResult(many, 0, 9999);
		expect(content).toHaveLength(501); // header + 500 tabs
	});

	it("clamps limit minimum to 1", () => {
		const { content } = buildListTabsResult(SAMPLE_TABS, 0, -1);
		expect(content).toHaveLength(2); // header + 1 tab
	});

	it("includes 'use offset=N to see more' hint when there are more", () => {
		const { content } = buildListTabsResult(SAMPLE_TABS, 0, 1);
		expect(content[0]!.text).toMatch(/offset=1/);
	});

	it("does not include 'more' hint when all tabs fit", () => {
		const { content } = buildListTabsResult(SAMPLE_TABS, 0, 100);
		expect(content[0]!.text).not.toMatch(/offset=/);
	});
});

// ---------------------------------------------------------------------------
// buildTabContentResult
// ---------------------------------------------------------------------------

describe("buildTabContentResult", () => {
	it("returns text without truncation hint when not truncated + offset=0", () => {
		const data: TabContentData = {
			tabId: 1,
			fullText: "Page content",
			totalLength: 12,
			isTruncated: false,
			links: [],
		};
		const { content } = buildTabContentResult(data, 0);
		const texts = content.map((c) => c.text);
		expect(texts.some((t) => t.includes("truncated"))).toBe(false);
		expect(texts).toContainEqual("Page content");
	});

	it("shows truncation hint when isTruncated=true at offset=0", () => {
		const data: TabContentData = {
			tabId: 1,
			fullText: "Short excerpt",
			totalLength: 50_000,
			isTruncated: true,
			links: [],
		};
		const { content } = buildTabContentResult(data, 0);
		const texts = content.map((c) => c.text);
		expect(texts.some((t) => t.includes("truncated"))).toBe(true);
		expect(texts.some((t) => t.includes("50000"))).toBe(true);
	});

	it("shows truncation hint when offset>0", () => {
		const data: TabContentData = {
			tabId: 1,
			fullText: "More content",
			totalLength: 1000,
			isTruncated: false,
		};
		const { content } = buildTabContentResult(data, 100);
		const texts = content.map((c) => c.text);
		expect(texts.some((t) => t.includes("truncated"))).toBe(true);
	});

	it("includes links at offset=0", () => {
		const data: TabContentData = {
			tabId: 1,
			fullText: "Page",
			totalLength: 4,
			isTruncated: false,
			links: [{ text: "Go here", url: "https://go.here" }],
		};
		const { content } = buildTabContentResult(data, 0);
		const texts = content.map((c) => c.text);
		expect(texts.some((t) => t.includes("Link text: Go here") && t.includes("https://go.here"))).toBe(true);
	});

	it("excludes links when offset>0", () => {
		const data: TabContentData = {
			tabId: 1,
			fullText: "More",
			totalLength: 1000,
			isTruncated: false,
			links: [{ text: "A link", url: "https://a.com" }],
		};
		const { content } = buildTabContentResult(data, 100);
		const texts = content.map((c) => c.text);
		expect(texts.some((t) => t.includes("Link text:"))).toBe(false);
	});

	it("excludes links when data.links is absent (undefined)", () => {
		const data: TabContentData = {
			tabId: 1,
			fullText: "Page",
			totalLength: 4,
			isTruncated: false,
		};
		const { content } = buildTabContentResult(data, 0);
		const texts = content.map((c) => c.text);
		expect(texts.some((t) => t.includes("Link text:"))).toBe(false);
	});
});
