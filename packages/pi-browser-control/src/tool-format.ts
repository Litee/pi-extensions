/**
 * Pure formatting helpers for browser tool results.
 *
 * Extracted verbatim from the old index.ts and kept as a separate module
 * so they can be tested independently.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Slim tab shape returned by `listTabs` — 9 key fields, no large data URIs. */
export interface SlimBrowserTab {
	id?: number;
	windowId?: number;
	url?: string;
	normalizedUrl: string | null;
	title?: string;
	lastAccessed?: number;
	active?: boolean;
	pinned?: boolean;
	discarded?: boolean;
}

/** Full 19-field tab shape returned by `exportTabs` — for export use only. */
export interface FullBrowserTab {
	id?: number;
	windowId?: number;
	index?: number;
	url?: string;
	normalizedUrl: string | null;
	title?: string;
	favIconUrl?: string | null;
	status?: string;
	active?: boolean;
	pinned?: boolean;
	hidden?: boolean;
	discarded?: boolean;
	incognito?: boolean;
	audible?: boolean;
	mutedInfo?: { muted: boolean; reason: string | null } | null;
	isArticle?: boolean;
	isInReaderMode?: boolean;
	lastAccessed?: number;
	cookieStoreId?: string | null;
}

/** @deprecated Use SlimBrowserTab for listTabs or FullBrowserTab for exportTabs. */
export type BrowserTab = SlimBrowserTab;

export interface TabLink {
	url: string;
	text: string;
}

export interface TabContentData {
	tabId: number;
	fullText: string;
	totalLength: number;
	isTruncated: boolean;
	/** Links are only present in the first response (offset=0). */
	links?: TabLink[];
}

// ---------------------------------------------------------------------------
// fromNow — relative time string
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable relative time string for a millisecond timestamp,
 * mirroring dayjs relativeTime plugin output without the dependency.
 */
export function fromNow(ms: number): string {
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 45) return "a few seconds ago";
	if (s < 90) return "a minute ago";
	const m = Math.round(s / 60);
	if (m < 45) return `${m} minutes ago`;
	if (m < 90) return "an hour ago";
	const h = Math.round(m / 60);
	if (h < 22) return `${h} hours ago`;
	if (h < 36) return "a day ago";
	const d = Math.round(h / 24);
	if (d < 26) return `${d} days ago`;
	if (d < 46) return "a month ago";
	const mo = Math.round(d / 30);
	if (mo < 11) return `${mo} months ago`;
	if (mo < 18) return "a year ago";
	return `${Math.round(mo / 12)} years ago`;
}

// ---------------------------------------------------------------------------
// Tab line formatter
// ---------------------------------------------------------------------------

export function formatTabLine(tab: SlimBrowserTab): string {
	let lastAccessed = "unknown";
	if (tab.lastAccessed !== undefined) {
		lastAccessed = fromNow(tab.lastAccessed);
	}
	const normalizedUrl = tab.normalizedUrl ?? null;
	return `tab id=${tab.id ?? "?"}, tab url=${tab.url ?? ""}, tab title=${tab.title ?? ""}, last accessed=${lastAccessed}, normalized url=${normalizedUrl ?? "null"}`;
}

// ---------------------------------------------------------------------------
// buildListTabsResult
// ---------------------------------------------------------------------------

export function buildListTabsResult(
	tabs: SlimBrowserTab[],
): { content: { type: "text"; text: string }[] } {
	const header: { type: "text"; text: string } = {
		type: "text",
		text: `${tabs.length} tab${tabs.length === 1 ? "" : "s"} open`,
	};
	const lines = tabs.map((tab) => ({
		type: "text" as const,
		text: formatTabLine(tab),
	}));
	return { content: [header, ...lines] };
}

// ---------------------------------------------------------------------------
// buildTabContentResult
// ---------------------------------------------------------------------------

export function buildTabContentResult(
	data: TabContentData,
	offset: number,
): { content: { type: "text"; text: string }[] } {
	const hint: { type: "text"; text: string }[] =
		data.isTruncated || offset > 0
			? [
					{
						type: "text",
						text:
							`The following text content is truncated due to size (includes character range ${offset}-${
								offset + data.fullText.length
							} out of ${data.totalLength}). ` +
							"If you want to read characters beyond this range, please use the 'browser_control' tool with operation: \"get_tab_content\" and an offset.",
					},
				]
			: [];

	const links: { type: "text"; text: string }[] =
		offset === 0 && data.links
			? data.links.map((link) => ({
					type: "text" as const,
					text: `Link text: ${link.text}, Link URL: ${link.url}`,
				}))
			: [];

	return { content: [...hint, { type: "text", text: data.fullText }, ...links] };
}
