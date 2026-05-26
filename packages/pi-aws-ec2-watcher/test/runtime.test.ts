import { afterEach, describe, expect, it, vi } from "vitest";

import {
	makeRuntime,
	POLL_INTERVAL_MS,
	POLL_ERROR_THRESHOLD,
	pollOnce,
	startPolling,
	stopPolling,
} from "../src/runtime.js";
import type { Ec2Client, InstanceStateResult } from "../src/ec2-client.js";
import type { Ec2Watch } from "../src/types.js";

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => [] as string[],
		setActiveTools: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
	};
}

function makeResolvingClient(resp: InstanceStateResult): Ec2Client {
	return { describeInstance: vi.fn().mockResolvedValue(resp), stopInstance: vi.fn().mockResolvedValue(undefined), startInstance: vi.fn().mockResolvedValue(undefined) };
}

function makeErrorClient(err: Error): Ec2Client {
	return { describeInstance: vi.fn().mockRejectedValue(err), stopInstance: vi.fn().mockResolvedValue(undefined), startInstance: vi.fn().mockResolvedValue(undefined) };
}

function makeWatch(overrides: Partial<Ec2Watch> = {}): Ec2Watch {
	return {
		watchId: "w1",
		instanceId: "i-1234abcd",
		profile: "p",
		region: undefined,
		stopOnStopped: false,
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// makeRuntime
// ---------------------------------------------------------------------------

describe("makeRuntime", () => {
	it("initialises the scheduler at base interval, stopped", () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ state: "running" }));
		expect(rt.scheduler.isRunning).toBe(false);
		expect(rt.scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
	});
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

describe("startPolling / stopPolling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("flips isRunning true/false", () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ state: "running" }));
		startPolling(rt);
		expect(rt.scheduler.isRunning).toBe(true);
		stopPolling(rt);
		expect(rt.scheduler.isRunning).toBe(false);
	});

	it("startPolling is idempotent", () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ state: "running" }));
		startPolling(rt);
		const first = rt.scheduler.timer;
		startPolling(rt);
		expect(rt.scheduler.timer).toBe(first);
		stopPolling(rt);
	});
});

// ---------------------------------------------------------------------------
// pollOnce — timeout
// ---------------------------------------------------------------------------

describe("pollOnce — timeout", () => {
	it("fires a timeout event when timeoutAt has elapsed", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ state: "running" });
		const rt = makeRuntime(pi, client);
		rt.now = () => 2_000;
		rt.watches["w1"] = makeWatch({
			baseline: { state: "running" },
			timeoutAt: 1_000,
		});

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(msg.content).toMatch(/timed out/);
		expect(rt.watches["w1"].terminal).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// pollOnce — state change
// ---------------------------------------------------------------------------

describe("pollOnce — state change", () => {
	it("sends a message and marks terminal on 'terminated'", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ state: "terminated" });
		const rt = makeRuntime(pi, client);
		rt.watches["w1"] = makeWatch({ baseline: { state: "running" } });

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(rt.watches["w1"].terminal).toBe(true);
	});

	it("emits no message when state is unchanged", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ state: "running" });
		const rt = makeRuntime(pi, client);
		rt.watches["w1"] = makeWatch({ baseline: { state: "running" } });

		await pollOnce(rt);

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("stops polling when all watches are terminal", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ state: "terminated" });
		const rt = makeRuntime(pi, client);
		rt.watches["w1"] = makeWatch({ baseline: { state: "running" } });
		startPolling(rt);

		await pollOnce(rt);

		expect(rt.scheduler.isRunning).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// pollOnce — re-activation hint
// ---------------------------------------------------------------------------

describe("pollOnce — re-activation hint when tool is inactive", () => {
	it("omits hint when rt.enabled=true", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ state: "terminated" });
		const rt = makeRuntime(pi, client);
		rt.enabled = true;
		rt.watches["w1"] = makeWatch({ baseline: { state: "running" } });

		await pollOnce(rt);

		const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(msg.content).not.toContain("manage_tools");
	});

	it("appends manage_tools hint when rt.enabled=false and a change is detected", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ state: "terminated" });
		const rt = makeRuntime(pi, client);
		rt.enabled = false;
		rt.watches["w1"] = makeWatch({ baseline: { state: "running" } });

		await pollOnce(rt);

		const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(msg.content).toContain("manage_tools");
	});
});

// ---------------------------------------------------------------------------
// pollOnce — paused
// ---------------------------------------------------------------------------

describe("pollOnce — paused", () => {
	it("skips polling when paused", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ state: "running" });
		const rt = makeRuntime(pi, client);
		rt.paused = true;
		rt.watches["w1"] = makeWatch({ baseline: { state: "pending" } });

		await pollOnce(rt);

		expect(client.describeInstance).not.toHaveBeenCalled();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// pollOnce — errors
// ---------------------------------------------------------------------------

describe("pollOnce — per-watch errors", () => {
	it("increments consecutiveErrors on a transient error", async () => {
		const pi = makePi();
		const err = Object.assign(new Error("network fail"), { name: "NetworkError" });
		const client = makeErrorClient(err);
		const rt = makeRuntime(pi, client);
		rt.watches["w1"] = makeWatch({ baseline: { state: "running" } });

		await pollOnce(rt);

		expect(rt.watches["w1"].consecutiveErrors).toBe(1);
		expect(rt.watches["w1"].terminal).toBe(false);
	});

	it(`sends a warning message at POLL_ERROR_THRESHOLD consecutive errors`, async () => {
		const pi = makePi();
		const err = Object.assign(new Error("fail"), { name: "NetworkError" });
		const client = makeErrorClient(err);
		const rt = makeRuntime(pi, client);
		rt.watches["w1"] = makeWatch({ baseline: { state: "running" }, consecutiveErrors: POLL_ERROR_THRESHOLD - 1 });

		await pollOnce(rt);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }, unknown];
		expect(msg.content).toMatch(/consecutive/i);
	});
});
