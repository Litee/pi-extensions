import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { makeRuntime } from "../src/runtime.js";
import type { Ec2Client, InstanceStateResult } from "../src/ec2-client.js";
import {
	handleToolAction,
	MAX_TIMEOUT_SECONDS,
	resetToolRegisteredForTests,
} from "../src/toolAction.js";

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => [] as string[],
		setActiveTools: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
	};
}

function makeClient(resp: InstanceStateResult | Error): Ec2Client {
	const describe_ = vi.fn();
	if (resp instanceof Error) describe_.mockRejectedValue(resp);
	else describe_.mockResolvedValue(resp);
	return { describeInstance: describe_, stopInstance: vi.fn().mockResolvedValue(undefined), startInstance: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
	resetToolRegisteredForTests();
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("handleToolAction add", () => {
	it("rejects a missing instanceId", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, { action: "add", profile: "p" });
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/instanceId/i);
	});

	it("rejects an invalid instanceId format", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "not-valid",
			profile: "p",
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/invalid/i);
	});

	it("rejects a missing profile", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "i-1234abcd",
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/profile/i);
	});

	it("rejects when instance is not found at add-time", async () => {
		const rt = makeRuntime(makePi(), makeClient({ notFound: true }));
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "i-1234abcd",
			profile: "p",
		});
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/not found/i);
		expect(Object.keys(rt.watches)).toHaveLength(0);
	});

	it("adds a watch when instance is found", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "i-1234abcd",
			profile: "p",
		});
		expect(res.details.ok).toBe(true);
		const watchId = res.details.watchId!;
		expect(rt.watches[watchId]!.instanceId).toBe("i-1234abcd");
		expect(rt.watches[watchId]!.baseline?.state).toBe("running");
		expect(rt.scheduler.isRunning).toBe(true);
	});

	it("adds a watch even on seed error (non-notFound), includes note", async () => {
		const err = Object.assign(new Error("network fail"), { name: "NetworkError" });
		const rt = makeRuntime(makePi(), makeClient(err));
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "i-1234abcd",
			profile: "p",
		});
		expect(res.details.ok).toBe(true);
		const watchId = res.details.watchId!;
		expect(rt.watches[watchId]).toBeDefined();
		expect(rt.watches[watchId]!.baseline).toBeUndefined();
		expect(res.details.message).toMatch(/seeding failed/i);
	});

	it("stores timeoutAt when timeoutSeconds provided", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		rt.now = () => 1_000_000;
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "i-1234abcd",
			profile: "p",
			timeoutSeconds: 3600,
		});
		expect(res.details.ok).toBe(true);
		const watchId = res.details.watchId!;
		expect(rt.watches[watchId]!.timeoutAt).toBe(1_000_000 + 3600 * 1000);
	});

	it("caps timeoutSeconds at MAX_TIMEOUT_SECONDS", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		rt.now = () => 0;
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "i-1234abcd",
			profile: "p",
			timeoutSeconds: MAX_TIMEOUT_SECONDS + 999_999,
		});
		expect(res.details.ok).toBe(true);
		const watchId = res.details.watchId!;
		expect(rt.watches[watchId]!.timeoutAt).toBe(MAX_TIMEOUT_SECONDS * 1000);
		expect(res.details.message).toMatch(/capped/);
	});

	it("rejects non-positive timeoutSeconds", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "i-1234abcd",
			profile: "p",
			timeoutSeconds: -5,
		});
		expect(res.details.ok).toBe(false);
	});

	it("sets stopOnStopped=true when requested", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, {
			action: "add",
			instanceId: "i-1234abcd",
			profile: "p",
			stopOnStopped: true,
		});
		expect(res.details.ok).toBe(true);
		const watchId = res.details.watchId!;
		expect(rt.watches[watchId]!.stopOnStopped).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("handleToolAction remove", () => {
	it("removes an existing watch", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		await handleToolAction(rt, {
			action: "add", instanceId: "i-1234abcd", profile: "p",
		});
		const [watchId] = Object.keys(rt.watches);
		const res = await handleToolAction(rt, { action: "remove", watchId });
		expect(res.details.ok).toBe(true);
		expect(rt.watches[watchId!]).toBeUndefined();
	});

	it("returns error for unknown watchId", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, { action: "remove", watchId: "no-such" });
		expect(res.details.ok).toBe(false);
		expect(res.details.message).toMatch(/not found/i);
	});

	it("returns error when watchId is missing", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, { action: "remove" });
		expect(res.details.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// list / status / pause / resume
// ---------------------------------------------------------------------------

describe("handleToolAction list", () => {
	it("returns empty when no watches", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, { action: "list" });
		expect(res.details.ok).toBe(true);
		expect(res.details.watches).toHaveLength(0);
	});

	it("lists existing watches", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		await handleToolAction(rt, { action: "add", instanceId: "i-1234abcd", profile: "p" });
		const res = await handleToolAction(rt, { action: "list" });
		expect(res.details.watches).toHaveLength(1);
	});
});

describe("handleToolAction pause/resume", () => {
	it("pause sets rt.paused=true", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, { action: "pause" });
		expect(res.details.ok).toBe(true);
		expect(rt.paused).toBe(true);
	});

	it("resume sets rt.paused=false", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		rt.paused = true;
		const res = await handleToolAction(rt, { action: "resume" });
		expect(res.details.ok).toBe(true);
		expect(rt.paused).toBe(false);
	});
});

describe("handleToolAction status", () => {
	it("returns status info", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, { action: "status" });
		expect(res.details.ok).toBe(true);
		expect(res.details.message).toMatch(/ec2-watcher/i);
	});
});

describe("handleToolAction unknown", () => {
	it("returns error for unknown action", async () => {
		const rt = makeRuntime(makePi(), makeClient({ state: "running" }));
		const res = await handleToolAction(rt, { action: "fly-to-moon" });
		expect(res.details.ok).toBe(false);
	});
});
