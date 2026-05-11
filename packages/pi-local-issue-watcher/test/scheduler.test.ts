/**
 * Sanity tests for the pi-local-issue-watcher PollScheduler migration.
 *
 * The watcher uses a flat 60s interval (no back-off), so the only
 * observable property that changed was gaining the PollScheduler
 * re-entry guard (covered by pi-watcher-core's own tests against the
 * real setTimeout chain). The extensive behavioural coverage in
 * index.test.ts (268 tests) exercises the full lifecycle through the
 * new PollScheduler-backed start/stop path without modification — a
 * strong signal that the refactor is behaviour-preserving. This file
 * adds a targeted smoke test on top of that to make the migration
 * intent explicit in the test ledger.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSessionStart } from "../src/index.js";
import { RUNSTATE_ENTRY_TYPE } from "../src/persistence.js";

interface StubPi {
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
}

function makePi(): StubPi {
	return { sendMessage: vi.fn(), appendEntry: vi.fn() };
}

describe("pi-local-issue-watcher scheduler lifecycle", () => {
	let dbRoot: string;

	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-local-issue-reentry-"));
		mkdirSync(join(dbRoot, "example-skill"), { recursive: true });
		writeFileSync(
			join(dbRoot, "example-skill", "0001-sample.json"),
			JSON.stringify({ id: 1, status: "open", title: "t", description: "d", comments: [] }),
		);
	});

	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	it("handleSessionStart returns a started, non-paused result on a fresh dbRoot", async () => {
		const pi = makePi();
		const ctx = {
			sessionManager: {
				getEntries: () => [
					// Explicit run-state = not paused so the watcher arms itself.
					{
						type: "custom",
						customType: RUNSTATE_ENTRY_TYPE,
						data: { savedAt: Date.now(), paused: false, items: [], baselines: {} },
					},
				],
			},
			hasUI: false,
		};
		const result = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		expect(result.started).toBe(true);
		expect(result.paused).toBe(false);
		// Snapshot reflects the single sample issue we wrote above.
		expect(Object.keys(result.snapshot).length).toBe(1);
	});

	it("handleSessionStart honours a persisted paused run-state", async () => {
		const pi = makePi();
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{
						type: "custom",
						customType: RUNSTATE_ENTRY_TYPE,
						data: { savedAt: Date.now(), paused: true, items: [], baselines: {} },
					},
				],
			},
			hasUI: false,
		};
		const result = await handleSessionStart({ pi: pi as never, ctx: ctx as never, dbRoot });
		expect(result.started).toBe(true);
		expect(result.paused).toBe(true);
	});
});
