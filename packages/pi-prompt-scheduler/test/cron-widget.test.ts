/**
 * CronWidget renderer — layout-level tests.
 *
 * These tests exercise the private renderWidget() directly (cast to any) so
 * the assertion about "no blank line between header and first row" is pinned
 * without having to boot the full pi TUI runtime.
 *
 * See pi-prompt-scheduler#0002.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CronScheduler } from "../src/scheduler.js";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { CronWidget } from "../src/ui/cron-widget.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-prompt-scheduler-widget-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function makeJob(overrides: Partial<CronJob> & { id: string }): CronJob {
	const { session, id, ...rest } = overrides;
	const base: CronJob = {
		name: "demo",
		schedule: "0 * * * * *",
		type: "cron",
		prompt: "say hi",
		enabled: true,
		createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
		runCount: 0,
		...rest,
		id,
	};
	if (session !== undefined) base.session = session;
	return base;
}

function makeFakeTheme() {
	return {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		bg: (_c: string, t: string) => t,
	};
}

function makeFakeCtx() {
	return {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

function makeFakePi() {
	return {
		events: {
			on: () => () => {},
			emit: () => {},
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
}

describe("CronWidget layout", () => {
	it("does NOT emit a blank line between the header and the first job row", () => {
		const storage = new CronStorage(cwd);
		storage.addJob(makeJob({ id: "job-aaaaaa", name: "first-job" }));
		storage.addJob(makeJob({ id: "job-bbbbbb", name: "second-job" }));
		const scheduler = new CronScheduler(storage, makeFakePi(), makeFakeCtx());
		const widget = new CronWidget(storage, scheduler, makeFakePi(), () => true, undefined);
		const rendered = (widget as unknown as {
			renderWidget(width: number, theme: unknown): string[];
		}).renderWidget(120, makeFakeTheme());

		// Find the header line index. Header contains the literal "Scheduled Prompts".
		const headerIdx = rendered.findIndex((line) => line.includes("Scheduled Prompts"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);

		// The line immediately after the header must be the first job row
		// (contains one of the job names), NOT a blank/whitespace-only line.
		const afterHeader = rendered[headerIdx + 1] ?? "";
		expect(afterHeader.trim()).not.toBe("");
		expect(afterHeader).toMatch(/first-job|second-job/);
	});

	it("still renders the header when there are zero jobs loaded in this session", () => {
		// Job scoped to a different session, so loadedJobs() filters it out.
		const storage = new CronStorage(cwd);
		storage.addJob(makeJob({ id: "job-ccccc1", session: "other-session" }));
		const scheduler = new CronScheduler(storage, makeFakePi(), makeFakeCtx());
		const widget = new CronWidget(storage, scheduler, makeFakePi(), () => true, "this-session");
		const rendered = (widget as unknown as {
			renderWidget(width: number, theme: unknown): string[];
		}).renderWidget(120, makeFakeTheme());
		const headerIdx = rendered.findIndex((line) => line.includes("Scheduled Prompts"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);
	});
});
