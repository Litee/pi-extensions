/**
 * Tests that require the Croner Cron class to fire its callback synchronously.
 * These tests live in a separate file so vi.mock("croner") at the top only
 * affects this file and not the main scheduler-instance tests.
 */

import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Mock Croner so the callback fires immediately — covers line 179
// ---------------------------------------------------------------------------

vi.mock("croner", () => {
	let capturedCallback: (() => void) | undefined;
	function Cron(_schedule: string, callback: () => void) {
		capturedCallback = callback;
		callback(); // fire immediately so the callback body (line 179) executes
		return { stop: () => {}, nextRun: () => new Date(Date.now() + 60_000) };
	}
	return { Cron, __getCronCallback: () => capturedCallback };
});

import { CronScheduler } from "../src/scheduler.js";
import { MemCronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fakes (mirrored from scheduler-instance.test.ts to avoid cross-file imports)
// ---------------------------------------------------------------------------

function makeFakePi() {
	return {
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
	};
}

function makeFakeCtx(sessionId: string | undefined = "sess-A") {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => [],
		},
	};
}

function mkJob(overrides: Partial<CronJob> = {}): CronJob {
	return {
		id: "j-callback",
		name: "n",
		schedule: "0 * * * * *",
		prompt: "p",
		enabled: true,
		type: "cron",
		createdAt: "2030-01-01T00:00:00.000Z",
		runCount: 0,
		session: "sess-A",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CronScheduler — Cron callback execution (line 179)", () => {
	it("the Cron callback body executes executeJob, posting the scheduled_prompt marker", () => {
		const storage = new MemCronStorage();
		const pi = makeFakePi();
		const scheduler = new CronScheduler(
			storage,
			pi as unknown as ExtensionAPI,
			makeFakeCtx("sess-A") as unknown as ExtensionContext,
		);

		const job = mkJob();
		storage.addJob(job);
		scheduler.addJob(job);

		// Croner mock fires the callback immediately — executeJob posts the marker
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const markerArgs = pi.sendMessage.mock.calls[0]![0] as { customType: string; details: Record<string, unknown> };
		expect(markerArgs.customType).toBe("scheduled_prompt");
		expect(markerArgs.details).toMatchObject({ jobId: job.id, jobName: job.name });

		scheduler.stop();
	});

	it("cron callback fires executeJob even when job has model (subagent path)", () => {
		const storage = new MemCronStorage();
		const pi = makeFakePi();
		const scheduler = new CronScheduler(
			storage,
			pi as unknown as ExtensionAPI,
			makeFakeCtx("sess-A") as unknown as ExtensionContext,
		);

		const job = mkJob({ id: "j-model-cb", model: "anthropic/claude-haiku-4-5" });
		storage.addJob(job);
		scheduler.addJob(job);

		// Croner mock fires the callback immediately — executeJob sees model set
		// and delegates to executeJobInSubagent. Since runSubagentOnce is not mocked
		// here, the subagent call would hang, but the marker should still be posted.
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const markerArgs = pi.sendMessage.mock.calls[0]![0] as { customType: string; details: Record<string, unknown> };
		expect(markerArgs.customType).toBe("scheduled_prompt");

		scheduler.stop();
	});
});
