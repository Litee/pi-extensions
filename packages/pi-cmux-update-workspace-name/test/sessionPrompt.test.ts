import { describe, expect, it } from "vitest";

import {
	buildSessionRenamePrompt,
	collectUserPrompts,
	extractText,
	getBranchSafely,
	MAX_PROMPT_CHARS,
	MAX_USER_MESSAGES,
} from "../src/sessionPrompt.js";

describe("extractText", () => {
	it("returns the input when content is already a plain string", () => {
		expect(extractText("hello")).toBe("hello");
	});

	it("joins `text` parts of an array-of-blocks value", () => {
		expect(
			extractText([
				{ type: "text", text: "first line" },
				{ type: "toolCall", name: "read" },
				{ type: "text", text: "second line" },
			]),
		).toBe("first line\nsecond line");
	});

	it("returns empty string for nullish or unknown shapes", () => {
		expect(extractText(undefined)).toBe("");
		expect(extractText(null)).toBe("");
		expect(extractText({ something: "else" })).toBe("");
	});

	it("skips non-text blocks and non-object members", () => {
		expect(
			extractText([
				null,
				{ type: "text" /* no text field */ },
				{ type: "text", text: "kept" },
				"bare string",
			]),
		).toBe("kept");
	});
});

describe("collectUserPrompts", () => {
	it("returns [] when there are no user messages", () => {
		expect(collectUserPrompts([])).toEqual([]);
		expect(
			collectUserPrompts([
				{ type: "message", message: { role: "assistant", content: "hi" } },
			]),
		).toEqual([]);
	});

	it("preserves chronological order", () => {
		const out = collectUserPrompts([
			{ type: "message", message: { role: "user", content: "one" } },
			{ type: "message", message: { role: "assistant", content: "x" } },
			{ type: "message", message: { role: "user", content: "two" } },
		]);
		expect(out).toEqual(["one", "two"]);
	});

	it("skips empty and whitespace-only user messages", () => {
		expect(
			collectUserPrompts([
				{ type: "message", message: { role: "user", content: "   " } },
				{ type: "message", message: { role: "user", content: "" } },
				{ type: "message", message: { role: "user", content: "keep me" } },
			]),
		).toEqual(["keep me"]);
	});

	it("skips slash-command messages", () => {
		expect(
			collectUserPrompts([
				{ type: "message", message: { role: "user", content: "real prompt" } },
				{ type: "message", message: { role: "user", content: "/cmux-rename" } },
				{ type: "message", message: { role: "user", content: "/help" } },
			]),
		).toEqual(["real prompt"]);
	});

	it("caps at MAX_USER_MESSAGES and keeps the most recent", () => {
		const many = Array.from({ length: MAX_USER_MESSAGES + 5 }, (_, i) => ({
			type: "message",
			message: { role: "user", content: `p${i}` },
		}));
		const out = collectUserPrompts(many);
		expect(out.length).toBe(MAX_USER_MESSAGES);
		expect(out[0]).toBe(`p5`);
		expect(out[out.length - 1]).toBe(`p${MAX_USER_MESSAGES + 4}`);
	});
});

describe("buildSessionRenamePrompt", () => {
	it("returns null when there are no user messages", () => {
		expect(buildSessionRenamePrompt([])).toBeNull();
		expect(
			buildSessionRenamePrompt([
				{ type: "message", message: { role: "assistant", content: "hi" } },
			]),
		).toBeNull();
	});

	it("joins user messages with blank-line separators", () => {
		expect(
			buildSessionRenamePrompt([
				{ type: "message", message: { role: "user", content: "first" } },
				{ type: "message", message: { role: "user", content: "second" } },
			]),
		).toBe("first\n\nsecond");
	});

	it("drops oldest prompts first when the total exceeds MAX_PROMPT_CHARS", () => {
		const large = "x".repeat(MAX_PROMPT_CHARS);
		const out = buildSessionRenamePrompt([
			{ type: "message", message: { role: "user", content: "old one" } },
			{ type: "message", message: { role: "user", content: large } },
		]);
		expect(out).toBe(large);
	});

	it("truncates the final prompt when even a single message exceeds the cap", () => {
		const huge = "y".repeat(MAX_PROMPT_CHARS + 500);
		const out = buildSessionRenamePrompt([
			{ type: "message", message: { role: "user", content: huge } },
		]);
		expect(out).not.toBeNull();
		expect(out!.length).toBe(MAX_PROMPT_CHARS);
		// Keeps the tail, not the head.
		expect(out!.endsWith("y")).toBe(true);
	});
});

describe("getBranchSafely", () => {
	it("returns [] for undefined session manager", () => {
		expect(getBranchSafely(undefined)).toEqual([]);
	});

	it("prefers getBranch over getEntries when both are present", () => {
		const sm = {
			getBranch: () => [{ branch: true }],
			getEntries: () => [{ entries: true }],
		};
		expect(getBranchSafely(sm)).toEqual([{ branch: true }]);
	});

	it("falls back to getEntries when getBranch is missing", () => {
		const sm = { getEntries: () => [{ entries: true }] };
		expect(getBranchSafely(sm)).toEqual([{ entries: true }]);
	});

	it("returns [] when getBranch throws", () => {
		const sm = {
			getBranch: () => {
				throw new Error("boom");
			},
		};
		expect(getBranchSafely(sm)).toEqual([]);
	});

	it("returns [] when getBranch returns null/undefined", () => {
		expect(getBranchSafely({ getBranch: () => null })).toEqual([]);
		expect(getBranchSafely({ getBranch: () => undefined })).toEqual([]);
	});
});
