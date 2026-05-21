import { describe, expect, it, vi } from "vitest";

import { GlueWidget } from "../src/ui/glue-widget.js";
import type { GlueWatch, WatchMap } from "../src/types.js";

function makeEventBus() {
	const listeners: Array<() => void> = [];
	return {
		on: (event: string, fn: () => void) => {
			if (event !== "glue:change") return () => {};
			listeners.push(fn);
			return () => {
				const i = listeners.indexOf(fn);
				if (i >= 0) listeners.splice(i, 1);
			};
		},
		emit: () => {
			for (const fn of listeners.slice()) fn();
		},
	};
}

function makeCtx() {
	const setWidget = vi.fn();
	return {
		ctx: { ui: { setWidget } },
		setWidget,
	};
}

function makeWatch(): GlueWatch {
	return {
		watchId: "w1",
		type: "job",
		name: "j",
		runId: "jr",
		profile: "p",
		region: undefined,
		addedAt: 1,
		lastPolledAt: undefined,
		baseline: { state: "RUNNING", errorMessage: "" },
		terminal: false,
		consecutiveErrors: 0,
	};
}

describe("GlueWidget header — AWS prefix in title", () => {
	it("renders 'AWS Glue Watcher' in the widget header", () => {
		const events = makeEventBus();
		const watches: WatchMap = { w1: makeWatch() };
		const widget = new GlueWidget({ events } as never, () => watches, () => 60_000);

		const { ctx, setWidget } = makeCtx();
		widget.show(ctx);

		const registration = setWidget.mock.calls.find(
			(c) => c[0] === "glue-watcher" && typeof c[1] === "function",
		);
		expect(registration).toBeDefined();
		const factory = registration![1] as (
			tui: unknown,
			theme: unknown,
		) => { render: (w: number) => string[] };
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		const rendered = factory(undefined, theme).render(120).join("\n");
		expect(rendered).toContain("AWS Glue Watcher");

		widget.destroy();
	});
});
