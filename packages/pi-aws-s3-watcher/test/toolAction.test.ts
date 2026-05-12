import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeRuntime } from "../src/runtime.js";
import type { HeadObjectResult, S3Client } from "../src/s3-client.js";
import { handleToolAction, MAX_TIMEOUT_SECONDS, resetToolRegisteredForTests } from "../src/toolAction.js";

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
	};
}

function makeClient(resp: HeadObjectResult | Error): S3Client {
	const head = vi.fn();
	if (resp instanceof Error) head.mockRejectedValue(resp);
	else head.mockResolvedValue(resp);
	return { headObject: head };
}

beforeEach(() => {
	resetToolRegisteredForTests();
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("handleToolAction add", () => {
	it("rejects a non-s3 URI", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: true }));
		const res = await handleToolAction(rt, {
			action: "add",
			uri: "https://example.com/x",
			target: "exists",
			profile: "p",
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/start with 's3:\/\/'/);
	});

	it("rejects a missing target", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: true }));
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", profile: "p",
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/target to be/);
	});

	it("rejects a missing profile", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: true }));
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists",
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/requires a profile/);
	});

	it("rejects target='updated' for an absent object", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "updated", profile: "p",
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/requires the object to exist/);
		expect(Object.keys(rt.watches)).toHaveLength(0);
	});

	it("accepts target='exists' for an absent object and seeds the baseline", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
		});
		expect(res.details.ok).toBe(true);
		const watchId = res.details.watchId!;
		expect(rt.watches[watchId]!.baseline).toEqual({ exists: false });
		expect(rt.scheduler.isRunning).toBe(true);
	});

	it("accepts target='updated' for a present object", async () => {
		const rt = makeRuntime(makePi(), makeClient({
			exists: true, etag: '"a"', contentLength: 1,
		}));
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "updated", profile: "p",
		});
		expect(res.details.ok).toBe(true);
		const watchId = res.details.watchId!;
		expect(rt.watches[watchId]!.target).toBe("updated");
		expect(rt.watches[watchId]!.baseline).toEqual({
			exists: true, etag: '"a"', contentLength: 1,
		});
	});

	it("stores timeoutAt when timeoutSeconds is provided", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		rt.now = () => 10_000;
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
			timeoutSeconds: 60,
		});
		expect(res.details.ok).toBe(true);
		const w = rt.watches[res.details.watchId!]!;
		expect(w.timeoutAt).toBe(10_000 + 60_000);
	});

	it("defaults timeoutAt to MAX_TIMEOUT_SECONDS when timeoutSeconds is omitted", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		rt.now = () => 10_000;
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
		});
		expect(res.details.ok).toBe(true);
		const w = rt.watches[res.details.watchId!]!;
		expect(w.timeoutAt).toBe(10_000 + MAX_TIMEOUT_SECONDS * 1000);
	});

	it("caps timeoutSeconds at MAX_TIMEOUT_SECONDS and notes it in the message", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		rt.now = () => 10_000;
		const over = MAX_TIMEOUT_SECONDS + 3600;
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
			timeoutSeconds: over,
		});
		expect(res.details.ok).toBe(true);
		const w = rt.watches[res.details.watchId!]!;
		expect(w.timeoutAt).toBe(10_000 + MAX_TIMEOUT_SECONDS * 1000);
		expect(res.details.message).toMatch(/capped/);
	});

	it("rejects a negative timeoutSeconds", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
			timeoutSeconds: -5,
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/timeoutSeconds/);
	});

	it("still succeeds when seeding fails — baseline stays undefined for retry on next poll", async () => {
		const err = Object.assign(new Error("boom"), { name: "AccessDenied" });
		const rt = makeRuntime(makePi(), makeClient(err));
		const res = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
		});
		expect(res.details.ok).toBe(true);
		const w = rt.watches[res.details.watchId!]!;
		expect(w.baseline).toBeUndefined();
		expect(res.details.message).toMatch(/seeding failed/);
	});
});

// ---------------------------------------------------------------------------
// remove / list / status / pause / resume
// ---------------------------------------------------------------------------

describe("handleToolAction — remove / list / pause / resume / status", () => {
	it("remove rejects an unknown watchId", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		const res = await handleToolAction(rt, { action: "remove", watchId: "nope" });
		expect(res.details.ok).toBe(false);
	});

	it("remove stops polling once the last active watch is gone", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		const added = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
		});
		expect(rt.scheduler.isRunning).toBe(true);
		await handleToolAction(rt, { action: "remove", watchId: added.details.watchId });
		expect(rt.scheduler.isRunning).toBe(false);
	});

	it("list reports 'no watches' when empty", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		const res = await handleToolAction(rt, { action: "list" });
		expect(res.details.ok).toBe(true);
		expect(res.details.message).toMatch(/no watches/);
	});

	it("list renders one line per watch", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
		});
		const res = await handleToolAction(rt, { action: "list" });
		expect(res.details.message).toMatch(/s3:\/\/b\/k target=exists state=absent/);
	});

	it("pause stops the scheduler; resume restarts it", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
		});
		await handleToolAction(rt, { action: "pause" });
		expect(rt.paused).toBe(true);
		expect(rt.scheduler.isRunning).toBe(false);
		await handleToolAction(rt, { action: "resume" });
		expect(rt.paused).toBe(false);
		expect(rt.scheduler.isRunning).toBe(true);
	});

	it("status returns counts of active and terminal watches", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		const a = await handleToolAction(rt, {
			action: "add", uri: "s3://b/k", target: "exists", profile: "p",
		});
		rt.watches[a.details.watchId!]!.terminal = true;
		const res = await handleToolAction(rt, { action: "status" });
		expect(res.details.message).toMatch(/1 total \(0 active, 1 terminal\)/);
	});

	it("rejects unknown actions", async () => {
		const rt = makeRuntime(makePi(), makeClient({ exists: false }));
		const res = await handleToolAction(rt, { action: "wat" });
		expect(res.details.ok).toBe(false);
	});
});
