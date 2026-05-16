import { describe, it, expect, vi } from "vitest";
import {
	noteWatchSuccess,
	noteWatchFailure,
	DEFAULT_POLL_ERROR_THRESHOLD,
	type WatchLike,
} from "../src/error-tracker.js";
import { PollScheduler } from "../src/poll-scheduler.js";

function makeWatch(errors = 0): WatchLike {
	return { consecutiveErrors: errors };
}

function makeScheduler(): PollScheduler {
	return new PollScheduler({ baseMs: 1000, maxMs: 60_000, idleMaxMs: 60_000 });
}

describe("DEFAULT_POLL_ERROR_THRESHOLD", () => {
	it("is 5", () => {
		expect(DEFAULT_POLL_ERROR_THRESHOLD).toBe(5);
	});
});

describe("noteWatchSuccess", () => {
	it("resets consecutiveErrors to 0 always", () => {
		const w = makeWatch(3);
		noteWatchSuccess(w, { onRecover: vi.fn() });
		expect(w.consecutiveErrors).toBe(0);
	});

	it("does not call onRecover when prevErrors is 0", () => {
		const w = makeWatch(0);
		const onRecover = vi.fn();
		noteWatchSuccess(w, { onRecover });
		expect(onRecover).not.toHaveBeenCalled();
	});

	it("does not call onRecover when prevErrors is below threshold (4)", () => {
		const w = makeWatch(4);
		const onRecover = vi.fn();
		noteWatchSuccess(w, { onRecover });
		expect(onRecover).not.toHaveBeenCalled();
	});

	it("calls onRecover when prevErrors equals threshold (5)", () => {
		const w = makeWatch(5);
		const onRecover = vi.fn();
		noteWatchSuccess(w, { onRecover });
		expect(onRecover).toHaveBeenCalledOnce();
		expect(onRecover).toHaveBeenCalledWith(5);
	});

	it("calls onRecover when prevErrors exceeds threshold (10)", () => {
		const w = makeWatch(10);
		const onRecover = vi.fn();
		noteWatchSuccess(w, { onRecover });
		expect(onRecover).toHaveBeenCalledOnce();
		expect(onRecover).toHaveBeenCalledWith(10);
	});

	it("respects custom threshold", () => {
		const onRecover = vi.fn();
		const w3 = makeWatch(3);
		noteWatchSuccess(w3, { threshold: 3, onRecover });
		expect(onRecover).toHaveBeenCalledWith(3);

		const w2 = makeWatch(2);
		const onRecover2 = vi.fn();
		noteWatchSuccess(w2, { threshold: 3, onRecover: onRecover2 });
		expect(onRecover2).not.toHaveBeenCalled();
	});
});

describe("noteWatchFailure", () => {
	it("increments consecutiveErrors", () => {
		const w = makeWatch(0);
		const scheduler = makeScheduler();
		noteWatchFailure(w, {
			err: new Error("boom"),
			classifyOpts: {},
			scheduler,
			onAppendError: vi.fn(),
			onThresholdMessage: vi.fn(),
		});
		expect(w.consecutiveErrors).toBe(1);
	});

	it("calls onAppendError with classified error and raw error", () => {
		const w = makeWatch(0);
		const scheduler = makeScheduler();
		const raw = new Error("boom");
		const onAppendError = vi.fn();
		noteWatchFailure(w, {
			err: raw,
			classifyOpts: {},
			scheduler,
			onAppendError,
			onThresholdMessage: vi.fn(),
		});
		expect(onAppendError).toHaveBeenCalledOnce();
		const [classified, passedRaw] = onAppendError.mock.calls[0] as [unknown, unknown];
		expect(passedRaw).toBe(raw);
		expect((classified as { kind: string }).kind).toBe("generic");
	});

	it("calls scheduler.noteBackoff() for auth errors (shouldBackoff=true)", () => {
		const w = makeWatch(0);
		const scheduler = makeScheduler();
		const backoffSpy = vi.spyOn(scheduler, "noteBackoff");
		const authErr = Object.assign(new Error("creds"), { name: "CredentialsProviderError" });
		noteWatchFailure(w, {
			err: authErr,
			classifyOpts: {
				authPredicate: (e) => (e as Error)?.name === "CredentialsProviderError",
			},
			scheduler,
			onAppendError: vi.fn(),
			onThresholdMessage: vi.fn(),
		});
		expect(backoffSpy).toHaveBeenCalledOnce();
	});

	it("does NOT call scheduler.noteBackoff() for not-found errors (shouldBackoff=false)", () => {
		const w = makeWatch(0);
		const scheduler = makeScheduler();
		const backoffSpy = vi.spyOn(scheduler, "noteBackoff");
		const notFoundErr = Object.assign(new Error("404"), { name: "NoSuchKey" });
		noteWatchFailure(w, {
			err: notFoundErr,
			classifyOpts: {
				notFoundPredicate: (e) => (e as Error)?.name === "NoSuchKey",
			},
			scheduler,
			onAppendError: vi.fn(),
			onThresholdMessage: vi.fn(),
		});
		expect(backoffSpy).not.toHaveBeenCalled();
	});

	it("does not call onThresholdMessage below threshold (4 errors)", () => {
		const onThresholdMessage = vi.fn();
		const w = makeWatch(3); // will become 4 after increment
		const scheduler = makeScheduler();
		noteWatchFailure(w, {
			err: new Error("x"),
			classifyOpts: {},
			scheduler,
			onAppendError: vi.fn(),
			onThresholdMessage,
		});
		expect(w.consecutiveErrors).toBe(4);
		expect(onThresholdMessage).not.toHaveBeenCalled();
	});

	it("calls onThresholdMessage exactly when counter hits threshold (5)", () => {
		const onThresholdMessage = vi.fn();
		const w = makeWatch(4); // will become 5 after increment
		const scheduler = makeScheduler();
		noteWatchFailure(w, {
			err: new Error("x"),
			classifyOpts: {},
			scheduler,
			onAppendError: vi.fn(),
			onThresholdMessage,
		});
		expect(w.consecutiveErrors).toBe(5);
		expect(onThresholdMessage).toHaveBeenCalledOnce();
	});

	it("does not call onThresholdMessage above threshold (6)", () => {
		const onThresholdMessage = vi.fn();
		const w = makeWatch(5); // will become 6 after increment
		const scheduler = makeScheduler();
		noteWatchFailure(w, {
			err: new Error("x"),
			classifyOpts: {},
			scheduler,
			onAppendError: vi.fn(),
			onThresholdMessage,
		});
		expect(w.consecutiveErrors).toBe(6);
		expect(onThresholdMessage).not.toHaveBeenCalled();
	});

	it("respects custom threshold", () => {
		const onThresholdMessage = vi.fn();
		const w = makeWatch(2); // will become 3 after increment
		const scheduler = makeScheduler();
		noteWatchFailure(w, {
			err: new Error("x"),
			classifyOpts: {},
			scheduler,
			onAppendError: vi.fn(),
			onThresholdMessage,
			threshold: 3,
		});
		expect(w.consecutiveErrors).toBe(3);
		expect(onThresholdMessage).toHaveBeenCalledOnce();
	});
});
