import { describe, expect, it, vi } from "vitest";

// Mock pi-tui Text so we don't need actual TUI runtime in tests
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

describe("renderResult — partial (isPartial: true)", () => {
	const baseDetails = { ok: true, voice: "M1", lang: "en", text: "hello" };

	it("shows ⏱ and elapsed, not the text or 'speaking'", () => {
		const text = renderRes({ details: { ...baseDetails, elapsed: 5 } }, true);
		expect(text).toContain("⏱");
		expect(text).toContain("5s");
		expect(text).not.toContain("/ ");
		expect(text).not.toContain("speaking");
		expect(text).not.toContain('"hello"');
	});

	it("shows 0s when elapsed is missing", () => {
		const text = renderRes({ details: baseDetails }, true);
		expect(text).toContain("⏱");
		expect(text).toContain("0s");
		expect(text).not.toContain("/ ");
	});
});

describe("renderResult — final ok", () => {
	it("shows ✓ and time in seconds, not the text", () => {
		const text = renderRes({ details: { ok: true, voice: "M2", lang: "ja", text: "hi", ms: 3200 } });
		expect(text).toContain("✓");
		expect(text).toContain("3.2s");
		expect(text).not.toContain('"hi"');
	});

	it("shows ✓ done when ms is missing", () => {
		const text = renderRes({ details: { ok: true, voice: "M1", lang: "en", text: "hi" } });
		expect(text).toContain("✓");
		expect(text).toContain("done");
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
	it("returns 🔊 fallback when details is missing", () => {
		const text = renderRes({});
		expect(text).toContain("🔊");
	});
});
