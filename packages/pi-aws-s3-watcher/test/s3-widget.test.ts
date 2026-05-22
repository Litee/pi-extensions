import { describe, expect, it, vi } from "vitest";

import { S3Widget } from "../src/ui/s3-widget.js";
import type { S3Watch, WatchMap } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock of `pi.events` that records "s3:change" listeners so a test can
 * synchronously fire the same event the poll loop would emit.
 */
function makeEventBus() {
	const listeners: Array<() => void> = [];
	return {
		on: (event: string, fn: () => void) => {
			if (event !== "s3:change") return () => {};
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
		ctx: {
			ui: {
				setWidget,
				theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			},
		},
		setWidget,
	};
}

function makeActiveWatch(): S3Watch {
	return {
		watchId: "w1",
		bucket: "b",
		key: "k",
		profile: "p",
		region: undefined,
		target: "exists",
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: { exists: false },
		terminal: false,
		consecutiveErrors: 0,
	};
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("S3Widget lifecycle — hide() must prevent later re-show on s3:change", () => {
	it("does not re-register the widget when an s3:change event arrives after hide()", () => {
		const events = makeEventBus();
		const watches: WatchMap = { w1: makeActiveWatch() };
		const widget = new S3Widget({ events } as never, () => watches, () => 60_000);

		const { ctx, setWidget } = makeCtx();
		widget.show(ctx);

		// Sanity: show() registered the widget at least once.
		const initialRegistrations = setWidget.mock.calls.filter(
			(c) => c[0] === "s3-watcher" && c[1] !== undefined,
		).length;
		expect(initialRegistrations).toBeGreaterThan(0);

		widget.hide(ctx);

		// Hide must clear the widget exactly once.
		const clears = setWidget.mock.calls.filter(
			(c) => c[0] === "s3-watcher" && c[1] === undefined,
		).length;
		expect(clears).toBeGreaterThan(0);

		setWidget.mockClear();

		// A subsequent s3:change (poll cycle) must NOT cause the panel to
		// reappear — toggling away from widget mode disposed it.
		events.emit();

		const reRegistrations = setWidget.mock.calls.filter(
			(c) => c[0] === "s3-watcher" && c[1] !== undefined,
		).length;
		expect(reRegistrations).toBe(0);

		widget.destroy();
	});
});

describe("S3Widget show() — all watches terminal", () => {
	it("still calls setWidget (not hide) when every watch is terminal", () => {
		const events = makeEventBus();
		const terminalWatch: S3Watch = {
			...makeActiveWatch(),
			terminal: true,
		};
		const watches: WatchMap = { w1: terminalWatch };
		const widget = new S3Widget({ events } as never, () => watches, () => 60_000);

		const { ctx, setWidget } = makeCtx();
		widget.show(ctx);

		// setWidget should have been called with a factory fn, not undefined
		const registrations = setWidget.mock.calls.filter(
			(c) => c[0] === "s3-watcher" && typeof c[1] === "function",
		);
		expect(registrations.length).toBeGreaterThan(0);

		// should NOT have called hide (setWidget with undefined)
		const hides = setWidget.mock.calls.filter(
			(c) => c[0] === "s3-watcher" && c[1] === undefined,
		);
		expect(hides.length).toBe(0);

		widget.destroy();
	});
});

describe("S3Widget header — AWS prefix in title", () => {
	it("renders 'AWS S3 Watcher' in the widget header", () => {
		const events = makeEventBus();
		const watches: WatchMap = { w1: makeActiveWatch() };
		const widget = new S3Widget({ events } as never, () => watches, () => 60_000);

		const { ctx, setWidget } = makeCtx();
		widget.show(ctx);

		const registration = setWidget.mock.calls.find(
			(c) => c[0] === "s3-watcher" && typeof c[1] === "function",
		);
		expect(registration).toBeDefined();
		const factory = registration![1] as (
			tui: unknown,
			theme: unknown,
		) => { render: (w: number) => string[] };
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		const rendered = factory(undefined, theme).render(120).join("\n");
		expect(rendered).toContain("AWS S3 Watcher");

		widget.destroy();
	});
});
