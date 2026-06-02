import { describe, expect, it, vi } from "vitest";

import { buildTimeoutEvent, detectChanges, snapshotObject } from "../src/poller.js";
import type { HeadObjectResult, S3Client } from "../src/s3-client.js";
import type { S3Baseline, S3Watch, TargetCondition } from "../src/types.js";

function makeClient(response: HeadObjectResult): S3Client {
	return { headObject: vi.fn().mockResolvedValue(response) };
}

function makeWatch(target: TargetCondition, baseline?: S3Baseline): S3Watch {
	return {
		watchId: "w1",
		bucket: "b",
		key: "k",
		profile: "p",
		region: undefined,
		target,
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline,
		terminal: false,
		consecutiveErrors: 0,
	};
}

describe("snapshotObject", () => {
	it("returns {exists:false} when the object is absent", async () => {
		await expect(snapshotObject(makeClient({ exists: false }), makeWatch("creation")))
			.resolves.toEqual({ exists: false });
	});

	it("returns {exists:true, etag, contentLength} when the object is present", async () => {
		const client = makeClient({ exists: true, etag: '"abc"', contentLength: 42 });
		await expect(snapshotObject(client, makeWatch("modification")))
			.resolves.toEqual({ exists: true, etag: '"abc"', contentLength: 42 });
	});

	it("omits etag/contentLength when the SDK did not return them", async () => {
		const client = makeClient({ exists: true });
		await expect(snapshotObject(client, makeWatch("creation")))
			.resolves.toEqual({ exists: true });
	});
});

describe("detectChanges — target='exists'", () => {
	it("fires once when the object appears", async () => {
		const client = makeClient({ exists: true, etag: '"a"', contentLength: 1 });
		const watch = makeWatch("creation", { exists: false });
		const res = await detectChanges(client, watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("creation");
		expect(res.events[0]!.isTerminal).toBe(true);
		expect(res.observedChange).toBe(true);
		expect(res.newBaseline).toEqual({ exists: true, etag: '"a"', contentLength: 1 });
	});

	it("does not fire while object remains absent", async () => {
		const client = makeClient({ exists: false });
		const res = await detectChanges(client, makeWatch("creation", { exists: false }));
		expect(res.events).toHaveLength(0);
		expect(res.observedChange).toBe(false);
	});

	it("does not fire on first poll when baseline is undefined", async () => {
		const client = makeClient({ exists: true, etag: '"a"', contentLength: 1 });
		const res = await detectChanges(client, makeWatch("creation", undefined));
		expect(res.events).toHaveLength(0);
		expect(res.observedChange).toBe(false);
		expect(res.newBaseline.exists).toBe(true);
	});
});

describe("detectChanges — target='removed'", () => {
	it("fires once when the object disappears", async () => {
		const client = makeClient({ exists: false });
		const watch = makeWatch("deletion", { exists: true, etag: '"a"', contentLength: 1 });
		const res = await detectChanges(client, watch);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("deletion");
		expect(res.events[0]!.isTerminal).toBe(true);
		expect(res.observedChange).toBe(true);
	});

	it("does not fire while object remains present", async () => {
		const client = makeClient({ exists: true, etag: '"a"', contentLength: 1 });
		const res = await detectChanges(client, makeWatch(
			"deletion",
			{ exists: true, etag: '"a"', contentLength: 1 },
		));
		expect(res.events).toHaveLength(0);
		expect(res.observedChange).toBe(false);
	});
});

describe("detectChanges — target='updated'", () => {
	it("fires when ETag changes", async () => {
		const client = makeClient({ exists: true, etag: '"b"', contentLength: 1 });
		const res = await detectChanges(client, makeWatch(
			"modification",
			{ exists: true, etag: '"a"', contentLength: 1 },
		));
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("modification");
		expect(res.events[0]!.isTerminal).toBe(true);
		expect(res.observedChange).toBe(true);
	});

	it("fires when size changes (even with missing ETag)", async () => {
		const client = makeClient({ exists: true, contentLength: 2 });
		const res = await detectChanges(client, makeWatch(
			"modification",
			{ exists: true, contentLength: 1 },
		));
		expect(res.events).toHaveLength(1);
		expect(res.events[0]!.eventType).toBe("modification");
	});

	it("does not fire when ETag and size are unchanged", async () => {
		const client = makeClient({ exists: true, etag: '"a"', contentLength: 1 });
		const res = await detectChanges(client, makeWatch(
			"modification",
			{ exists: true, etag: '"a"', contentLength: 1 },
		));
		expect(res.events).toHaveLength(0);
		expect(res.observedChange).toBe(false);
	});

	it("does not fire when the object disappears (that's 'removed', not 'updated')", async () => {
		const client = makeClient({ exists: false });
		const res = await detectChanges(client, makeWatch(
			"modification",
			{ exists: true, etag: '"a"', contentLength: 1 },
		));
		expect(res.events).toHaveLength(0);
		// But the observable change still resets the scheduler.
		expect(res.observedChange).toBe(true);
	});
});

describe("buildTimeoutEvent", () => {
	it("produces a well-formed timeout event", () => {
		const ev = buildTimeoutEvent(makeWatch("creation"));
		expect(ev.eventType).toBe("timeout");
		expect(ev.isTerminal).toBe(true);
		expect(ev.summary).toMatch(/timed out waiting for 'creation'/);
		expect(ev.formatted.startsWith("• ")).toBe(true);
	});
});
