/**
 * Branch-coverage gap-fill for poller.ts.
 *
 * Covers the branches not exercised by poller.test.ts:
 *   - L51: buildStateChangedEvent nameTag truthy branch
 *   - L126-131: detectChanges newBaseline optional-field true-branches
 *     (nameTag, stateTransitionReason, availabilityZone, instanceType)
 */

import { describe, expect, it, vi } from "vitest";

import { detectChanges } from "../src/poller.js";
import type { Ec2Client, InstanceStateResult } from "../src/ec2-client.js";
import type { Ec2Baseline, Ec2Watch } from "../src/types.js";

function makeClient(response: InstanceStateResult): Ec2Client {
	return {
		describeInstance: vi.fn().mockResolvedValue(response),
		stopInstance: vi.fn().mockResolvedValue(undefined),
		startInstance: vi.fn().mockResolvedValue(undefined),
	};
}

function makeWatch(overrides: Partial<Ec2Watch> = {}): Ec2Watch {
	return {
		watchId: "w1",
		instanceId: "i-1234abcd",
		profile: "p",
		region: undefined,
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
// buildStateChangedEvent — nameTag truthy branch (poller.ts L51)
// ---------------------------------------------------------------------------

describe("detectChanges — buildStateChangedEvent with nameTag", () => {
	it("includes nameTag in the summary label when the response includes a nameTag", async () => {
		// Prior baseline: pending. New state: running. nameTag present.
		const baseline: Ec2Baseline = { state: "pending" };
		const client = makeClient({ state: "running", nameTag: "web-server" });
		const watch = makeWatch({ baseline });

		const result = await detectChanges(client, watch);

		expect(result.events).toHaveLength(1);
		const ev = result.events[0]!;
		expect(ev.eventType).toBe("state_changed");
		// The label should be "i-1234abcd (web-server)"
		expect(ev.summary).toBe("i-1234abcd (web-server): pending → running");
		expect(ev.formatted).toBe("• i-1234abcd (web-server): pending → running");
	});

	it("includes nameTag in a terminal state-change event", async () => {
		// State change to terminated — nameTag branch + terminal branch
		const baseline: Ec2Baseline = { state: "running" };
		const client = makeClient({ state: "terminated", nameTag: "db-node" });
		const watch = makeWatch({ baseline });

		const result = await detectChanges(client, watch);

		expect(result.events[0]!.summary).toBe("i-1234abcd (db-node): running → terminated ✓");
		expect(result.events[0]!.isTerminal).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// detectChanges — newBaseline optional-field true-branches (poller.ts L126-131)
// ---------------------------------------------------------------------------

describe("detectChanges — newBaseline with all optional fields", () => {
	it("spreads nameTag into newBaseline when present in response (L126 true branch)", async () => {
		const client = makeClient({
			state: "running",
			nameTag: "my-vm",
		});
		const watch = makeWatch(); // no prior baseline → installs without event
		const result = await detectChanges(client, watch);

		expect(result.newBaseline.nameTag).toBe("my-vm");
	});

	it("spreads stateTransitionReason into newBaseline when present (L127-129 true branch)", async () => {
		const client = makeClient({
			state: "stopping",
			stateTransitionReason: "User initiated (2024-01-01 00:00:00 GMT)",
		});
		const watch = makeWatch();
		const result = await detectChanges(client, watch);

		expect(result.newBaseline.stateTransitionReason).toBe(
			"User initiated (2024-01-01 00:00:00 GMT)",
		);
	});

	it("spreads availabilityZone into newBaseline when present (L130 true branch)", async () => {
		const client = makeClient({
			state: "running",
			availabilityZone: "us-east-1a",
		});
		const watch = makeWatch();
		const result = await detectChanges(client, watch);

		expect(result.newBaseline.availabilityZone).toBe("us-east-1a");
	});

	it("spreads instanceType into newBaseline when present (L131 true branch)", async () => {
		const client = makeClient({
			state: "running",
			instanceType: "m5.large",
		});
		const watch = makeWatch();
		const result = await detectChanges(client, watch);

		expect(result.newBaseline.instanceType).toBe("m5.large");
	});

	it("spreads all optional fields at once into newBaseline", async () => {
		const launchDate = new Date("2024-03-15T08:00:00.000Z");
		const client = makeClient({
			state: "running",
			nameTag: "full-server",
			stateTransitionReason: "System maintenance",
			availabilityZone: "eu-west-1b",
			instanceType: "c5.xlarge",
			launchTime: launchDate,
		});
		// With prior baseline → triggers state_changed event so we also hit nameTag
		// truthy branch inside buildStateChangedEvent (L51)
		const baseline: Ec2Baseline = { state: "pending" };
		const watch = makeWatch({ baseline });
		const result = await detectChanges(client, watch);

		expect(result.newBaseline.nameTag).toBe("full-server");
		expect(result.newBaseline.stateTransitionReason).toBe("System maintenance");
		expect(result.newBaseline.availabilityZone).toBe("eu-west-1b");
		expect(result.newBaseline.instanceType).toBe("c5.xlarge");
		expect(result.newBaseline.launchTime).toBe(launchDate.toISOString());

		// Should also have emitted a state_changed event with nameTag in label
		expect(result.events[0]!.summary).toContain("full-server");
	});
});
