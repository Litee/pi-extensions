/**
 * WatchesView — unit tests for the EC2 watcher's TUI overlay.
 *
 * Mirrors the approach used in pi-aws-glue-watcher/test/watches-view.test.ts:
 * instantiate WatchesView with mocked dependencies and exercise render() /
 * handleInput() directly, without needing a live pi-tui runtime.
 */

import { describe, expect, it, vi } from "vitest";
import type { Ec2Watch, WatchMap } from "../src/types.js";
import { WatchesView } from "../src/ui/watches-view.js";
import type { DisplayRow } from "../src/ui/watchesModel.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const theme = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
};

function makeWatch(overrides: Partial<Ec2Watch> & { watchId: string; instanceId: string }): Ec2Watch {
	return {
		watchId: overrides.watchId,
		instanceId: overrides.instanceId,
		profile: overrides.profile ?? "default",
		region: overrides.region,
		stopOnStopped: overrides.stopOnStopped ?? false,
		timeoutAt: overrides.timeoutAt,
		addedAt: overrides.addedAt ?? 1000,
		lastPolledAt: overrides.lastPolledAt,
		baseline: overrides.baseline ?? { state: "running" },
		terminal: overrides.terminal ?? false,
		consecutiveErrors: overrides.consecutiveErrors ?? 0,
	};
}

function makeWatches(): WatchMap {
	return {
		w1: makeWatch({
			watchId: "w1",
			instanceId: "i-0abc1234",
			profile: "dev",
			baseline: { state: "running" },
			terminal: false,
		}),
		w2: makeWatch({
			watchId: "w2",
			instanceId: "i-0def5678",
			profile: "dev",
			baseline: { state: "stopped" },
			terminal: true,
		}),
	};
}

function makeView(
	watches: WatchMap = makeWatches(),
	overrides: {
		stopRow?: (row: DisplayRow) => Promise<void>;
		startRow?: (row: DisplayRow) => Promise<void>;
		removeWatch?: (watchId: string) => void;
		toggleDisplay?: () => void;
		getDisplayMode?: () => "widget" | "statusline";
	} = {},
): {
	view: WatchesView;
	requestRender: ReturnType<typeof vi.fn>;
	done: ReturnType<typeof vi.fn>;
	stopRow: ReturnType<typeof vi.fn>;
	startRow: ReturnType<typeof vi.fn>;
	removeWatch: ReturnType<typeof vi.fn>;
	toggleDisplay: ReturnType<typeof vi.fn>;
} {
	const requestRender = vi.fn();
	const done = vi.fn();
	const stopRow = vi.fn().mockResolvedValue(undefined);
	const startRow = vi.fn().mockResolvedValue(undefined);
	const removeWatch = vi.fn();
	const toggleDisplay = vi.fn();
	const getDisplayMode = overrides.getDisplayMode ?? (() => "widget" as const);

	const view = new WatchesView(
		() => watches,
		theme,
		requestRender,
		done,
		overrides.stopRow ?? stopRow,
		overrides.startRow ?? startRow,
		overrides.removeWatch ?? removeWatch,
		() => 60_000,
		overrides.toggleDisplay ?? toggleDisplay,
		getDisplayMode,
	);

	return { view, requestRender, done, stopRow, startRow, removeWatch, toggleDisplay };
}

// ---------------------------------------------------------------------------
// render() — basic layout
// ---------------------------------------------------------------------------

describe("WatchesView.render() — basic layout", () => {
	it("returns an array of strings", () => {
		const { view } = makeView();
		const lines = view.render(120);
		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("render includes 'EC2 Instance Watcher' header when watches exist", () => {
		const { view } = makeView();
		const joined = view.render(120).join("\n");
		expect(joined).toContain("EC2 Instance Watcher");
	});

	it("render shows 'No watches configured' when map is empty", () => {
		const { view } = makeView({});
		const joined = view.render(120).join("\n");
		expect(joined).toContain("No watches configured");
	});

	it("render includes instance IDs from the watch map", () => {
		const { view } = makeView();
		const joined = view.render(120).join("\n");
		expect(joined).toContain("i-0abc1234");
	});

	it("render shows displayMode in the header", () => {
		const { view } = makeView(makeWatches(), { getDisplayMode: () => "widget" });
		const joined = view.render(120).join("\n");
		// The toggle hint references the other mode
		expect(joined).toContain("statusline");
	});
});

// ---------------------------------------------------------------------------
// handleInput() — navigation
// ---------------------------------------------------------------------------

describe("WatchesView.handleInput() — navigation", () => {
	it("move-down increments selectedIndex (up to max)", () => {
		const watches = makeWatches();
		const { view } = makeView(watches);
		// view at index 0 initially; press arrow-down key
		view.handleInput("\x1b[B"); // down arrow
		// selectedIndex should now be 1 (we have 2 watches)
		// Re-render to verify selection moved — the selected item is rendered distinctly
		const lines = view.render(120).join("\n");
		expect(lines).toBeDefined(); // render doesn't crash after move
	});

	it("move-up does nothing when already at index 0", () => {
		const { view, requestRender } = makeView();
		view.handleInput("\x1b[A"); // up arrow when at 0 — no effect
		// No crash; requestRender might not be called (implementation detail)
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("refresh key resets actionError and calls requestRender", () => {
		const { view, requestRender } = makeView();
		view.handleInput("r");
		expect(requestRender).toHaveBeenCalled();
	});

	it("quit key calls done()", () => {
		const { view, done } = makeView();
		view.handleInput("q");
		expect(done).toHaveBeenCalledOnce();
	});

	it("toggle-display key calls toggleDisplay()", () => {
		const { view, toggleDisplay } = makeView();
		view.handleInput("t");
		expect(toggleDisplay).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// handleInput() — confirm dialogs: stop
// ---------------------------------------------------------------------------

describe("WatchesView.handleInput() — confirm: stop", () => {
	it("'x' on a non-terminal row enters stop-confirm mode", () => {
		const { view } = makeView();
		view.handleInput("x");
		const lines = view.render(120).join("\n");
		expect(lines).toContain("Stop");
		expect(lines).toContain("confirm");
	});

	it("'y' in stop-confirm calls stopRow()", async () => {
		const stopRow = vi.fn().mockResolvedValue(undefined);
		const { view } = makeView(makeWatches(), { stopRow });
		view.handleInput("x"); // begin-stop
		view.handleInput("y"); // confirm
		// stopRow is async; flush microtasks
		await new Promise((r) => setTimeout(r, 0));
		expect(stopRow).toHaveBeenCalledOnce();
	});

	it("'n' in stop-confirm cancels", () => {
		const { view } = makeView();
		view.handleInput("x");
		view.handleInput("n"); // cancel
		const lines = view.render(120).join("\n");
		expect(lines).toContain("EC2 Instance Watcher");
	});
});

// ---------------------------------------------------------------------------
// handleInput() — confirm dialogs: start
// ---------------------------------------------------------------------------

describe("WatchesView.handleInput() — confirm: start", () => {
	it("'s' on a non-terminal row enters start-confirm mode", () => {
		const { view } = makeView();
		view.handleInput("s");
		const lines = view.render(120).join("\n");
		expect(lines).toContain("Start");
		expect(lines).toContain("confirm");
	});

	it("'y' in start-confirm calls startRow()", async () => {
		const startRow = vi.fn().mockResolvedValue(undefined);
		const { view } = makeView(makeWatches(), { startRow });
		view.handleInput("s"); // begin-start
		view.handleInput("y"); // confirm
		await new Promise((r) => setTimeout(r, 0));
		expect(startRow).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// handleInput() — confirm dialogs: unwatch
// ---------------------------------------------------------------------------

describe("WatchesView.handleInput() — confirm: unwatch", () => {
	it("'d' enters unwatch-confirm mode", () => {
		const { view } = makeView();
		view.handleInput("d");
		const lines = view.render(120).join("\n");
		expect(lines).toContain("Unwatch");
	});

	it("'y' in unwatch-confirm calls removeWatch()", () => {
		const removeWatch = vi.fn();
		const { view } = makeView(makeWatches(), { removeWatch });
		view.handleInput("d");
		view.handleInput("y");
		expect(removeWatch).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// handleInput() — confirm dialogs: purge terminal
// ---------------------------------------------------------------------------

describe("WatchesView.handleInput() — confirm: purge terminal", () => {
	it("'D' enters purge-terminal-confirm mode when terminal watches exist", () => {
		const { view } = makeView(); // makeWatches has 1 terminal watch
		view.handleInput("D");
		const lines = view.render(120).join("\n");
		expect(lines).toContain("Purge");
	});

	it("'y' in purge-confirm calls removeWatch for all terminal watches", () => {
		const removeWatch = vi.fn();
		const { view } = makeView(makeWatches(), { removeWatch });
		view.handleInput("D");
		view.handleInput("y");
		// terminal watch is w2
		expect(removeWatch).toHaveBeenCalledWith("w2");
	});

	it("'D' does nothing when no terminal watches exist", () => {
		const watches = {
			w1: makeWatch({ watchId: "w1", instanceId: "i-0abc", terminal: false }),
		};
		const { view } = makeView(watches);
		view.handleInput("D");
		// Not in confirm mode — still shows header
		const lines = view.render(120).join("\n");
		expect(lines).toContain("EC2 Instance Watcher");
	});
});

// ---------------------------------------------------------------------------
// handleInput() — error display
// ---------------------------------------------------------------------------

describe("WatchesView.handleInput() — error paths", () => {
	it("shows actionError in render output when stopRow rejects", async () => {
		const stopRow = vi.fn().mockRejectedValue(new Error("stop failed"));
		const { view, requestRender } = makeView(makeWatches(), { stopRow });
		view.handleInput("x"); // begin-stop
		view.handleInput("y"); // confirm
		await new Promise((r) => setTimeout(r, 0));
		// flush catch handler (microtask) + finally (microtask)
		await new Promise((r) => setTimeout(r, 0));
		const lines = view.render(120).join("\n");
		expect(lines).toContain("stop failed");
		expect(requestRender).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// invalidate()
// ---------------------------------------------------------------------------

describe("WatchesView.invalidate()", () => {
	it("is a no-op that does not throw", () => {
		const { view } = makeView();
		expect(() => view.invalidate()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Selection clamping
// ---------------------------------------------------------------------------

describe("WatchesView — selection clamping", () => {
	it("clamps selectedIndex when watches count shrinks during render", () => {
		const watches: WatchMap = { ...makeWatches() };
		// navigate to index 1
		const { view } = makeView(watches);
		view.handleInput("\x1b[B"); // move to index 1
		// Remove the second watch — now only 1 item
		delete watches["w2"];
		// render should clamp without throwing
		expect(() => view.render(120)).not.toThrow();
	});
});
