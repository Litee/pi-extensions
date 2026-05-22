import { describe, expect, it, vi } from "vitest";

import type { WatchMap } from "../src/types.js";
import { WatchesView } from "../src/ui/watches-view.js";

const theme = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
};

function makeWatches(): WatchMap {
	return {
		a: {
			watchId: "a",
			bucket: "buck",
			key: "live.txt",
			profile: "p",
			region: undefined,
			target: "exists",
			timeoutAt: undefined,
			addedAt: 100,
			lastPolledAt: 200,
			baseline: { exists: false },
			terminal: false,
			consecutiveErrors: 0,
		},
		b: {
			watchId: "b",
			bucket: "buck",
			key: "done.txt",
			profile: "p",
			region: "us-east-1",
			target: "removed",
			timeoutAt: undefined,
			addedAt: 50,
			lastPolledAt: undefined,
			baseline: { exists: true },
			terminal: true,
			consecutiveErrors: 0,
		},
	};
}

function makeView(overrides: Partial<{
	watches: WatchMap;
	displayMode: "widget" | "statusline";
}> = {}) {
	const watches = overrides.watches ?? makeWatches();
	const requestRender = vi.fn();
	const done = vi.fn();
	const removeWatch = vi.fn();
	const toggleDisplay = vi.fn();
	const view = new WatchesView(
		() => watches,
		theme,
		requestRender,
		done,
		removeWatch,
		() => 60_000,
		toggleDisplay,
		() => overrides.displayMode ?? "widget",
	);
	return { view, requestRender, done, removeWatch, toggleDisplay, watches };
}

describe("WatchesView — render", () => {
	it("renders an empty-state header when there are no watches", () => {
		const { view } = makeView({ watches: {} });
		const lines = view.render(100).join("\n");
		expect(lines).toContain("S3 Watcher");
		expect(lines).toContain("No watches configured.");
	});

	it("renders one row per non-terminal+terminal watch with header counts", () => {
		const { view } = makeView();
		const lines = view.render(100).join("\n");
		expect(lines).toContain("S3 Watcher");
		// Two rows total (1 active + 1 terminal), but header count is total rows.
		expect(lines).toMatch(/\(2\)/);
		expect(lines).toContain("s3://buck/live.txt");
		expect(lines).toContain("s3://buck/done.txt");
	});

	it("shows the next display-mode hint in the header", () => {
		const { view } = makeView({ displayMode: "widget" });
		expect(view.render(100).join("\n")).toContain("t → statusline");
		const { view: v2 } = makeView({ displayMode: "statusline" });
		expect(v2.render(100).join("\n")).toContain("t → widget");
	});

	it("renders a detail line under the rows for the selected watch", () => {
		const { view } = makeView();
		const lines = view.render(100).join("\n");
		// Selected (index 0) is the non-terminal watch (newest addedAt first).
		expect(lines).toContain("Profile: p");
		expect(lines).toContain("Region: default");
		expect(lines).toContain("Target: exists");
	});

	it("invalidate() is a no-op", () => {
		const { view } = makeView();
		expect(() => view.invalidate()).not.toThrow();
	});
});

describe("WatchesView — handleInput", () => {
	it("'q' invokes done()", () => {
		const { view, done } = makeView();
		view.handleInput("q");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("Escape invokes done()", () => {
		const { view, done } = makeView();
		view.handleInput("\x1b");
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("'r' triggers a re-render", () => {
		const { view, requestRender } = makeView();
		view.handleInput("r");
		expect(requestRender).toHaveBeenCalled();
	});

	it("'t' invokes toggleDisplay()", () => {
		const { view, toggleDisplay } = makeView();
		view.handleInput("t");
		expect(toggleDisplay).toHaveBeenCalledTimes(1);
	});

	it("'d' opens the unwatch confirm prompt", () => {
		const { view, requestRender } = makeView();
		view.handleInput("d");
		expect(requestRender).toHaveBeenCalled();
		const lines = view.render(100).join("\n");
		expect(lines).toContain('Unwatch "s3://buck/live.txt"?');
	});

	it("'d' then 'y' removes the selected watch", () => {
		const { view, removeWatch } = makeView();
		view.handleInput("d");
		view.handleInput("y");
		expect(removeWatch).toHaveBeenCalledWith("a");
	});

	it("'d' then 'n' cancels the unwatch prompt", () => {
		const { view, removeWatch } = makeView();
		view.handleInput("d");
		view.handleInput("n");
		expect(removeWatch).not.toHaveBeenCalled();
		expect(view.render(100).join("\n")).not.toContain("Unwatch ");
	});

	it("'d' then Escape cancels the unwatch prompt", () => {
		const { view, removeWatch } = makeView();
		view.handleInput("d");
		view.handleInput("\x1b");
		expect(removeWatch).not.toHaveBeenCalled();
	});

	it("ignores unknown keys", () => {
		const { view, requestRender, done } = makeView();
		view.handleInput("z");
		expect(done).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("'d' on an empty list is a no-op (no confirm prompt)", () => {
		const { view } = makeView({ watches: {} });
		view.handleInput("d");
		expect(view.render(100).join("\n")).toContain("No watches configured.");
	});
});

describe("WatchesView — purge terminal", () => {
	it("'D' on a list with terminal watches opens the purge-terminal confirm prompt", () => {
		const { view } = makeView();
		view.handleInput("D");
		const lines = view.render(100).join("\n");
		expect(lines).toContain("Purge 1 completed watch?");
		expect(lines).toContain("y confirm");
	});

	it("'D' then 'y' removes all terminal watches", () => {
		const { view, removeWatch } = makeView();
		view.handleInput("D");
		view.handleInput("y");
		expect(removeWatch).toHaveBeenCalledWith("b"); // watchId "b" is terminal in makeWatches()
		expect(removeWatch).toHaveBeenCalledTimes(1);
	});

	it("'D' then 'n' cancels the purge prompt", () => {
		const { view, removeWatch } = makeView();
		view.handleInput("D");
		view.handleInput("n");
		expect(removeWatch).not.toHaveBeenCalled();
		expect(view.render(100).join("\n")).not.toContain("Purge");
	});

	it("'D' is a no-op when there are no terminal watches", () => {
		const watches: WatchMap = {
			a: {
				watchId: "a",
				bucket: "buck",
				key: "live.txt",
				profile: "p",
				region: undefined,
				target: "exists",
				timeoutAt: undefined,
				addedAt: 100,
				lastPolledAt: 200,
				baseline: { exists: false },
				terminal: false,
				consecutiveErrors: 0,
			},
		};
		const { view, removeWatch } = makeView({ watches });
		view.handleInput("D");
		expect(removeWatch).not.toHaveBeenCalled();
		expect(view.render(100).join("\n")).not.toContain("Purge");
	});

	it("'D' shows count > 1 with plural label", () => {
		const watches: WatchMap = {
			...makeWatches(),
			c: {
				watchId: "c",
				bucket: "buck",
				key: "also-done.txt",
				profile: "p",
				region: undefined,
				target: "exists",
				timeoutAt: undefined,
				addedAt: 30,
				lastPolledAt: undefined,
				baseline: { exists: true },
				terminal: true,
				consecutiveErrors: 0,
			},
		};
		const { view } = makeView({ watches });
		view.handleInput("D");
		expect(view.render(100).join("\n")).toContain("Purge 2 completed watches?");
	});
});
