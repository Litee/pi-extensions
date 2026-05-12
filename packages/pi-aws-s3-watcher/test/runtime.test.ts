import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	makeRuntime,
	POLL_ERROR_THRESHOLD,
	POLL_INTERVAL_MAX_MS,
	POLL_INTERVAL_MS,
	pollOnce,
	startPolling,
	stopPolling,
} from "../src/runtime.js";
import type { HeadObjectResult, S3Client } from "../src/s3-client.js";
import type { S3Watch, TargetCondition } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePi() {
	return {
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => [] as string[],
		events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
	};
}

function makeResolvingClient(resp: HeadObjectResult): S3Client {
	return { headObject: vi.fn().mockResolvedValue(resp) };
}

function makeErrorClient(err: Error): S3Client {
	return { headObject: vi.fn().mockRejectedValue(err) };
}

function makeWatch(target: TargetCondition, baseline?: S3Watch["baseline"]): S3Watch {
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

// ---------------------------------------------------------------------------
// makeRuntime
// ---------------------------------------------------------------------------

describe("makeRuntime", () => {
	it("initialises the scheduler at base interval, stopped", () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ exists: true }));
		expect(rt.scheduler.isRunning).toBe(false);
		expect(rt.scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
	});
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

describe("startPolling / stopPolling", () => {
	it("flips isRunning true/false", () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ exists: true }));
		startPolling(rt);
		expect(rt.scheduler.isRunning).toBe(true);
		stopPolling(rt);
		expect(rt.scheduler.isRunning).toBe(false);
	});

	it("startPolling is idempotent", () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ exists: true }));
		startPolling(rt);
		const first = rt.scheduler.timer;
		startPolling(rt);
		expect(rt.scheduler.timer).toBe(first);
		stopPolling(rt);
	});
});

// ---------------------------------------------------------------------------
// Target firing + single-shot termination
// ---------------------------------------------------------------------------

describe("pollOnce — target fires exactly once and marks terminal", () => {
	it("fires target=exists when the object appears, then stops polling it", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ exists: true, etag: '"a"', contentLength: 1 });
		const rt = makeRuntime(pi, client);
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;

		await pollOnce(rt);
		expect(w.terminal).toBe(true);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const msg = pi.sendMessage.mock.calls[0]![0] as { content: string };
		expect(msg.content).toMatch(/s3:\/\/b\/k now exists/);
	});

	it("does not fire for target=updated when baseline and current are identical", async () => {
		const pi = makePi();
		const client = makeResolvingClient({ exists: true, etag: '"a"', contentLength: 1 });
		const rt = makeRuntime(pi, client);
		const w = makeWatch("updated", { exists: true, etag: '"a"', contentLength: 1 });
		rt.watches[w.watchId] = w;

		await pollOnce(rt);
		expect(w.terminal).toBe(false);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Scheduler reset-on-change
// ---------------------------------------------------------------------------

describe("pollOnce — scheduler back-off behaviour", () => {
	it("idle-doubles when no observable change happened", async () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ exists: false }));
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		const initial = rt.scheduler.idleIntervalMs;
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(initial * 2);
	});

	it("resets to base when the target fires", async () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ exists: true, etag: '"a"', contentLength: 1 }));
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		rt.scheduler.noteSuccess(false);
		rt.scheduler.noteSuccess(false); // push idle up
		expect(rt.scheduler.idleIntervalMs).toBeGreaterThan(POLL_INTERVAL_MS);
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
		expect(rt.scheduler.intervalMs).toBe(POLL_INTERVAL_MS);
	});

	it("resets to base when an intermediate update is observed (even without target fire)", async () => {
		// target=removed, etag changed but object still exists → observable change, no target fire.
		const rt = makeRuntime(makePi(), makeResolvingClient({ exists: true, etag: '"b"', contentLength: 1 }));
		const w = makeWatch("removed", { exists: true, etag: '"a"', contentLength: 1 });
		rt.watches[w.watchId] = w;
		rt.scheduler.noteSuccess(false);
		rt.scheduler.noteSuccess(false);
		expect(rt.scheduler.idleIntervalMs).toBeGreaterThan(POLL_INTERVAL_MS);
		await pollOnce(rt);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MS);
		expect(w.terminal).toBe(false);
	});

	it("idle base is capped at POLL_INTERVAL_MAX_MS", () => {
		const rt = makeRuntime(makePi(), makeResolvingClient({ exists: false }));
		for (let i = 0; i < 30; i++) rt.scheduler.noteSuccess(false);
		expect(rt.scheduler.idleIntervalMs).toBe(POLL_INTERVAL_MAX_MS);
	});
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("pollOnce — timeout", () => {
	it("fires a timeout event and marks the watch terminal without calling S3", async () => {
		const pi = makePi();
		const client = { headObject: vi.fn() };
		const rt = makeRuntime(pi, client);
		rt.now = () => 10_000;
		const w = makeWatch("exists", { exists: false });
		w.timeoutAt = 9_000; // already elapsed
		rt.watches[w.watchId] = w;

		await pollOnce(rt);
		expect(client.headObject).not.toHaveBeenCalled();
		expect(w.terminal).toBe(true);
		const content = (pi.sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toMatch(/timed out waiting for 'exists'/);
	});

	it("does not fire before timeoutAt", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeResolvingClient({ exists: false }));
		rt.now = () => 1_000;
		const w = makeWatch("exists", { exists: false });
		w.timeoutAt = 99_999;
		rt.watches[w.watchId] = w;
		await pollOnce(rt);
		expect(w.terminal).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// All-terminal → stopPolling
// ---------------------------------------------------------------------------

describe("pollOnce — stops the loop once every watch is terminal", () => {
	it("stops scheduler after the final watch fires", async () => {
		const rt = makeRuntime(
			makePi(),
			makeResolvingClient({ exists: true, etag: '"a"', contentLength: 1 }),
		);
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		startPolling(rt);
		await pollOnce(rt);
		expect(rt.scheduler.isRunning).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe("pollOnce — error handling", () => {
	it("records raw error via appendEntry; does not leak into sendMessage until threshold", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeErrorClient(
			Object.assign(new Error("internal discriminator"), { name: "CredentialsProviderError" }),
		));
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		await pollOnce(rt);
		const entry = pi.appendEntry.mock.calls[0]![1] as { message: string };
		expect(entry.message).toContain("internal discriminator");
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("sendMessage at threshold uses sanitized message", async () => {
		const pi = makePi();
		const rt = makeRuntime(pi, makeErrorClient(
			Object.assign(new Error("internal discriminator"), { name: "CredentialsProviderError" }),
		));
		const w = makeWatch("exists", { exists: false });
		w.consecutiveErrors = POLL_ERROR_THRESHOLD - 1;
		rt.watches[w.watchId] = w;
		await pollOnce(rt);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const content = (pi.sendMessage.mock.calls[0]![0] as { content: string }).content;
		expect(content).toMatch(/authentication/);
		expect(content).not.toContain("internal discriminator");
	});

	it("auth error triggers scheduler back-off", async () => {
		const rt = makeRuntime(makePi(), makeErrorClient(
			Object.assign(new Error("token expired"), { name: "CredentialsProviderError" }),
		));
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		const before = rt.scheduler.intervalMs;
		await pollOnce(rt);
		expect(rt.scheduler.intervalMs).toBeGreaterThan(before);
	});

	it("throttle error triggers scheduler back-off", async () => {
		const rt = makeRuntime(makePi(), makeErrorClient(
			Object.assign(new Error("slow down"), { name: "SlowDown" }),
		));
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		const before = rt.scheduler.intervalMs;
		await pollOnce(rt);
		expect(rt.scheduler.intervalMs).toBeGreaterThan(before);
	});
});

// ---------------------------------------------------------------------------
// Re-entry guard
// ---------------------------------------------------------------------------

describe("PollScheduler re-entry guard", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("does not re-enter pollOnce while a previous tick is awaiting", async () => {
		let resolve!: (v: HeadObjectResult) => void;
		const pending = new Promise<HeadObjectResult>((r) => { resolve = r; });
		const head = vi.fn().mockImplementation(() => pending);
		const rt = makeRuntime(makePi(), { headObject: head });
		const w = makeWatch("exists", { exists: false });
		rt.watches[w.watchId] = w;
		startPolling(rt);

		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(head).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
		expect(head).toHaveBeenCalledTimes(1);

		resolve({ exists: false });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		expect(head.mock.calls.length).toBeGreaterThanOrEqual(2);
		stopPolling(rt);
	});
});
