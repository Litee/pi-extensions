import { describe, expect, it, vi } from "vitest";

// Mock pi-tui Text and Container so we don't need actual TUI runtime in tests
vi.mock("@earendil-works/pi-tui", () => ({
	Text: class {
		constructor(
			public content: string,
			public _l: number,
			public _r: number,
		) {}
		render(_width: number): string[] {
			return this.content ? [this.content] : [];
		}
	},
	Container: class {
		render(_width: number): string[] { return []; }
	},
}));

import { renderCall, renderResult } from "../src/render.js";


function fakeTheme() {
	return {
		fg: (_role: string, s: string): string => s,
		bold: (s: string): string => s,
	} as unknown as Parameters<typeof renderResult>[2];
}

function renderRes(result: unknown, isPartial = false): string {
	const comp = renderResult(
		result as Parameters<typeof renderResult>[0],
		{ expanded: true, isPartial },
		fakeTheme(),
		{} as Parameters<typeof renderResult>[3],
	);
	const lines = (comp as { render(_w: number): string[] }).render(1000);
	return lines.join("\n");
}

function renderC(args: { voice?: string; lang?: string; text?: string }): string {
	const comp = renderCall(args as unknown as Parameters<typeof renderCall>[0], fakeTheme());
	const lines = (comp as { render(_w: number): string[] }).render(1000);
	return lines.join("\n");
}

describe("renderCall", () => {
	it("shows voice/lang tag on first line and text on second line", () => {
		const text = renderC({ voice: "F3", lang: "ko", text: "Hello" });
		expect(text).toContain("[F3/ko]");
		expect(text).toContain("Hello");
	});

	it("defaults to M1/en when args are missing", () => {
		const text = renderC({});
		expect(text).toContain("[M1/en]");
	});

	it("does not truncate text longer than 70 chars", () => {
		const long = "x".repeat(100);
		const text = renderC({ text: long });
		expect(text).not.toContain("…");
		expect(text).toContain("x".repeat(100));
	});

	it("includes 'speak' label", () => {
		const text = renderC({ voice: "M1", lang: "en", text: "hi" });
		expect(text).toContain("speak");
	});
});

describe("renderResult — ok (queued)", () => {
	it("renders nothing (empty container) on success", () => {
		const text = renderRes({ details: { ok: true, voice: "M2", lang: "ja", text: "hi" } });
		expect(text).toBe("");
	});

	it("renders nothing regardless of queuePosition", () => {
		const text = renderRes({ details: { ok: true, voice: "M1", lang: "en", text: "hi", queuePosition: 1 } });
		expect(text).toBe("");
	});

	it("does not show '#' when queuePosition is absent", () => {
		const text = renderRes({ details: { ok: true, voice: "M1", lang: "en", text: "hi" } });
		expect(text).not.toContain("#");
	});

	it("does not include elapsed or time", () => {
		const text = renderRes({ details: { ok: true, voice: "M1", lang: "en", text: "hi", queuePosition: 2 } });
		expect(text).not.toContain("s");
		expect(text).not.toContain("done");
	});
});

describe("renderResult — error", () => {
	it("shows ✗ and error message, not the text", () => {
		const text = renderRes({ details: { ok: false, voice: "M1", lang: "en", text: "hi", message: "timed out after 60s" } });
		expect(text).toContain("✗");
		expect(text).toContain("timed out after 60s");
		expect(text).not.toContain('"hi"');
	});

	it("falls back to 'failed' when message is missing", () => {
		const text = renderRes({ details: { ok: false, voice: "M1", lang: "en", text: "hi" } });
		expect(text).toContain("✗");
		expect(text).toContain("failed");
	});
});

describe("renderResult — no details", () => {
	it("renders nothing (empty container) when details is missing", () => {
		const text = renderRes({});
		expect(text).toBe("");
	});
});
