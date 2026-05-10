/**
 * CronStorage — atomic JSON persistence at `<cwd>/.pi/schedule-prompts.json`.
 * Tests drive a real fs against mkdtempSync; no mocking of node:fs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CronStorage } from "../src/storage.js";
import type { CronJob, CronStore } from "../src/types.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-prompt-scheduler-storage-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
	return {
		id: "job-aaaaaa",
		name: "demo",
		schedule: "0 * * * * *",
		prompt: "hello",
		enabled: true,
		type: "cron",
		createdAt: "2030-01-01T00:00:00.000Z",
		runCount: 0,
		...overrides,
	};
}

function readStoreFile(s: CronStorage): CronStore {
	return JSON.parse(readFileSync(s.getStorePath(), "utf-8"));
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

describe("CronStorage.load", () => {
	it("returns an empty store when the file is absent (does NOT create it)", () => {
		const s = new CronStorage(cwd);
		expect(s.load()).toEqual({ jobs: [], version: 1 });
		expect(existsSync(join(cwd, ".pi"))).toBe(false);
	});

	it("reads and returns a well-formed store", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "schedule-prompts.json"),
			JSON.stringify({ jobs: [makeJob()], version: 1 }),
			"utf-8",
		);
		expect(new CronStorage(cwd).load().jobs).toHaveLength(1);
	});

	it("returns an empty store on malformed JSON (logs but does not throw)", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "schedule-prompts.json"), "{ not json", "utf-8");
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(new CronStorage(cwd).load()).toEqual({ jobs: [], version: 1 });
		expect(errSpy).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// save — creates .pi, writes atomically via temp + rename
// ---------------------------------------------------------------------------

describe("CronStorage.save", () => {
	it("creates `.pi/` if it doesn't exist and writes the JSON", () => {
		const s = new CronStorage(cwd);
		s.save({ jobs: [makeJob()], version: 1 });
		expect(existsSync(join(cwd, ".pi", "schedule-prompts.json"))).toBe(true);
		expect(readStoreFile(s).jobs).toHaveLength(1);
	});

	it("leaves no *.tmp leftover on a successful write", () => {
		const s = new CronStorage(cwd);
		s.save({ jobs: [makeJob()], version: 1 });
		const leftovers = readdirSync(join(cwd, ".pi")).filter((n) => n.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// CRUD — addJob / updateJob / removeJob / getJob / getAllJobs / hasJobWithName
// ---------------------------------------------------------------------------

describe("CronStorage CRUD", () => {
	it("addJob appends and persists", () => {
		const s = new CronStorage(cwd);
		s.addJob(makeJob({ id: "a" }));
		s.addJob(makeJob({ id: "b", name: "other" }));
		expect(s.getAllJobs().map((j) => j.id)).toEqual(["a", "b"]);
		expect(readStoreFile(s).jobs).toHaveLength(2);
	});

	it("hasJobWithName is name-only (case-sensitive, ignores ids)", () => {
		const s = new CronStorage(cwd);
		s.addJob(makeJob({ name: "Daily" }));
		expect(s.hasJobWithName("Daily")).toBe(true);
		expect(s.hasJobWithName("daily")).toBe(false);
		expect(s.hasJobWithName("missing")).toBe(false);
	});

	it("removeJob deletes the matching id and returns true; missing id returns false", () => {
		const s = new CronStorage(cwd);
		s.addJob(makeJob({ id: "a" }));
		s.addJob(makeJob({ id: "b", name: "other" }));
		expect(s.removeJob("a")).toBe(true);
		expect(s.removeJob("missing")).toBe(false);
		expect(s.getAllJobs().map((j) => j.id)).toEqual(["b"]);
	});

	it("removeJob does NOT rewrite the file when the id was not present", () => {
		const s = new CronStorage(cwd);
		s.addJob(makeJob({ id: "a" }));
		const before = readFileSync(s.getStorePath(), "utf-8");
		expect(s.removeJob("missing")).toBe(false);
		// Byte-identical — the save() branch was not entered.
		expect(readFileSync(s.getStorePath(), "utf-8")).toBe(before);
	});

	it("updateJob merges partials, returns true on hit / false on miss", () => {
		const s = new CronStorage(cwd);
		s.addJob(makeJob({ id: "a", enabled: true, runCount: 0 }));

		expect(s.updateJob("a", { enabled: false, runCount: 3 })).toBe(true);
		const updated = s.getJob("a");
		expect(updated?.enabled).toBe(false);
		expect(updated?.runCount).toBe(3);
		// Untouched fields stay put.
		expect(updated?.name).toBe("demo");

		expect(s.updateJob("missing", { enabled: true })).toBe(false);
	});

	it("updateJob accepts `undefined` to clear optional fields (LenientPartial contract)", () => {
		// lastStatus is optional. The scheduler relies on `updateJob(id,
		// { lastStatus: undefined })` to clear a stale `running` flag after
		// an interrupted session. Assert that path actually mutates the
		// stored object (Object.assign writes the undefined value).
		const s = new CronStorage(cwd);
		s.addJob(makeJob({ id: "a", lastStatus: "running" }));
		s.updateJob("a", { lastStatus: undefined });
		expect(s.getJob("a")?.lastStatus).toBeUndefined();
		// And persisted across a fresh instance.
		expect(new CronStorage(cwd).getJob("a")?.lastStatus).toBeUndefined();
	});

	it("getJob returns undefined for missing ids", () => {
		const s = new CronStorage(cwd);
		expect(s.getJob("missing")).toBeUndefined();
	});

	it("getStorePath points inside `.pi/`", () => {
		const s = new CronStorage(cwd);
		expect(s.getStorePath()).toBe(join(cwd, ".pi", "schedule-prompts.json"));
	});
});
