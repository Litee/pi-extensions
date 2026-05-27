/**
 * Snapshot test for the extracted recap prompt template. Pinning the full
 * prompt surface area means any drift in wording has to be acknowledged
 * explicitly via `--update-snapshots`.
 */

import { describe, expect, it } from "vitest";

import { buildRecapPrompt, RECAP_SYSTEM_PROMPT } from "../src/prompt.js";

describe("buildRecapPrompt", () => {
	it("matches the recorded snapshot for a canonical transcript", () => {
		const transcript = "User: add a Skip rule.\nAssistant: done.";
		expect(buildRecapPrompt(transcript)).toMatchSnapshot();
	});

	it("truncates the embedded transcript at 12000 characters", () => {
		const huge = "x".repeat(20000);
		const prompt = buildRecapPrompt(huge);
		// Our rule-body text is finite and bounded; prompt length minus the
		// 12000-char transcript slice must still be a sensible, small number.
		expect(prompt.length).toBeLessThan(20000);
		expect(prompt).toContain("x".repeat(12000));
		expect(prompt.includes("x".repeat(12001))).toBe(false);
	});
});

describe("RECAP_SYSTEM_PROMPT", () => {
	it("is a non-empty string (openai-codex-responses rejects empty top-level instructions)", () => {
		expect(typeof RECAP_SYSTEM_PROMPT).toBe("string");
		expect(RECAP_SYSTEM_PROMPT.length).toBeGreaterThan(0);
	});
});
