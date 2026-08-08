import { describe, expect, it, vi } from "vitest";

import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventManager } from "./events.js";

vi.mock("./settings.js", () => ({
	settings: {
		getConfig: () => ({}),
	},
}));

function createManager(): {
	manager: EventManager;
	engine: {
		stop: ReturnType<typeof vi.fn>;
		reconcileTotal: ReturnType<typeof vi.fn>;
	};
	renderer: { update: ReturnType<typeof vi.fn> };
	ctx: ExtensionContext;
} {
	const engine = {
		stop: vi.fn(),
		reconcileTotal: vi.fn(),
	};
	const renderer = { update: vi.fn() };
	const manager = new EventManager(engine as never, renderer as never);
	const ctx = {} as ExtensionContext;
	return { manager, engine, renderer, ctx };
}

describe("EventManager.handleAgentEnd", () => {
	it("sums usage.output across messages with valid usage", () => {
		const { manager, engine, renderer, ctx } = createManager();
		const event = {
			type: "agent_end",
			messages: [
				{ role: "assistant", usage: { output: 10 } },
				{ role: "assistant", usage: { output: 5 } },
			],
		} as unknown as AgentEndEvent;

		manager.handleAgentEnd(event, ctx);

		expect(engine.stop).toHaveBeenCalled();
		expect(engine.reconcileTotal).toHaveBeenCalledWith(15);
		expect(renderer.update).toHaveBeenCalledWith(ctx);
	});

	it("does not crash when usage key is present but value is undefined", () => {
		const { manager, engine, renderer, ctx } = createManager();
		const event = {
			type: "agent_end",
			messages: [
				{ role: "assistant", usage: undefined },
				{ role: "assistant", usage: { output: 3 } },
			],
		} as unknown as AgentEndEvent;

		manager.handleAgentEnd(event, ctx);

		expect(engine.stop).toHaveBeenCalled();
		expect(engine.reconcileTotal).toHaveBeenCalledWith(3);
		expect(renderer.update).toHaveBeenCalledWith(ctx);
	});

	it("does not crash when usage is absent", () => {
		const { manager, engine, renderer, ctx } = createManager();
		const event = {
			type: "agent_end",
			messages: [{ role: "assistant" }],
		} as unknown as AgentEndEvent;

		manager.handleAgentEnd(event, ctx);

		expect(engine.stop).toHaveBeenCalled();
		expect(engine.reconcileTotal).toHaveBeenCalledWith(0);
		expect(renderer.update).toHaveBeenCalledWith(ctx);
	});

	it("does not crash on an empty messages array", () => {
		const { manager, engine, renderer, ctx } = createManager();
		const event = {
			type: "agent_end",
			messages: [],
		} as unknown as AgentEndEvent;

		manager.handleAgentEnd(event, ctx);

		expect(engine.stop).toHaveBeenCalled();
		expect(engine.reconcileTotal).toHaveBeenCalledWith(0);
		expect(renderer.update).toHaveBeenCalledWith(ctx);
	});

	it("ignores messages without output in usage", () => {
		const { manager, engine, renderer, ctx } = createManager();
		const event = {
			type: "agent_end",
			messages: [
				{ role: "assistant", usage: { input: 7, output: undefined } },
				{ role: "assistant", usage: { output: 2 } },
			],
		} as unknown as AgentEndEvent;

		manager.handleAgentEnd(event, ctx);

		expect(engine.stop).toHaveBeenCalled();
		expect(engine.reconcileTotal).toHaveBeenCalledWith(2);
		expect(renderer.update).toHaveBeenCalledWith(ctx);
	});
});
