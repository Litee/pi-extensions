/**
 * createCronTool — integration-ish tests over the `schedule_prompt` tool's
 * execute() paths. Uses an in-memory CronStorage; stubs the
 * scheduler interface so no croner timers fire under test.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CronScheduler } from "../src/scheduler.js";
import { MemCronStorage } from "../src/storage.js";
import { createCronTool } from "../src/tool.js";
import type { CronJob, CronToolDetails, CronToolParamsType } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let storage: MemCronStorage;
let fakeScheduler: {
	addJob: ReturnType<typeof vi.fn>;
	removeJob: ReturnType<typeof vi.fn>;
	updateJob: ReturnType<typeof vi.fn>;
	getNextRun: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
	storage = new MemCronStorage();
	fakeScheduler = {
		addJob: vi.fn(),
		removeJob: vi.fn(),
		updateJob: vi.fn(),
		getNextRun: vi.fn(() => null),
	};
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function makeTool(defaultScope: "session" | "workdir" = "session") {
	return createCronTool(
		() => storage,
		() => fakeScheduler as unknown as CronScheduler,
		() => defaultScope,
	);
}

function makeCtx(opts: { sessionId?: string; entries?: unknown[] } = {}) {
	return {
		sessionManager: {
			getSessionId: () => opts.sessionId ?? "sess-A",
			getEntries: () => opts.entries ?? [],
		},
	};
}

async function exec(
	tool: ReturnType<typeof makeTool>,
	params: CronToolParamsType,
	ctxOpts: { sessionId?: string; entries?: unknown[] } = {},
) {
	return await tool.execute(
		"call-id",
		params,
		new AbortController().signal,
		() => {},
		makeCtx(ctxOpts) as unknown as ExtensionContext,
	);
}

function detailsOf(result: { details: CronToolDetails }): CronToolDetails {
	return result.details;
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / add", () => {
	it("creates a cron job, persists it, schedules it, and returns the job in details", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
			name: "minute",
		});
		const d = detailsOf(result);

		expect(d.error).toBeUndefined();
		expect(d.jobs).toHaveLength(1);
		expect(d.jobs[0]).toMatchObject({
			name: "minute",
			schedule: "0 * * * * *",
			prompt: "tick",
			type: "cron",
			enabled: true,
			runCount: 0,
			session: "sess-A", // default scope is "session"
		});
		expect(storage.getAllJobs()).toHaveLength(1);
		expect(fakeScheduler.addJob).toHaveBeenCalledOnce();
	});

	it("resolves `once` + relative time to an ISO timestamp before persisting", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			type: "once",
			schedule: "+10s",
			prompt: "in 10s",
		});
		const job = detailsOf(result).jobs[0]!;
		expect(job.type).toBe("once");
		expect(job.schedule).toBe("2030-01-01T00:00:10.000Z");
	});

	it("persists intervalMs alongside the schedule string for `interval` jobs", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			type: "interval",
			schedule: "5m",
			prompt: "poll",
		});
		const job = detailsOf(result).jobs[0]!;
		expect(job.type).toBe("interval");
		expect(job.schedule).toBe("5m");
		expect(job.intervalMs).toBe(5 * 60_000);
	});

	it("auto-generates a `job-<nanoid6>` name when `name` is omitted", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
		});
		expect(detailsOf(result).jobs[0]!.name).toMatch(/^job-[A-Za-z0-9_-]{6}$/);
	});

	it("omits the `session` field when default scope is `workdir` (unbound job, loads everywhere)", async () => {
		const tool = makeTool("workdir");
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
		});
		expect(detailsOf(result).jobs[0]!.session).toBeUndefined();
	});

	it.each([
		[{ prompt: "tick" }, "'schedule'"],
		[{ schedule: "0 * * * * *" }, "'prompt'"],
	])("rejects add missing required param (%j) with a pointed error", async (partial, expectedFragment) => {
		const tool = makeTool();
		const result = await exec(tool, { action: "add", ...partial });
		expect(detailsOf(result).error).toContain(expectedFragment);
		expect(storage.getAllJobs()).toHaveLength(0);
		expect(fakeScheduler.addJob).not.toHaveBeenCalled();
	});

	it("rejects add with a duplicate name; storage is not mutated", async () => {
		const tool = makeTool();
		await exec(tool, { action: "add", schedule: "0 * * * * *", prompt: "a", name: "dup" });
		fakeScheduler.addJob.mockClear();

		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "b",
			name: "dup",
		});
		expect(detailsOf(result).error).toContain("already exists");
		expect(storage.getAllJobs()).toHaveLength(1);
		expect(fakeScheduler.addJob).not.toHaveBeenCalled();
	});

	it("rejects add with empty-string model (defense-in-depth beyond the schema)", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
			model: "",
		});
		expect(detailsOf(result).error).toContain("non-empty string");
		expect(storage.getAllJobs()).toHaveLength(0);
	});

	it("propagates schedule-validation errors verbatim", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "* * * * *", // 5 fields, not 6
			prompt: "tick",
		});
		expect(detailsOf(result).error).toContain("Invalid cron expression");
		expect(storage.getAllJobs()).toHaveLength(0);
	});

	it("persists model + notify on add (subagent mode)", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
			model: "anthropic/claude-haiku-4-5",
			notify: true,
		});
		const job = detailsOf(result).jobs[0]!;
		expect(job.model).toBe("anthropic/claude-haiku-4-5");
		expect(job.notify).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("notifies parent");
	});

	// Recursion guard — scheduled prompts must not schedule themselves.
	// This check runs BEFORE the tool's internal try/catch, so it throws
	// rather than returning a `details.error` result.
	it("refuses add when a recent entry is a `scheduled_prompt` custom message (throws)", async () => {
		const tool = makeTool();
		await expect(
			exec(
				tool,
				{ action: "add", schedule: "0 * * * * *", prompt: "tick" },
				{
					entries: [
						{ type: "custom", customType: "scheduled_prompt", details: {} },
					],
				},
			),
		).rejects.toThrow(/scheduled prompt/);
		expect(storage.getAllJobs()).toHaveLength(0);
	});

	it("allows add when recent custom entries are unrelated", async () => {
		const tool = makeTool();
		const result = await exec(
			tool,
			{ action: "add", schedule: "0 * * * * *", prompt: "tick" },
			{
				entries: [
					{ type: "custom", customType: "cmux-sidebar", details: {} },
					{ type: "message", message: {} },
				],
			},
		);
		expect(detailsOf(result).error).toBeUndefined();
		expect(storage.getAllJobs()).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / remove", () => {
	async function seedJob(): Promise<string> {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
			name: "victim",
		});
		fakeScheduler.addJob.mockClear();
		return detailsOf(result).jobs[0]!.id;
	}

	it("removes an existing job from storage and unschedules it", async () => {
		const tool = makeTool();
		const id = await seedJob();

		const result = await exec(tool, { action: "remove", jobId: id });
		expect(detailsOf(result).error).toBeUndefined();
		expect(storage.getJob(id)).toBeUndefined();
		expect(fakeScheduler.removeJob).toHaveBeenCalledWith(id);
	});

	it("errors when jobId is missing", async () => {
		const tool = makeTool();
		const result = await exec(tool, { action: "remove" });
		expect(detailsOf(result).error).toContain("jobId is required");
	});

	it("errors when the job does not exist", async () => {
		const tool = makeTool();
		const result = await exec(tool, { action: "remove", jobId: "nope" });
		expect(detailsOf(result).error).toContain("Job not found");
		expect(fakeScheduler.removeJob).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / enable|disable", () => {
	async function seedJob(enabled: boolean): Promise<CronJob> {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
			name: "j",
		});
		const job = detailsOf(result).jobs[0]!;
		if (!enabled) {
			storage.updateJob(job.id, { enabled: false });
		}
		fakeScheduler.addJob.mockClear();
		fakeScheduler.updateJob.mockClear();
		return { ...job, enabled };
	}

	it("disables an enabled job, persists the flag, and notifies the scheduler", async () => {
		const tool = makeTool();
		const j = await seedJob(true);

		const result = await exec(tool, { action: "disable", jobId: j.id });
		expect(detailsOf(result).error).toBeUndefined();
		expect(storage.getJob(j.id)?.enabled).toBe(false);
		expect(fakeScheduler.updateJob).toHaveBeenCalledWith(j.id, expect.objectContaining({ enabled: false }));
	});

	it("re-enables a disabled job", async () => {
		const tool = makeTool();
		const j = await seedJob(false);

		await exec(tool, { action: "enable", jobId: j.id });
		expect(storage.getJob(j.id)?.enabled).toBe(true);
		expect(fakeScheduler.updateJob).toHaveBeenCalledWith(j.id, expect.objectContaining({ enabled: true }));
	});

	it("errors on missing jobId", async () => {
		const tool = makeTool();
		const result = await exec(tool, { action: "enable" });
		expect(detailsOf(result).error).toContain("jobId is required");
	});

	it("errors when the job does not exist", async () => {
		const tool = makeTool();
		const result = await exec(tool, { action: "disable", jobId: "nope" });
		expect(detailsOf(result).error).toContain("Job not found");
	});
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / update", () => {
	async function seedCron(): Promise<CronJob> {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
			name: "j",
		});
		fakeScheduler.addJob.mockClear();
		return detailsOf(result).jobs[0]!;
	}

	it("updates prompt, name, and description without touching the schedule", async () => {
		const tool = makeTool();
		const j = await seedCron();
		const result = await exec(tool, {
			action: "update",
			jobId: j.id,
			name: "renamed",
			prompt: "new",
			description: "desc",
		});
		expect(detailsOf(result).error).toBeUndefined();
		const stored = storage.getJob(j.id)!;
		expect(stored.name).toBe("renamed");
		expect(stored.prompt).toBe("new");
		expect(stored.description).toBe("desc");
		expect(stored.schedule).toBe(j.schedule);
	});

	it("re-validates schedule on update (cron)", async () => {
		const tool = makeTool();
		const j = await seedCron();

		const ok = await exec(tool, {
			action: "update",
			jobId: j.id,
			schedule: "0 */5 * * * *",
		});
		expect(detailsOf(ok).error).toBeUndefined();
		expect(storage.getJob(j.id)?.schedule).toBe("0 */5 * * * *");

		const bad = await exec(tool, {
			action: "update",
			jobId: j.id,
			schedule: "* * * * *", // 5 fields
		});
		expect(detailsOf(bad).error).toContain("Invalid cron expression");
		// Prior good schedule sticks.
		expect(storage.getJob(j.id)?.schedule).toBe("0 */5 * * * *");
	});

	it("rejects an empty-string model (same guard as add)", async () => {
		const tool = makeTool();
		const j = await seedCron();
		const result = await exec(tool, { action: "update", jobId: j.id, model: "" });
		expect(detailsOf(result).error).toContain("non-empty string");
	});

	it("errors on missing jobId / not-found", async () => {
		const tool = makeTool();
		expect(detailsOf(await exec(tool, { action: "update" })).error).toContain("jobId is required");
		expect(detailsOf(await exec(tool, { action: "update", jobId: "nope" })).error).toContain("Job not found");
	});
});

// ---------------------------------------------------------------------------
// list / cleanup
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / list", () => {
	it("prints a no-jobs message when storage is empty", async () => {
		const tool = makeTool();
		const result = await exec(tool, { action: "list" });
		expect((result.content[0] as { text: string }).text).toContain("No cron jobs configured");
		expect(detailsOf(result).jobs).toHaveLength(0);
	});

	it("hides foreign-session jobs (list is session-scoped)", async () => {
		// Seed two jobs: one for sess-A (ours), one for sess-B (foreign).
		const toolA = makeTool();
		await exec(toolA, { action: "add", schedule: "0 * * * * *", prompt: "mine", name: "mine" });
		// Insert a foreign-session job directly so we don't have to fake ctx swap during add.
		storage.addJob({
			id: "foreign-id",
			name: "foreign",
			schedule: "0 * * * * *",
			prompt: "theirs",
			enabled: true,
			type: "cron",
			createdAt: new Date().toISOString(),
			runCount: 0,
			session: "sess-B",
		});

		const result = await exec(toolA, { action: "list" });
		const d = detailsOf(result);
		expect(d.jobs.map((j) => j.name)).toEqual(["mine"]);
	});

	it("shows unbound jobs to every session", async () => {
		storage.addJob({
			id: "unbound-id",
			name: "unbound",
			schedule: "0 * * * * *",
			prompt: "p",
			enabled: true,
			type: "cron",
			createdAt: new Date().toISOString(),
			runCount: 0,
			// no `session` field
		});
		const tool = makeTool();
		const result = await exec(tool, { action: "list" }, { sessionId: "sess-Z" });
		expect(detailsOf(result).jobs.map((j) => j.name)).toEqual(["unbound"]);
	});
});

describe("schedule_prompt tool / cleanup", () => {
	it("removes only disabled + visible-to-this-session jobs, leaving the rest alone", async () => {
		// Mine, disabled → should be deleted.
		storage.addJob({
			id: "mine-off",
			name: "mine-off",
			schedule: "0 * * * * *",
			prompt: "p",
			enabled: false,
			type: "cron",
			createdAt: new Date().toISOString(),
			runCount: 0,
			session: "sess-A",
		});
		// Mine, enabled → keep.
		storage.addJob({
			id: "mine-on",
			name: "mine-on",
			schedule: "0 * * * * *",
			prompt: "p",
			enabled: true,
			type: "cron",
			createdAt: new Date().toISOString(),
			runCount: 0,
			session: "sess-A",
		});
		// Foreign, disabled → keep (not ours).
		storage.addJob({
			id: "foreign-off",
			name: "foreign-off",
			schedule: "0 * * * * *",
			prompt: "p",
			enabled: false,
			type: "cron",
			createdAt: new Date().toISOString(),
			runCount: 0,
			session: "sess-B",
		});
		// Unbound, disabled → delete (fair game, visible to everyone).
		storage.addJob({
			id: "unbound-off",
			name: "unbound-off",
			schedule: "0 * * * * *",
			prompt: "p",
			enabled: false,
			type: "cron",
			createdAt: new Date().toISOString(),
			runCount: 0,
		});

		const tool = makeTool();
		const result = await exec(tool, { action: "cleanup" });

		expect(detailsOf(result).jobs.map((j) => j.id).sort()).toEqual(["mine-off", "unbound-off"]);
		expect(storage.getAllJobs().map((j) => j.id).sort()).toEqual(["foreign-off", "mine-on"]);
		expect(fakeScheduler.removeJob).toHaveBeenCalledTimes(2);
	});

	it("returns a no-op message when there's nothing to clean up", async () => {
		const tool = makeTool();
		const result = await exec(tool, { action: "cleanup" });
		expect((result.content[0] as { text: string }).text).toContain("No disabled jobs");
		expect(fakeScheduler.removeJob).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// unknown action — catch-all default
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / unknown action", () => {
	it("rejects an action not in the switch statement", async () => {
		const tool = makeTool();
		// Bypass the schema — the tool is allowed to be invoked by callers
		// passing params directly (described in the tool source).
		const result = await exec(tool, { action: "bogus" });
		expect(detailsOf(result).error).toContain("Unknown action");
	});
});

// ---------------------------------------------------------------------------
// renderCall — the TUI call label shown before the result lands
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / renderCall", () => {
	const fakeTheme = {
		fg: (_cat: string, s: string) => s,
	} as unknown as Theme;

	type RenderCall = (params: unknown, theme: unknown) => { text?: string };

	it.each([
		[{ action: "add", name: "foo" }, /Adding cron job: foo/],
		[{ action: "remove", jobId: "j-1" }, /Removing cron job: j-1/],
		[{ action: "enable", jobId: "j-1" }, /job: j-1/],
		[{ action: "disable", jobId: "j-1" }, /job: j-1/],
		[{ action: "update", jobId: "j-1" }, /Updating cron job: j-1/],
		[{ action: "list" }, /Listing all cron jobs/],
		[{ action: "cleanup" }, /cleanup cron job/],
	])("labels %o", (params, matcher) => {
		const tool = makeTool();
		const rendered = (tool.renderCall as unknown as RenderCall)(params, fakeTheme);
		expect(String(rendered.text ?? "")).toMatch(matcher);
	});
});

// ---------------------------------------------------------------------------
// renderResult — TUI-facing summary built from details
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / renderResult", () => {
	const fakeTheme = {
		fg: (_cat: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Theme;

	type RenderResult = (result: unknown, opts: unknown, theme: unknown) => { text?: string };

	it("renders an error line when details.error is set", () => {
		const tool = makeTool();
		const rendered = (tool.renderResult as unknown as RenderResult)(
			{
				content: [{ type: "text", text: "ignored" }],
				details: { action: "add", jobs: [], error: "nope" },
			},
			{},
			fakeTheme,
		);
		expect(String((rendered).text)).toContain("Error: nope");
	});

	it("renders a success line for non-list actions", () => {
		const tool = makeTool();
		const rendered = (tool.renderResult as unknown as RenderResult)(
			{
				content: [{ type: "text", text: "ignored" }],
				details: { action: "remove", jobs: [], jobName: "victim" },
			},
			{},
			fakeTheme,
		);
		expect(String((rendered).text)).toMatch(/remove victim/);
	});

	it("renders a table row per job for list actions, including model + runs + last-run", () => {
		const tool = makeTool();
		const rendered = (tool.renderResult as unknown as RenderResult)(
			{
				content: [{ type: "text", text: "ignored" }],
				details: {
					action: "list",
					jobs: [
						{
							id: "j-1",
							name: "digest",
							schedule: "0 0 0 * * *",
							prompt: "summarize",
							enabled: true,
							type: "cron",
							createdAt: "2030-01-01T00:00:00.000Z",
							runCount: 3,
							model: "anthropic/claude-haiku-4-5",
							notify: true,
							lastRun: "2030-01-02T00:00:00.000Z",
						},
					],
				},
			},
			{},
			fakeTheme,
		);
		const text = String((rendered).text);
		expect(text).toContain("Cron Jobs");
		expect(text).toContain("digest");
		expect(text).toContain("0 0 0 * * *");
		expect(text).toContain("anthropic/claude-haiku-4-5");
		expect(text).toContain("notifies parent");
		expect(text).toContain("2030-01-02T00:00:00.000Z");
		expect(text).toContain("Runs:");
	});

	it("falls back to content text when details is missing", () => {
		const tool = makeTool();
		const rendered = (tool.renderResult as unknown as RenderResult)(
			{ content: [{ type: "text", text: "raw fallback" }] },
			{},
			fakeTheme,
		);
		expect(String((rendered).text)).toBe("raw fallback");
	});

	// -------------------------------------------------------------------------
	// add / update prompt-collapse behaviour (issue #0001)
	// -------------------------------------------------------------------------

	type RenderWithOpts = (
		result: unknown,
		opts: { expanded?: boolean },
		theme: unknown,
	) => { text?: string };

	function renderAdd(
		tool: ReturnType<typeof makeTool>,
		job: Partial<CronJob>,
		expanded: boolean,
		action: "add" | "update" = "add",
	): string {
		const full: CronJob = {
			id: "JOB123",
			name: "myjob",
			schedule: "0 * * * * *",
			prompt: "short",
			enabled: true,
			type: "cron",
			createdAt: "2030-01-01T00:00:00.000Z",
			runCount: 0,
			...job,
		};
		const rendered = (tool.renderResult as unknown as RenderWithOpts)(
			{
				content: [{ type: "text", text: "ignored" }],
				details: { action, jobs: [full], jobName: full.name, jobId: full.id },
			},
			{ expanded },
			fakeTheme,
		);
		return String((rendered).text);
	}

	it("add with a short single-line prompt: shows the prompt inline, no Ctrl-o hint", () => {
		const tool = makeTool();
		const text = renderAdd(tool, { prompt: "hello" }, false);
		expect(text).toContain("Created cron job");
		expect(text).toContain("myjob");
		expect(text).toContain("Type: cron");
		expect(text).toContain("Schedule: 0 * * * * *");
		expect(text).toContain("Prompt: hello");
		expect(text).not.toContain("Ctrl-o");
	});

	it("add with a long prompt, collapsed: hides the prompt and shows Ctrl-o hint", () => {
		const tool = makeTool();
		const long = "x".repeat(300);
		const text = renderAdd(tool, { prompt: long }, false);
		expect(text).toContain("Created cron job");
		expect(text).toContain("Type: cron");
		expect(text).toContain("Schedule:");
		expect(text).toContain("… ctrl+o to expand");
		expect(text).not.toContain(long);
		expect(text).not.toMatch(/^Prompt:/m);
	});

	it("add with a long prompt, expanded: shows the full prompt, no Ctrl-o hint", () => {
		const tool = makeTool();
		const long = "x".repeat(300);
		const text = renderAdd(tool, { prompt: long }, true);
		expect(text).toContain(long);
		expect(text).toContain("Prompt:");
		expect(text).not.toContain("Ctrl-o");
	});

	it("add with a multi-line prompt is collapsed even if total length is short", () => {
		const tool = makeTool();
		const text = renderAdd(tool, { prompt: "one\ntwo" }, false);
		expect(text).toContain("… ctrl+o to expand");
		expect(text).not.toContain("one\ntwo");
	});

	it("update action uses 'Updated' prefix and the same collapse rules", () => {
		const tool = makeTool();
		const long = "x".repeat(300);
		const collapsed = renderAdd(tool, { prompt: long }, false, "update");
		expect(collapsed).toContain("Updated cron job");
		expect(collapsed).toContain("… ctrl+o to expand");
		const expanded = renderAdd(tool, { prompt: long }, true, "update");
		expect(expanded).toContain(long);
	});

	it("add with a model line: surfaces Model: ... regardless of collapse state", () => {
		const tool = makeTool();
		const long = "x".repeat(300);
		const collapsed = renderAdd(tool, { prompt: long, model: "anthropic/claude-haiku-4-5", notify: true }, false);
		expect(collapsed).toContain("Model: anthropic/claude-haiku-4-5");
		expect(collapsed).toContain("notifies parent");
		const expanded = renderAdd(tool, { prompt: long, model: "anthropic/claude-haiku-4-5" }, true);
		expect(expanded).toContain("Model: anthropic/claude-haiku-4-5");
	});
});

// ---------------------------------------------------------------------------
// content[].text for add: same collapse behaviour as renderResult (issue #0001)
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / add content text", () => {
	function textOf(result: unknown): string {
		const r = result as { content: Array<{ type: string; text?: string }> };
		return r.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
	}

	it("inlines a short prompt", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "hello",
			name: "short",
		});
		const text = textOf(result);
		expect(text).toContain("Prompt: hello");
		expect(text).not.toContain("Ctrl-o");
	});

	it("collapses a long prompt into a Ctrl-o hint and omits the prompt body", async () => {
		const tool = makeTool();
		const long = "x".repeat(300);
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: long,
			name: "long",
		});
		const text = textOf(result);
		expect(text).toContain("… ctrl+o to expand");
		expect(text).not.toContain(long);
		expect(text).not.toMatch(/^Prompt: /m);
	});

	it("collapses a multi-line prompt even when length is short", async () => {
		const tool = makeTool();
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "a\nb",
			name: "multi",
		});
		const text = textOf(result);
		expect(text).toContain("… ctrl+o to expand");
		expect(text).not.toContain("a\nb");
	});
});

// ---------------------------------------------------------------------------
// shouldCollapsePrompt and buildJobSummaryLines — branch coverage
// ---------------------------------------------------------------------------
import { shouldCollapsePrompt, buildJobSummaryLines } from "../src/tool.js";

describe("shouldCollapsePrompt", () => {
  it("returns true for multiline prompts", () => {
    expect(shouldCollapsePrompt("line1\nline2")).toBe(true);
  });

  it("returns true for prompts longer than the collapse threshold", () => {
    expect(shouldCollapsePrompt("x".repeat(200))).toBe(true);
  });

  it("returns false for short single-line prompts", () => {
    expect(shouldCollapsePrompt("short prompt")).toBe(false);
  });
});

describe("buildJobSummaryLines", () => {
  it("includes model line with no-notify variant when model is set", () => {
    const lines = buildJobSummaryLines("Created", {
      name: "test", id: "id1", type: "interval" as const,
      schedule: "0 9 * * 1-5", prompt: "do stuff", model: "anthropic/haiku", notify: false,
    }, { collapse: false });
    expect(lines.some(l => l.includes("haiku"))).toBe(true);
    expect(lines.some(l => l.includes("notifies parent"))).toBe(false);
    expect(lines.some(l => l.includes("runs in subagent"))).toBe(true);
  });

  it("includes notify annotation when model and notify are both set", () => {
    const lines = buildJobSummaryLines("Updated", {
      name: "test", id: "id2", type: "interval" as const,
      schedule: "0 9 * * 1-5", prompt: "do stuff", model: "openai/gpt-4", notify: true,
    }, { collapse: false });
    expect(lines.some(l => l.includes("notifies parent"))).toBe(true);
  });

  it("skips model line when model is not set", () => {
    const lines = buildJobSummaryLines("Created", {
      name: "test", id: "id3", type: "interval" as const,
      schedule: "0 9 * * 1-5", prompt: "do stuff", notify: false,
    }, { collapse: false });
    expect(lines.some(l => l.startsWith("Model:"))).toBe(false);
  });

  it("shows collapse hint when collapse=true", () => {
    const lines = buildJobSummaryLines("Created", {
      name: "test", id: "id4", type: "interval" as const,
      schedule: "0 9 * * 1-5", prompt: "do stuff", notify: false,
    }, { collapse: true });
    expect(lines.some(l => l.includes("ctrl+o"))).toBe(true);
  });

  it("shows full prompt when collapse=false", () => {
    const prompt = "What did you accomplish?";
    const lines = buildJobSummaryLines("Created", {
      name: "test", id: "id5", type: "interval" as const,
      schedule: "0 9 * * 1-5", prompt, notify: false,
    }, { collapse: false });
    expect(lines.some(l => l.includes("Prompt:"))).toBe(true);
    expect(lines.some(l => l.includes(prompt))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anti-recursion guard
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / anti-recursion guard", () => {
	it("throws when trying to add a scheduled prompt from within a scheduled prompt", async () => {
		const tool = makeTool();
		// Simulate being inside a scheduled prompt by having a recent scheduled_prompt entry
		const entries = [
			{ type: "custom", customType: "scheduled_prompt", data: { jobId: "some-job" } },
		];
		await expect(
			exec(tool, { action: "add", schedule: "+1m", prompt: "nested prompt" }, { entries }),
		).rejects.toThrow(/Cannot create scheduled prompts from within/);
	});
});

// ---------------------------------------------------------------------------
// Additional branch coverage for tool.ts
// ---------------------------------------------------------------------------

describe("schedule_prompt tool — additional branch coverage", () => {
	it("uses the default getDefaultScope when createCronTool is called without the third argument (line 71)", async () => {
		// Call createCronTool without the 3rd argument to use the default (() => "session")
		const tool = createCronTool(
			() => storage,
			() => fakeScheduler as unknown as CronScheduler,
			// No 3rd argument — default kicks in
		);
		// The default scope function should return "session"
		expect(tool).toBeDefined();
		expect(tool.name).toBe("schedule_prompt");
		// Actually exercise the default scope path: add a job and verify
		// the session field is set (proving getDefaultScope() === "session").
		const result = await exec(tool, {
			action: "add",
			schedule: "0 * * * * *",
			prompt: "tick",
			name: "default-scope",
		});
		const job = detailsOf(result).jobs[0]!;
		expect(job.session).toBe("sess-A"); // default scope = "session" → session-bound
	});

	it("returns error content when storage.removeJob fails (line 203 throw caught by outer try/catch)", async () => {
		// Create a mock storage that has a job but fails to remove it
		const fakeJob = { id: "fake-id", name: "fake", schedule: "0 9 * * * *", prompt: "hi", enabled: true, type: "cron" as const, createdAt: new Date().toISOString(), runCount: 0 };
		const mockStorage = {
			hasJobWithName: () => false,
			addJob: () => {},
			getJob: () => fakeJob,        // returns the job
			removeJob: () => false as const, // always fails to remove
			updateJob: () => true,
			getAllJobs: () => [fakeJob],
		};
		const tool = createCronTool(
			() => mockStorage as never,
			() => fakeScheduler as unknown as CronScheduler,
			() => "session",
		);
		// The outer try/catch in tool.ts catches the throw and returns an error result
		const result = await exec(tool, { action: "remove", jobId: "fake-id" });
		const text = (result as { content: { type: string; text: string }[] }).content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toContain("Failed to remove job");
	});

	it("shows Model line when job has a model set (line 354)", async () => {
		// Add a job with model set using a valid cron schedule
		const tool = makeTool();
		await exec(tool, {
			action: "add",
			schedule: "0 9 * * * *",
			prompt: "check goals",
			model: "openai/gpt-4",
		});
		// List to see the Model line
		const result = await exec(tool, { action: "list" });
		const lines = (result as { content: { type: string; text: string }[] }).content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(lines).toContain("Model:");
	});

	it("shows Description line when job has a description (line 360)", async () => {
		const tool = makeTool();
		await exec(tool, {
			action: "add",
			schedule: "0 9 * * * *",
			prompt: "check goals",
			description: "my custom description",
		});
		const result = await exec(tool, { action: "list" });
		const lines = (result as { content: { type: string; text: string }[] }).content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(lines).toContain("Description:");
		expect(lines).toContain("my custom description");
	});
});

// ---------------------------------------------------------------------------
// renderResult — expanded false branches (tool.ts line 439)
// ---------------------------------------------------------------------------

describe("renderResult — expanded false branches (line 439)", () => {
	const fakeTheme = {
		fg: (_cat: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Theme;

	it("renders add result collapsed when options is undefined (line 439 false branch: options is falsy)", () => {
		const tool = makeTool();
		const longPrompt = "x".repeat(300);
		const result = {
			content: [{ type: "text", text: "Created" }],
			details: { action: "add" as const, jobs: [{ name: "j", id: "j1", prompt: longPrompt, type: "cron" as const, schedule: "0 * * * * *" }], jobId: "j1", jobName: "j" },
		};
		const rendered = (tool.renderResult as RenderResult)(result, undefined, fakeTheme);
		const text = String((rendered).text);
		expect(text).toContain("… ctrl+o to expand");
	});

	it("renders add result collapsed when options is a non-object (line 439 false branch: typeof options !== 'object')", () => {
		const tool = makeTool();
		const longPrompt = "x".repeat(300);
		const result = {
			content: [{ type: "text", text: "Created" }],
			details: { action: "add" as const, jobs: [{ name: "j", id: "j1", prompt: longPrompt, type: "cron" as const, schedule: "0 * * * * *" }], jobId: "j1", jobName: "j" },
		};
		const rendered = (tool.renderResult as unknown as (r: unknown, o: number, t: unknown) => Text)(result, 42 as unknown as Record<string, unknown>, fakeTheme);
		const text = String((rendered as Text).text);
		expect(text).toContain("… ctrl+o to expand");
	});

	it("renders add result collapsed when options has no 'expanded' key (line 439 false branch: 'expanded' not in options)", () => {
		const tool = makeTool();
		const longPrompt = "x".repeat(300);
		const result = {
			content: [{ type: "text", text: "Created" }],
			details: { action: "add" as const, jobs: [{ name: "j", id: "j1", prompt: longPrompt, type: "cron" as const, schedule: "0 * * * * *" }], jobId: "j1", jobName: "j" },
		};
		const rendered = (tool.renderResult as RenderWithOpts)(result, { foo: "bar" }, fakeTheme);
		const text = String((rendered).text);
		expect(text).toContain("… ctrl+o to expand");
	});
});

// ---------------------------------------------------------------------------
// renderResult — non-text content type (tool.ts line 420)
// ---------------------------------------------------------------------------

describe("renderResult — non-text content (line 420)", () => {
	const fakeTheme = {
		fg: (_cat: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Theme;

	it("renders non-text content as empty string (line 420 c.type !== 'text' branch)", () => {
		const tool = makeTool();
		const result = {
			content: [{ type: "image", url: "http://example.com/img.png" }],
			details: undefined,
		};
		const rendered = (tool.renderResult as RenderResult)(result, undefined, fakeTheme);
		const text = String((rendered).text);
		expect(text).toBe("");
	});
});

// ---------------------------------------------------------------------------
// renderResult — list action disabled job / no model (lines 464-474)
// ---------------------------------------------------------------------------

describe("renderResult — list action edge cases (lines 464-474)", () => {
	const fakeTheme = {
		fg: (cat: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Theme;

	it("renders disabled job with muted ✓ (line 464 false branch: !job.enabled)", () => {
		const tool = makeTool();
		const result = {
			content: [{ type: "text", text: "list" }],
			details: {
				action: "list" as const,
				jobs: [{ name: "disabled", id: "d1", type: "cron" as const, schedule: "0 * * * * *", prompt: "p", enabled: false, runCount: 0 }] as CronJob[],
			},
		};
		const rendered = (tool.renderResult as RenderResult)(result, undefined, fakeTheme);
		const text = String((rendered).text);
		expect(text).toContain("disabled");
	});

	it("renders job without model — omits Model line (lines 469-471 false branch: !job.model)", () => {
		const tool = makeTool();
		const result = {
			content: [{ type: "text", text: "list" }],
			details: {
				action: "list" as const,
				jobs: [{ name: "no-model", id: "nm1", type: "cron" as const, schedule: "0 * * * * *", prompt: "p", enabled: true, runCount: 0, model: undefined }] as CronJob[],
			},
		};
		const rendered = (tool.renderResult as RenderResult)(result, undefined, fakeTheme);
		const text = String((rendered).text);
		expect(text).toContain("no-model");
		expect(text).not.toContain("Model:");
	});

	it("renders job without lastRun — omits Last run line (lines 474-476 false branch: !job.lastRun)", () => {
		const tool = makeTool();
		const result = {
			content: [{ type: "text", text: "list" }],
			details: {
				action: "list" as const,
				jobs: [{ name: "no-run", id: "nr1", type: "cron" as const, schedule: "0 * * * * *", prompt: "p", enabled: true, runCount: 0, lastRun: undefined }] as CronJob[],
			},
		};
		const rendered = (tool.renderResult as RenderResult)(result, undefined, fakeTheme);
		const text = String((rendered).text);
		expect(text).toContain("no-run");
		expect(text).not.toContain("Last run:");
	});
});

// ---------------------------------------------------------------------------
// execute — non-Error throw in catch block (tool.ts line 375)
// ---------------------------------------------------------------------------

describe("execute — non-Error catch (line 375)", () => {
	it("uses String(error) fallback when a non-Error is thrown (line 375)", async () => {
		const mockStorage = {
			getAllJobs: vi.fn().mockReturnValue([]),
			hasJobWithName: vi.fn().mockReturnValue(false),
			addJob: vi.fn(),
			getJob: vi.fn().mockReturnValue(null),
			removeJob: vi.fn().mockReturnValue(false),
			updateJob: vi.fn(),
		} as unknown as CronStorage;
		const tool = createCronTool(() => mockStorage, () => fakeScheduler as unknown as CronScheduler);
		// Make the storage throw a non-Error value
		mockStorage.getAllJobs.mockImplementation(() => { throw "not an Error"; });
		const result = await exec(tool, { action: "list" });
		const text = (result as { content: { type: string; text: string }[] }).content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toContain("not an Error");
	});
});

// ---------------------------------------------------------------------------
// renderResult — notify=false in list (tool.ts line 470)
// ---------------------------------------------------------------------------

describe("renderResult — list with notify=false (line 470)", () => {
	const fakeTheme = {
		fg: (cat: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Theme;

	it("renders subagent tag as '(subagent)' when notify is false (line 470 false branch)", () => {
		const tool = makeTool();
		const result = {
			content: [{ type: "text", text: "list" }],
			details: {
				action: "list" as const,
				jobs: [{ name: "notify-false", id: "nf1", type: "cron" as const, schedule: "0 * * * * *", prompt: "p", enabled: true, runCount: 0, model: "gpt-4", notify: false }] as CronJob[],
			},
		};
		const rendered = (tool.renderResult as RenderResult)(result, undefined, fakeTheme);
		const text = String((rendered).text);
		expect(text).toContain("(subagent)");
		expect(text).not.toContain("notifies parent");
	});
});
