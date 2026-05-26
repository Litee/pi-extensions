import { describe, expect, it, vi } from "vitest";

import { buildTimeoutEvent, detectChanges, snapshotInstance } from "../src/poller.js";
import type { Ec2Client, InstanceStateResult } from "../src/ec2-client.js";
import type { Ec2Baseline, Ec2Watch } from "../src/types.js";

function makeClient(response: InstanceStateResult): Ec2Client {
	return { describeInstance: vi.fn().mockResolvedValue(response), stopInstance: vi.fn().mockResolvedValue(undefined), startInstance: vi.fn().mockResolvedValue(undefined) };
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
// snapshotInstance
// ---------------------------------------------------------------------------

describe("snapshotInstance", () => {
	it("returns notFound when the API says not found", async () => {
		const client = makeClient({ notFound: true });
		const result = await snapshotInstance(client, makeWatch());
		expect(result.notFound).toBe(true);
	});

	it("returns state and metadata when found", async () => {
		const client = makeClient({
			state: "running",
			nameTag: "my-vm",
			availabilityZone: "us-east-1a",
			instanceType: "t3.micro",
		});
		const result = await snapshotInstance(client, makeWatch());
		expect(result.state).toBe("running");
		expect(result.nameTag).toBe("my-vm");
		expect(result.availabilityZone).toBe("us-east-1a");
		expect(result.instanceType).toBe("t3.micro");
	});
});

// ---------------------------------------------------------------------------
// detectChanges — no prior baseline
// ---------------------------------------------------------------------------

describe("detectChanges — no prior baseline", () => {
	it("sets baseline but emits no event on first poll", async () => {
		const client = makeClient({ state: "running" });
		const watch = makeWatch();
		const result = await detectChanges(client, watch);
		expect(result.events).toHaveLength(0);
		expect(result.newBaseline?.state).toBe("running");
		expect(result.observedChange).toBe(false);
	});

	it("sets notFoundBaseline=true when instance not found on first poll", async () => {
		const client = makeClient({ notFound: true });
		const watch = makeWatch();
		const result = await detectChanges(client, watch);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]!.eventType).toBe("not_found");
		expect(result.events[0]!.isTerminal).toBe(true);
		expect(result.observedChange).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// detectChanges — state_changed
// ---------------------------------------------------------------------------

describe("detectChanges — state_changed", () => {
	it("emits state_changed when state transitions from pending to running", async () => {
		const client = makeClient({ state: "running" });
		const baseline: Ec2Baseline = { state: "pending" };
		const watch = makeWatch({ baseline });
		const result = await detectChanges(client, watch);
		expect(result.events).toHaveLength(1);
		const ev = result.events[0]!;
		expect(ev.eventType).toBe("state_changed");
		expect(ev.previousState).toBe("pending");
		expect(ev.newState).toBe("running");
		expect(ev.isTerminal).toBe(false);
		expect(result.observedChange).toBe(true);
	});

	it("marks terminal when transitioning to terminated", async () => {
		const client = makeClient({ state: "terminated" });
		const baseline: Ec2Baseline = { state: "running" };
		const watch = makeWatch({ baseline });
		const result = await detectChanges(client, watch);
		expect(result.events[0]!.isTerminal).toBe(true);
	});

	it("marks terminal for stopped when stopOnStopped=true", async () => {
		const client = makeClient({ state: "stopped" });
		const baseline: Ec2Baseline = { state: "stopping" };
		const watch = makeWatch({ baseline, stopOnStopped: true });
		const result = await detectChanges(client, watch);
		expect(result.events[0]!.isTerminal).toBe(true);
	});

	it("does NOT mark terminal for stopped when stopOnStopped=false", async () => {
		const client = makeClient({ state: "stopped" });
		const baseline: Ec2Baseline = { state: "stopping" };
		const watch = makeWatch({ baseline, stopOnStopped: false });
		const result = await detectChanges(client, watch);
		expect(result.events[0]!.isTerminal).toBe(false);
	});

	it("emits no event when state is unchanged", async () => {
		const client = makeClient({ state: "running" });
		const baseline: Ec2Baseline = { state: "running" };
		const watch = makeWatch({ baseline });
		const result = await detectChanges(client, watch);
		expect(result.events).toHaveLength(0);
		expect(result.observedChange).toBe(false);
	});

	it("emits not_found event when instance disappears", async () => {
		const client = makeClient({ notFound: true });
		const baseline: Ec2Baseline = { state: "running" };
		const watch = makeWatch({ baseline });
		const result = await detectChanges(client, watch);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]!.eventType).toBe("not_found");
		expect(result.events[0]!.isTerminal).toBe(true);
		expect(result.observedChange).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildTimeoutEvent
// ---------------------------------------------------------------------------

describe("buildTimeoutEvent", () => {
	it("produces a well-formed timeout event", () => {
		const ev = buildTimeoutEvent(makeWatch());
		expect(ev.eventType).toBe("timeout");
		expect(ev.isTerminal).toBe(true);
		expect(ev.summary).toMatch(/timed out/);
		expect(ev.formatted.startsWith("• ")).toBe(true);
	});
});
