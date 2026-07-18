import { describe, expect, it } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";
import { boundedMaxTokens, AGENT_LOOP_MAX_TOKENS } from "../src/model-budget.js";

describe("boundedMaxTokens", () => {
	it("returns the requested value when model has no maxTokens", () => {
		const model = { provider: "anthropic" } as Model<Api>;
		expect(boundedMaxTokens(model)).toBe(AGENT_LOOP_MAX_TOKENS);
		expect(boundedMaxTokens(model, 16000)).toBe(16000);
	});

	it("returns the requested value when model.maxTokens is 0", () => {
		const model = { provider: "anthropic", maxTokens: 0 } as Model<Api>;
		expect(boundedMaxTokens(model)).toBe(AGENT_LOOP_MAX_TOKENS);
		expect(boundedMaxTokens(model, 16000)).toBe(16000);
	});

	it("returns the requested value when model.maxTokens is negative", () => {
		const model = { provider: "anthropic", maxTokens: -1 } as Model<Api>;
		expect(boundedMaxTokens(model)).toBe(AGENT_LOOP_MAX_TOKENS);
		expect(boundedMaxTokens(model, 16000)).toBe(16000);
	});

	it("returns the requested value when model.maxTokens is undefined", () => {
		const model = { provider: "anthropic", maxTokens: undefined } as Model<Api>;
		expect(boundedMaxTokens(model)).toBe(AGENT_LOOP_MAX_TOKENS);
		expect(boundedMaxTokens(model, 16000)).toBe(16000);
	});

	it("returns the requested value when model.maxTokens is a string", () => {
		const model = { provider: "anthropic", maxTokens: "100" } as unknown as Model<Api>;
		expect(boundedMaxTokens(model)).toBe(AGENT_LOOP_MAX_TOKENS);
	});

	it("returns model.maxTokens when it is less than requested", () => {
		const model = { provider: "anthropic", maxTokens: 8000 } as Model<Api>;
		expect(boundedMaxTokens(model)).toBe(8000);
		expect(boundedMaxTokens(model, 16000)).toBe(8000);
	});

	it("returns requested when model.maxTokens is greater than requested", () => {
		const model = { provider: "anthropic", maxTokens: 64000 } as Model<Api>;
		expect(boundedMaxTokens(model, 16000)).toBe(16000);
	});

	it("uses custom requested value with bounded model", () => {
		const model = { provider: "anthropic", maxTokens: 32000 } as Model<Api>;
		expect(boundedMaxTokens(model, 24000)).toBe(24000);
		expect(boundedMaxTokens(model, 48000)).toBe(32000);
	});
});
