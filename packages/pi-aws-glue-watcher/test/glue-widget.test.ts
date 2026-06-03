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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake TUI stub that records requestRender() calls.
 */
function makeTui() {
	const requestRender = vi.fn();
	return { tui: { requestRender }, requestRender };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GlueWidget — _registered flag prevents repeated setWidget calls (#0002 + #0008)", () => {
	it("calls setWidget once when first shown with watches, not again on subsequent refresh()", () => {
		const events = makeEventBus();
		const watches: WatchMap = { w1: makeWatch() };
		const widget = new GlueWidget({ events } as never, () => watches, () => 60_000);

		const { ctx, setWidget } = makeCtx();
		const { tui, requestRender } = makeTui();

		widget.show(ctx);
		const callsAfterShow = setWidget.mock.calls.length;
		expect(callsAfterShow).toBe(1);

		// Simulate a state-change event (as emitted after glue_watcher add / poll)
		events.emit();
		// refresh() must NOT call setWidget() again when already registered
		expect(setWidget.mock.calls.length).toBe(1);

		// But requestRender() should be called so elapsed-time labels stay current.
		// First we need to give the widget the tui reference by re-invoking the
		// factory (simulating what pi does when it creates the component).
		const factory = setWidget.mock.calls[0]![1] as (tui: unknown, theme: unknown) => unknown;
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		factory(tui, theme); // pi calls this — widget stores _tui
		setWidget.mockClear();
		requestRender.mockClear();

		// Now emit another change
		events.emit();
		expect(setWidget).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledOnce();

		widget.destroy();
	});

	it("registers widget immediately when refresh() is called after first watch is added", () => {
		const events = makeEventBus();
		const watches: WatchMap = {}; // start empty
		const widget = new GlueWidget({ events } as never, () => watches, () => 60_000);

		const { ctx, setWidget } = makeCtx();

		// session_start with no watches → widget hides
		widget.show(ctx);
		// setWidget called with undefined (hide)
		expect(setWidget).toHaveBeenCalledWith("glue-watcher", undefined);
		setWidget.mockClear();

		// User adds a watch, glue:change is emitted
		watches["w1"] = makeWatch();
		events.emit(); // triggers refresh() → show() because !_registered

		// Widget must be registered immediately — setWidget called with a factory
		const registration = setWidget.mock.calls.find(
			(c) => c[0] === "glue-watcher" && typeof c[1] === "function",
		);
		expect(registration).toBeDefined();

		// A second glue:change must NOT re-register
		setWidget.mockClear();
		events.emit();
		expect(setWidget).not.toHaveBeenCalled();

		widget.destroy();
	});

	it("clears _registered on hide() so a subsequent show() re-registers", () => {
		const events = makeEventBus();
		const watches: WatchMap = { w1: makeWatch() };
		const widget = new GlueWidget({ events } as never, () => watches, () => 60_000);

		const { ctx, setWidget } = makeCtx();

		widget.show(ctx); // registers
		expect(setWidget.mock.calls.filter((c) => typeof c[1] === "function")).toHaveLength(1);

		widget.hide(ctx); // un-registers
		setWidget.mockClear();

		widget.show(ctx); // must re-register
		expect(setWidget.mock.calls.find((c) => typeof c[1] === "function")).toBeDefined();

		widget.destroy();
	});
});

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
