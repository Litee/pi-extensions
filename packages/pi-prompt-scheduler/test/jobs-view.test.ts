/**
 * JobsView — browse/cancel overlay for scheduled prompts. No manual add
 * flow: the `a` keybinding is deliberately absent and the help line reflects
 * that. Tests drive the component with literal key bytes and inspect the
 * render output + storage/scheduler side effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CronScheduler } from "../src/scheduler.js";
import { MemCronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { JobsView } from "../src/ui/jobs-view.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// Theme stub: returns the raw string verbatim so assertions can substring-
// match user-visible content without worrying about ANSI colour codes.
const theme = {
	fg: (_cat: string, s: string) => s,
	bold: (s: string) => s,
	bg: (_cat: string, s: string) => s,
} as unknown as Theme;

function stripAnsi(s: string): string {
	// Defensive: with the stub theme above no ANSI leaks in, but keep this
	// in case future theme tweaks start emitting codes.
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function mkJob(overrides: Partial<CronJob> = {}): CronJob {
	return {
		id: "j1",
		name: "daily-digest",
		schedule: "0 0 0 * * *",
		prompt: "summarize today",
		enabled: true,
		type: "cron",
		createdAt: "2030-01-01T00:00:00.000Z",
		runCount: 0,
		session: "sess-A",
		...overrides,
	};
}

let storage: MemCronStorage;
let scheduler: {
	updateJob: ReturnType<typeof vi.fn>;
	removeJob: ReturnType<typeof vi.fn>;
	getNextRun: ReturnType<typeof vi.fn>;
};
let done: () => void;
let requestRender: () => void;

beforeEach(() => {
	storage = new MemCronStorage();
	scheduler = {
		updateJob: vi.fn(),
		removeJob: vi.fn(),
		getNextRun: vi.fn(() => null),
	};
	done = vi.fn();
	requestRender = vi.fn();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeView(sessionId: string | undefined = "sess-A"): JobsView {
	return new JobsView(
		storage,
		scheduler as unknown as CronScheduler,
		sessionId,
		theme,
		requestRender,
		done,
		(s: string) => s,
	);
}

function renderLines(view: JobsView, width = 80): string[] {
	return view.render(width).map(stripAnsi);
}

// ---------------------------------------------------------------------------
// Render — help line, empty state, table rows, foreign-session section
// ---------------------------------------------------------------------------

describe("JobsView render", () => {
	it("empty-state help line directs users to the tool, NOT to a manual add keybinding", () => {
		const view = makeView();
		const lines = renderLines(view);
		const joined = lines.join("\n");

		// Critical invariant of the split: no `a add` keybinding anywhere in
		// the overlay chrome.
		expect(joined).not.toMatch(/\ba add\b/);
		expect(joined).toContain("schedule_prompt");
	});

	it("populated-state help line lists only browse/cancel actions (no `a add`)", () => {
		storage.addJob(mkJob());
		const view = makeView();
		const joined = renderLines(view).join("\n");

		// The populated hint lists selection, toggle, scope, remove, cleanup, quit.
		expect(joined).toMatch(/\u2191\u2193 select/); // ↑↓ select
		expect(joined).toContain("t toggle");
		expect(joined).toContain("s scope");
		expect(joined).toContain("x remove");
		expect(joined).toContain("c cleanup");
		expect(joined).toContain("q quit");
		expect(joined).not.toMatch(/\ba add\b/);
	});

	it("renders one row per session-owned job with name, schedule, and prompt", () => {
		storage.addJob(mkJob({ id: "a", name: "daily", schedule: "0 0 0 * * *", prompt: "digest" }));
		storage.addJob(mkJob({ id: "b", name: "hourly", schedule: "0 0 * * * *", prompt: "poll" }));
		const view = makeView();
		const joined = renderLines(view).join("\n");

		expect(joined).toContain("daily");
		expect(joined).toContain("hourly");
		expect(joined).toMatch(/digest/);
		expect(joined).toMatch(/poll/);
	});

	it("renders foreign-session jobs under a separate read-only header", () => {
		storage.addJob(mkJob({ id: "a", name: "mine", session: "sess-A" }));
		storage.addJob(mkJob({ id: "b", name: "theirs", session: "sess-B" }));
		const view = makeView("sess-A");
		const joined = renderLines(view).join("\n");

		expect(joined).toContain("Other sessions");
		expect(joined).toContain("theirs");
	});

	it("does not render the foreign-session section when all jobs are ours", () => {
		storage.addJob(mkJob({ id: "a", name: "mine", session: "sess-A" }));
		const view = makeView("sess-A");
		expect(renderLines(view).join("\n")).not.toContain("Other sessions");
	});

	it("shows a `[shared]` tag for unbound (session-less) jobs under `Jobs`", () => {
		const unbound = mkJob({ id: "a", name: "shared-job" });
		delete (unbound as Partial<CronJob>).session;
		storage.addJob(unbound);
		const view = makeView("sess-A");
		expect(renderLines(view).join("\n")).toMatch(/\[shared\]/);
	});

	it("selected-row footer surfaces type + runs, and the prompt (truncated at 200 chars)", () => {
		const longPrompt = "x".repeat(500);
		storage.addJob(mkJob({ id: "a", prompt: longPrompt, runCount: 7 }));
		const view = makeView();
		const joined = renderLines(view).join("\n");

		expect(joined).toContain("Type: cron");
		expect(joined).toContain("Runs: 7");
		// Truncated at 200 with ellipsis; there should NOT be 500 x's.
		expect(joined).toContain("x".repeat(197) + "...");
		expect(joined).not.toContain("x".repeat(201));
	});
});

// ---------------------------------------------------------------------------
// Input — navigation, toggle, scope, remove, cleanup, quit
// ---------------------------------------------------------------------------

describe("JobsView input — navigation + quit", () => {
	it("q closes the overlay", () => {
		const view = makeView();
		view.handleInput("q");
		expect(done).toHaveBeenCalledOnce();
	});

	it("Escape closes the overlay", () => {
		const view = makeView();
		view.handleInput("\x1b");
		expect(done).toHaveBeenCalledOnce();
	});

	it("`a` is NOT bound (split invariant — the LLM owns add)", () => {
		storage.addJob(mkJob());
		const view = makeView();
		view.handleInput("a");
		// Component has no `runAdd` callback any more, and no other handler
		// reacts to `a`. `done` stays untouched, storage unchanged.
		expect(done).not.toHaveBeenCalled();
		expect(storage.getAllJobs()).toHaveLength(1);
	});

	it("↓ / ↑ moves selection through combined mine + foreign list but not past the ends", () => {
		storage.addJob(mkJob({ id: "a", name: "mine-1" }));
		storage.addJob(mkJob({ id: "b", name: "mine-2" }));
		storage.addJob(mkJob({ id: "c", name: "theirs", session: "sess-B" }));
		const view = makeView("sess-A");

		// Sanity: first render selects index 0 (mine-1).
		expect(renderLines(view).find((l) => l.includes("▶"))).toContain("mine-1");

		view.handleInput("\x1b[B"); // down → mine-2
		expect(renderLines(view).find((l) => l.includes("▶"))).toContain("mine-2");

		view.handleInput("\x1b[B"); // down → theirs (foreign)
		expect(renderLines(view).find((l) => l.includes("▶"))).toContain("theirs");

		view.handleInput("\x1b[B"); // past end, clamps
		expect(renderLines(view).find((l) => l.includes("▶"))).toContain("theirs");

		view.handleInput("\x1b[A"); // up → mine-2
		view.handleInput("\x1b[A"); // up → mine-1
		view.handleInput("\x1b[A"); // past start, clamps
		expect(renderLines(view).find((l) => l.includes("▶"))).toContain("mine-1");
	});
});

describe("JobsView input — toggle (t)", () => {
	it("toggles enabled on the selected session-owned job and notifies the scheduler", () => {
		storage.addJob(mkJob({ id: "a", enabled: true }));
		const view = makeView();

		view.handleInput("t");
		expect(storage.getJob("a")?.enabled).toBe(false);
		expect(scheduler.updateJob).toHaveBeenCalledWith("a", expect.objectContaining({ enabled: false }));

		view.handleInput("t");
		expect(storage.getJob("a")?.enabled).toBe(true);
	});

	it("is a no-op on foreign-session jobs (read-only)", () => {
		storage.addJob(mkJob({ id: "mine", name: "mine" }));
		storage.addJob(mkJob({ id: "theirs", name: "theirs", session: "sess-B", enabled: true }));
		const view = makeView("sess-A");

		// Move selection onto the foreign row.
		view.handleInput("\x1b[B");
		view.handleInput("t");

		expect(storage.getJob("theirs")?.enabled).toBe(true);
		expect(scheduler.updateJob).not.toHaveBeenCalled();
	});
});

describe("JobsView input — scope (s)", () => {
	it("`s` unbinds a session-bound job (session field removed)", () => {
		storage.addJob(mkJob({ id: "a", session: "sess-A" }));
		const view = makeView("sess-A");

		view.handleInput("s");
		expect(storage.getJob("a")?.session).toBeUndefined();
		expect(scheduler.updateJob).toHaveBeenCalledOnce();
	});

	it("`s` on an unbound job binds it to the current session", () => {
		const unbound = mkJob({ id: "a" });
		delete (unbound as Partial<CronJob>).session;
		storage.addJob(unbound);
		const view = makeView("sess-A");

		view.handleInput("s");
		expect(storage.getJob("a")?.session).toBe("sess-A");
	});

	it("is a no-op on foreign-session jobs", () => {
		storage.addJob(mkJob({ id: "mine" }));
		storage.addJob(mkJob({ id: "theirs", session: "sess-B" }));
		const view = makeView("sess-A");
		view.handleInput("\x1b[B"); // select foreign
		view.handleInput("s");
		expect(storage.getJob("theirs")?.session).toBe("sess-B");
		expect(scheduler.updateJob).not.toHaveBeenCalled();
	});
});

describe("JobsView input — remove (x) with y/n confirm", () => {
	it("`x` enters confirm mode; `y` removes; `n` cancels", () => {
		storage.addJob(mkJob({ id: "a" }));
		const view = makeView();

		view.handleInput("x");
		// Confirm prompt replaces the hint line.
		expect(renderLines(view).join("\n")).toMatch(/Remove ".+"\? \(y\/n\)/);

		view.handleInput("n");
		expect(storage.getJob("a")).toBeDefined();
		expect(scheduler.removeJob).not.toHaveBeenCalled();

		view.handleInput("x");
		view.handleInput("y");
		expect(storage.getJob("a")).toBeUndefined();
		expect(scheduler.removeJob).toHaveBeenCalledWith("a");
	});

	it("Escape inside the confirm prompt also cancels", () => {
		storage.addJob(mkJob({ id: "a" }));
		const view = makeView();
		view.handleInput("x");
		view.handleInput("\x1b");
		expect(storage.getJob("a")).toBeDefined();
	});

	it("`x` is a no-op on foreign-session jobs", () => {
		storage.addJob(mkJob({ id: "mine" }));
		storage.addJob(mkJob({ id: "theirs", session: "sess-B" }));
		const view = makeView("sess-A");
		view.handleInput("\x1b[B"); // select foreign
		view.handleInput("x");
		// No confirm prompt should have been entered.
		expect(renderLines(view).join("\n")).not.toMatch(/Remove ".+"\?/);
		view.handleInput("y"); // would remove if confirm had been entered
		expect(storage.getJob("theirs")).toBeDefined();
	});
});

describe("JobsView input — cleanup (c)", () => {
	it("`c` enters cleanup confirm when there are disabled session-owned jobs; `y` removes them", () => {
		storage.addJob(mkJob({ id: "on", enabled: true }));
		storage.addJob(mkJob({ id: "off1", enabled: false, name: "off1" }));
		storage.addJob(mkJob({ id: "off2", enabled: false, name: "off2" }));

		const view = makeView();
		view.handleInput("c");
		expect(renderLines(view).join("\n")).toMatch(/Remove 2 disabled job\(s\)/);

		view.handleInput("y");
		expect(storage.getJob("on")).toBeDefined();
		expect(storage.getJob("off1")).toBeUndefined();
		expect(storage.getJob("off2")).toBeUndefined();
		expect(scheduler.removeJob).toHaveBeenCalledTimes(2);
	});

	it("`c` is a no-op when no disabled jobs exist", () => {
		storage.addJob(mkJob({ id: "on", enabled: true }));
		const view = makeView();
		view.handleInput("c");
		// No confirm prompt — hint line is still showing.
		expect(renderLines(view).join("\n")).not.toMatch(/Remove \d+ disabled/);
	});

	it("`c` does NOT remove foreign-session disabled jobs", () => {
		storage.addJob(mkJob({ id: "mine-off", enabled: false }));
		storage.addJob(mkJob({ id: "theirs-off", enabled: false, session: "sess-B" }));
		const view = makeView("sess-A");
		view.handleInput("c");
		view.handleInput("y");
		expect(storage.getJob("mine-off")).toBeUndefined();
		expect(storage.getJob("theirs-off")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage
// ---------------------------------------------------------------------------

describe("JobsView — render without bgFn (return lines path)", () => {
	it("returns unpadded lines when bgFn is not provided", () => {
		storage.addJob(mkJob({ id: "j1", name: "test-job" }));
		const viewWithout = new JobsView(
			storage,
			scheduler as unknown as CronScheduler,
			"sess-A",
			theme,
			requestRender,
			done,
			// No bgFn — should return raw lines
		);
		const viewWith = new JobsView(
			storage,
			scheduler as unknown as CronScheduler,
			"sess-A",
			theme,
			requestRender,
			done,
			(s: string) => s, // identity bgFn: pads each line to width before wrapping
		);
		const linesWith = viewWith.render(80).map(stripAnsi);
		const linesWithout = viewWithout.render(80).map(stripAnsi);
		// bgFn path: each line is padded to visibleWidth ≥ width before being
		// passed to the wrapper — so at least one bgFn line must be strictly
		// longer than its unpadded counterpart.
		expect(linesWith.some((l, i) => l.length > (linesWithout[i]?.length ?? 0))).toBe(true);
		// Conversely, no no-bgFn line should exceed its bgFn counterpart.
		expect(linesWithout.some((l, i) => l.length > (linesWith[i]?.length ?? 0))).toBe(false);
	});
});

describe("JobsView — lastStatus icon variants", () => {
	it("shows running icon when lastStatus=running", () => {
		storage.addJob(mkJob({ id: "j1", name: "running-job", lastStatus: "running" }));
		const view = makeView();
		const lines = renderLines(view);
		// The stub theme passes the glyph verbatim; jobs-view.ts uses ⟳ for running.
		// Tie the glyph to the job's own row so a stray ⟳ elsewhere can't pass it.
		expect(lines.some(l => l.includes("running-job") && l.includes("⟳"))).toBe(true);
	});

	it("shows error icon when lastStatus=error", () => {
		storage.addJob(mkJob({ id: "j2", name: "error-job", lastStatus: "error" }));
		const view = makeView();
		const lines = renderLines(view);
		// jobs-view.ts uses "!" as the error glyph; stub theme passes it through verbatim.
		// Tie the glyph to the job's own row so an unrelated "!" can't pass it.
		expect(lines.some(l => l.includes("error-job") && l.includes("!"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage
// ---------------------------------------------------------------------------

describe("JobsView — selected footer with lastRun set (line 215 true branch)", () => {
	it("shows Last: when the selected job has a lastRun timestamp", () => {
		storage.addJob(mkJob({ id: "a", name: "ran-before", lastRun: "2025-01-01T00:00:00.000Z" }));
		const view = makeView();
		const joined = renderLines(view).join("\n");
		expect(joined).toContain("Last:");
	});
});

describe("JobsView — selected footer with next run available (line 214 true branch)", () => {
	it("shows Next: when getNextRun returns a Date", () => {
		storage.addJob(mkJob({ id: "a", name: "has-next" }));
		// Override mock to return a specific Date
		vi.mocked(scheduler.getNextRun).mockReturnValue(new Date("2099-06-01T12:00:00.000Z"));
		const view = makeView();
		const joined = renderLines(view).join("\n");
		expect(joined).toContain("Next:");
	});
});

describe("JobsView — foreign job icon variants (line 246 branches)", () => {
	it("shows '✗' for a disabled foreign job", () => {
		storage.addJob(mkJob({ id: "a", name: "mine", session: "sess-A" }));
		storage.addJob(mkJob({ id: "b", name: "foreign-disabled", session: "sess-B", enabled: false }));
		const view = makeView("sess-A");
		const joined = renderLines(view).join("\n");
		expect(joined).toContain("✗");
	});

	it("shows '!' for a foreign job with lastStatus=error", () => {
		storage.addJob(mkJob({ id: "a", name: "mine", session: "sess-A" }));
		storage.addJob(mkJob({ id: "b", name: "foreign-err", session: "sess-B", lastStatus: "error" }));
		const view = makeView("sess-A");
		const joined = renderLines(view).join("\n");
		expect(joined).toContain("!");
	});

	it("shows '✓' for an enabled foreign job with no error status", () => {
		storage.addJob(mkJob({ id: "a", name: "mine", session: "sess-A" }));
		storage.addJob(mkJob({ id: "b", name: "foreign-ok", session: "sess-B", enabled: true }));
		const view = makeView("sess-A");
		const joined = renderLines(view).join("\n");
		expect(joined).toContain("✓");
	});
});
