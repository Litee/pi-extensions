import { describe, expect, it, vi } from "vitest";
import createExtension from "../src/index.js";

function makeFakePi() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const on = vi.fn((evt: string, fn: (...a: unknown[]) => unknown) => {
		handlers.set(evt, fn);
	});
	return { on, handlers };
}

describe("pi-additional-system-prompt — wiring", () => {
	it("subscribes to before_agent_start", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect(pi.handlers.has("before_agent_start")).toBe(true);
	});

	it("appends GUIDELINES to an empty system prompt", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const handler = pi.handlers.get("before_agent_start")!;
		const result = (await handler({ systemPrompt: "" }, {})) as { systemPrompt: string };
		expect(result.systemPrompt.length).toBeGreaterThan(0);
	});
});

const SENTINEL = "<!-- pi-additional-system-prompt -->";

describe("pi-additional-system-prompt — dedup", () => {
	it("does not duplicate GUIDELINES when sentinel already present in the prompt", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const handler = pi.handlers.get("before_agent_start")!;

		// Simulate a prompt that already has the sentinel injected
		const alreadyInjected = `existing\n${SENTINEL}\n...guidelines here...`;
		const result = (await handler({ systemPrompt: alreadyInjected }, {})) as { systemPrompt: string };

		// Must be returned unchanged
		expect(result.systemPrompt).toBe(alreadyInjected);
	});

	it("still appends GUIDELINES when the prompt does not contain the sentinel", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const handler = pi.handlers.get("before_agent_start")!;

		const base = "Some unrelated system prompt content.";
		const result = (await handler({ systemPrompt: base }, {})) as { systemPrompt: string };

		expect(result.systemPrompt.startsWith(base)).toBe(true);
		expect(result.systemPrompt).toContain(SENTINEL);
		expect(result.systemPrompt.length).toBeGreaterThan(base.length);
	});
});
