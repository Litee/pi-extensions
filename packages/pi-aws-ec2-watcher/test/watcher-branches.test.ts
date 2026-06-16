/**
 * Branch-coverage gap-fill for watcher.ts.
 *
 * Covers the branches not exercised by watcher.test.ts:
 *   - L239-248: Ec2Watcher.snapshot() — never called in existing tests;
 *     covers notFound, !state, and each optional-field if-branch.
 *   - L339: buildChangeChatMessage — unreachable in existing tests because
 *     no test triggers an actual state-change through the poll loop.
 */

import { describe, expect, it, vi } from "vitest";

import type { Ec2Client, InstanceStateResult } from "../src/ec2-client.js";
import type { Ec2Event, Ec2Watch } from "../src/types.js";
import { Ec2Watcher } from "../src/watcher.js";

// ---------------------------------------------------------------------------
// Test helpers (same pattern as watcher.test.ts)
// ---------------------------------------------------------------------------

vi.mock("pi-watcher-core/validate-aws-profile", () => ({
	validateAwsProfile: vi.fn().mockReturnValue(null),
}));

vi.mock("node:fs", () => ({
	readFileSync: vi.fn().mockImplementation(() => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	}),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => [] as string[]),
		setActiveTools: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
	};
}

function makeClient(resp: InstanceStateResult | Error): Ec2Client {
	const describe = vi.fn();
	if (resp instanceof Error) describe.mockRejectedValue(resp);
	else describe.mockResolvedValue(resp);
	return {
		describeInstance: describe,
		stopInstance: vi.fn().mockResolvedValue(undefined),
		startInstance: vi.fn().mockResolvedValue(undefined),
	};
}

function makeWatcher(resp: InstanceStateResult | Error = { state: "running" }) {
	const pi = makePi();
	const client = makeClient(resp);
	const watcher = new Ec2Watcher({ pi: pi as never, client });
	return { watcher, pi, client };
}

function makeBaseWatch(overrides: Partial<Ec2Watch> = {}): Ec2Watch {
	return {
		watchId: "w1",
		instanceId: "i-1234abcd",
		profile: "p",
		region: undefined,
		timeoutAt: undefined,
		addedAt: 0,
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Ec2Watcher.snapshot() — lines 239-248
// ---------------------------------------------------------------------------

describe("Ec2Watcher.snapshot()", () => {
	it("returns { state: 'not_found' } when describeInstance says notFound (L240)", async () => {
		const { watcher } = makeWatcher({ notFound: true });
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as { snapshot(w: Ec2Watch): Promise<{ state: string }> }
		).snapshot(watch);
		expect(result.state).toBe("not_found");
	});

	it("returns { state: 'not_found' } when state is empty/falsy (L241)", async () => {
		// AWS returned a response but state is absent (undefined / empty string).
		const { watcher } = makeWatcher({} /* no state field */);
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as { snapshot(w: Ec2Watch): Promise<{ state: string }> }
		).snapshot(watch);
		expect(result.state).toBe("not_found");
	});

	it("returns baseline with state only when no optional fields (L242 base case)", async () => {
		const { watcher } = makeWatcher({ state: "running" });
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as {
				snapshot(w: Ec2Watch): Promise<import("../src/types.js").Ec2Baseline>;
			}
		).snapshot(watch);
		expect(result.state).toBe("running");
		expect(result.nameTag).toBeUndefined();
		expect(result.stateTransitionReason).toBeUndefined();
		expect(result.availabilityZone).toBeUndefined();
		expect(result.instanceType).toBeUndefined();
		expect(result.launchTime).toBeUndefined();
	});

	it("populates nameTag in baseline when present (L243 true branch)", async () => {
		const { watcher } = makeWatcher({ state: "running", nameTag: "my-app" });
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as {
				snapshot(w: Ec2Watch): Promise<import("../src/types.js").Ec2Baseline>;
			}
		).snapshot(watch);
		expect(result.nameTag).toBe("my-app");
	});

	it("populates stateTransitionReason in baseline when present (L244 true branch)", async () => {
		const { watcher } = makeWatcher({
			state: "stopping",
			stateTransitionReason: "User initiated (2024-01-01 00:00:00 GMT)",
		});
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as {
				snapshot(w: Ec2Watch): Promise<import("../src/types.js").Ec2Baseline>;
			}
		).snapshot(watch);
		expect(result.stateTransitionReason).toBe(
			"User initiated (2024-01-01 00:00:00 GMT)",
		);
	});

	it("populates availabilityZone in baseline when present (L245 true branch)", async () => {
		const { watcher } = makeWatcher({
			state: "running",
			availabilityZone: "us-west-2b",
		});
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as {
				snapshot(w: Ec2Watch): Promise<import("../src/types.js").Ec2Baseline>;
			}
		).snapshot(watch);
		expect(result.availabilityZone).toBe("us-west-2b");
	});

	it("populates instanceType in baseline when present (L246 true branch)", async () => {
		const { watcher } = makeWatcher({ state: "running", instanceType: "t4g.small" });
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as {
				snapshot(w: Ec2Watch): Promise<import("../src/types.js").Ec2Baseline>;
			}
		).snapshot(watch);
		expect(result.instanceType).toBe("t4g.small");
	});

	it("populates launchTime ISO string in baseline when present (L247 true branch)", async () => {
		const launchDate = new Date("2024-05-10T06:30:00.000Z");
		const { watcher } = makeWatcher({ state: "running", launchTime: launchDate });
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as {
				snapshot(w: Ec2Watch): Promise<import("../src/types.js").Ec2Baseline>;
			}
		).snapshot(watch);
		expect(result.launchTime).toBe(launchDate.toISOString());
	});

	it("populates all optional fields when all are present", async () => {
		const launchDate = new Date("2024-06-01T12:00:00.000Z");
		const { watcher } = makeWatcher({
			state: "running",
			nameTag: "full-node",
			stateTransitionReason: "Reboot initiated",
			availabilityZone: "ap-northeast-1a",
			instanceType: "r6i.large",
			launchTime: launchDate,
		});
		const watch = makeBaseWatch();
		const result = await (
			watcher as unknown as {
				snapshot(w: Ec2Watch): Promise<import("../src/types.js").Ec2Baseline>;
			}
		).snapshot(watch);
		expect(result.state).toBe("running");
		expect(result.nameTag).toBe("full-node");
		expect(result.stateTransitionReason).toBe("Reboot initiated");
		expect(result.availabilityZone).toBe("ap-northeast-1a");
		expect(result.instanceType).toBe("r6i.large");
		expect(result.launchTime).toBe(launchDate.toISOString());
	});
});

// ---------------------------------------------------------------------------
// Protected getters: toolLabel, toolDescription, toolParameters (L198-211)
// ---------------------------------------------------------------------------

class ExposedEc2Watcher extends Ec2Watcher {
	get toolLabel_pub() {
		return (this as unknown as { toolLabel: string }).toolLabel
	}
	get toolDescription_pub() {
		return (this as unknown as { toolDescription: string }).toolDescription
	}
	get toolParameters_pub() {
		return (this as unknown as { toolParameters(): unknown }).toolParameters()
	}
}

describe("Ec2Watcher protected getters (L198-211)", () => {
	it("toolLabel returns 'EC2 Instance Watcher' (L198)", () => {
		const pi = makePi()
		const client = makeClient({ state: "running" })
		const w = new ExposedEc2Watcher({ pi: pi as never, client })
		expect(w.toolLabel_pub).toBe("EC2 Instance Watcher")
	})

	it("toolDescription is a non-empty string describing EC2 watching (L201-208)", () => {
		const pi = makePi()
		const client = makeClient({ state: "running" })
		const w = new ExposedEc2Watcher({ pi: pi as never, client })
		expect(typeof w.toolDescription_pub).toBe("string")
		expect(w.toolDescription_pub).toContain("EC2")
	})

	it("toolParameters returns the Ec2WatcherParams schema (L210-211)", () => {
		const pi = makePi()
		const client = makeClient({ state: "running" })
		const w = new ExposedEc2Watcher({ pi: pi as never, client })
		expect(w.toolParameters_pub).toBeDefined()
	})
})

// ---------------------------------------------------------------------------
// addWatch — seed baseline with full optional fields (L421-425)
// ---------------------------------------------------------------------------

describe("Ec2Watcher.addWatch — seed baseline with optional metadata", () => {
	it("sets nameTag on baseline when seed response includes nameTag (L421 true branch)", async () => {
		const { watcher } = makeWatcher({
			state: "running",
			nameTag: "seed-server",
		})
		const result = await watcher.executeTool({
			action: "add",
			instanceId: "i-0a1b2c3d4e5f67890",
			profile: "p",
		})
		expect(result.details["ok"]).toBe(true)
		const watchId = result.details["watchId"] as string
		expect(watcher["baselines"].get(watchId)?.nameTag).toBe("seed-server")
	})

	it("sets stateTransitionReason on baseline when seed response includes it (L422 true branch)", async () => {
		const { watcher } = makeWatcher({
			state: "running",
			stateTransitionReason: "User initiated (2024-01-01)",
		})
		const result = await watcher.executeTool({
			action: "add",
			instanceId: "i-0a1b2c3d4e5f67890",
			profile: "p",
		})
		const watchId = result.details["watchId"] as string
		expect(watcher["baselines"].get(watchId)?.stateTransitionReason).toBe(
			"User initiated (2024-01-01)",
		)
	})

	it("sets availabilityZone on baseline when seed response includes it (L423 true branch)", async () => {
		const { watcher } = makeWatcher({
			state: "running",
			availabilityZone: "ap-south-1a",
		})
		const result = await watcher.executeTool({
			action: "add",
			instanceId: "i-0a1b2c3d4e5f67890",
			profile: "p",
		})
		const watchId = result.details["watchId"] as string
		expect(watcher["baselines"].get(watchId)?.availabilityZone).toBe("ap-south-1a")
	})

	it("sets instanceType on baseline when seed response includes it (L424 true branch)", async () => {
		const { watcher } = makeWatcher({
			state: "running",
			instanceType: "g4dn.xlarge",
		})
		const result = await watcher.executeTool({
			action: "add",
			instanceId: "i-0a1b2c3d4e5f67890",
			profile: "p",
		})
		const watchId = result.details["watchId"] as string
		expect(watcher["baselines"].get(watchId)?.instanceType).toBe("g4dn.xlarge")
	})

	it("sets launchTime ISO string on baseline when seed response includes it (L425 true branch)", async () => {
		const launchDate = new Date("2024-07-04T00:00:00.000Z")
		const { watcher } = makeWatcher({ state: "running", launchTime: launchDate })
		const result = await watcher.executeTool({
			action: "add",
			instanceId: "i-0a1b2c3d4e5f67890",
			profile: "p",
		})
		const watchId = result.details["watchId"] as string
		expect(watcher["baselines"].get(watchId)?.launchTime).toBe(launchDate.toISOString())
	})

	it("includes region in not-found error message when region is specified (L416 ternary true)", async () => {
		const { watcher } = makeWatcher({ notFound: true })
		const result = await watcher.executeTool({
			action: "add",
			instanceId: "i-0a1b2c3d4e5f67890",
			profile: "p",
			region: "eu-central-1",
		})
		expect(result.details["ok"]).toBe(false)
		expect((result.content[0] as { text: string }).text).toContain("eu-central-1")
	})
})

// ---------------------------------------------------------------------------
// startPolling — terminal watch skipped (L536 true branch)
// ---------------------------------------------------------------------------

describe("Ec2Watcher.startPolling — terminal watch is skipped", () => {
	it("does not create a scheduler for a terminal watch (L536 continue branch)", async () => {
		vi.useFakeTimers()
		const { watcher } = makeWatcher({ state: "running" })

		// Add a watch, then mark it terminal before startPolling
		const addResult = await watcher.executeTool({
			action: "add",
			instanceId: "i-0a1b2c3d4e5f67890",
			profile: "p",
		})
		const watchId = addResult.details["watchId"] as string
		const watch = watcher["watches"].get(watchId)!
		watcher.stopPolling()

		// Mark the watch as terminal and clear its scheduler
		watch.terminal = true
		watcher["_watchSchedulers"].delete(watchId)

		// startPolling should skip the terminal watch
		watcher.startPolling()

		const schedulers = watcher[
			"_watchSchedulers"
		] as Map<string, { isRunning: boolean }>
		// No scheduler should have been created for the terminal watch
		expect(schedulers.has(watchId)).toBe(false)

		watcher.stopPolling()
		vi.useRealTimers()
	})
})

// ---------------------------------------------------------------------------
// Ec2Watcher.buildChangeChatMessage() — line 339
// ---------------------------------------------------------------------------

describe("Ec2Watcher.buildChangeChatMessage()", () => {
	it("delegates to format.buildChangeChatMessage and returns the formatted string (L339)", () => {
		const { watcher } = makeWatcher();
		const events: Ec2Event[] = [
			{
				watchId: "w1",
				instanceId: "i-1234abcd",
				eventType: "state_changed",
				previousState: "pending",
				newState: "running",
				summary: "i-1234abcd: pending → running",
				formatted: "• i-1234abcd: pending → running",
				isTerminal: false,
			},
		];
		const date = new Date(2024, 0, 15, 14, 30);
		const msg = watcher.buildChangeChatMessage(events, date);

		expect(msg).toContain("1 change detected");
		expect(msg).toContain("• i-1234abcd: pending → running");
	});

	it("handles plural events correctly", () => {
		const { watcher } = makeWatcher();
		const events: Ec2Event[] = [
			{
				watchId: "w1",
				instanceId: "i-aaa",
				eventType: "state_changed",
				previousState: "pending",
				newState: "running",
				summary: "",
				formatted: "• i-aaa: pending → running",
				isTerminal: false,
			},
			{
				watchId: "w2",
				instanceId: "i-bbb",
				eventType: "timeout",
				previousState: "",
				newState: "",
				summary: "",
				formatted: "• i-bbb: timed out ✗",
				isTerminal: true,
			},
		];
		const msg = watcher.buildChangeChatMessage(events, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("2 changes detected");
	});
});
