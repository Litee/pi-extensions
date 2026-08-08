/**
 * Contract test for the continual-learning skill markdown.
 *
 * Guards the three memory-updater contracts ported from Cursor's
 * `continual-learning` plugin (agents-memory-updater.md @ ac93d26):
 * create-with-only-these-sections, explicit semantic dedup, 12-bullet cap.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SKILL_PATH = new URL("../skills/continual-learning/SKILL.md", import.meta.url);

function skillText(): string {
	// Collapse whitespace so assertions are immune to markdown line wrapping.
	return readFileSync(SKILL_PATH, "utf8").replace(/\s+/g, " ");
}

describe("continual-learning SKILL.md contract", () => {
	it("caps each learned section at 12 bullets", () => {
		expect(skillText()).toContain("at most 12 bullets");
	});

	it("deduplicates semantically similar bullets", () => {
		expect(skillText()).toContain("deduplicate semantically similar bullets");
	});

	it("creates AGENTS.md with only the two learned sections when absent", () => {
		expect(skillText()).toContain(
			"If `AGENTS.md` does not exist, create it with **only** these two sections (no other content)",
		);
	});
});
