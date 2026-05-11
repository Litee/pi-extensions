/**
 * createCronTool — integration-ish tests over the `schedule_prompt` tool's
 * execute() paths. Uses a real CronStorage against mkdtempSync; stubs the
 * scheduler interface so no croner timers fire under test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import { createCronTool } from "../src/tool.js";
import type { CronJob, CronToolDetails, CronToolParamsType } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let cwd: string;
let storage: CronStorage;
let fakeScheduler: {
	addJob: ReturnType<typeof vi.fn>;
	removeJob: ReturnType<typeof vi.fn>;
	updateJob: ReturnType<typeof vi.fn>;
	getNextRun: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-prompt-scheduler-tool-"));
	storage = new CronStorage(cwd);
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
	rmSync(cwd, { recursive: true, force: true });
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
		makeCtx(ctxOpts) as any,
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
	const fakeTheme: any = {
		fg: (_cat: string, s: string) => s,
	};

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
		const rendered = (tool.renderCall as any)(params, fakeTheme);
		expect(String((rendered).text ?? rendered)).toMatch(matcher);
	});
});

// ---------------------------------------------------------------------------
// renderResult — TUI-facing summary built from details
// ---------------------------------------------------------------------------

describe("schedule_prompt tool / renderResult", () => {
	const fakeTheme: any = {
		fg: (_cat: string, s: string) => s,
		bold: (s: string) => s,
	};

	it("renders an error line when details.error is set", () => {
		const tool = makeTool();
		const rendered = (tool.renderResult as any)(
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
		const rendered = (tool.renderResult as any)(
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
		const rendered = (tool.renderResult as any)(
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
		const rendered = (tool.renderResult as any)(
			{ content: [{ type: "text", text: "raw fallback" }] },
			{},
			fakeTheme,
		);
		expect(String((rendered).text)).toBe("raw fallback");
	});
});
