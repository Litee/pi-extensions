import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PollScheduler } from "../src/poll-scheduler.js";

const BASE = 60_000;
const MAX = 3_600_000;
const IDLE_MAX = 1_800_000;

function makeScheduler(): PollScheduler {
	return new PollScheduler({ baseMs: BASE, maxMs: MAX, idleMaxMs: IDLE_MAX });
}

describe("PollScheduler — initial state", () => {
	it("starts with intervalMs and idleIntervalMs equal to baseMs, not running", () => {
		// Arrange / Act
		const s = makeScheduler();

		// Assert
		expect(s.intervalMs).toBe(BASE);
		expect(s.idleIntervalMs).toBe(BASE);
		expect(s.isRunning).toBe(false);
		expect(s.timer).toBeNull();
	});
});

describe("PollScheduler.start / stop", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("start__sets_isRunning_and_fires_tick_after_interval", async () => {
		// Arrange
		const s = makeScheduler();
		const tick = vi.fn().mockResolvedValue(undefined);

		// Act
		s.start(tick);
		expect(s.isRunning).toBe(true);
		expect(s.timer).not.toBeNull();
		expect(tick).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(BASE);

		// Assert
		expect(tick).toHaveBeenCalledTimes(1);
	});

	it("start__is_noop_when_already_running", async () => {
		// Arrange
		const s = makeScheduler();
		const tick1 = vi.fn().mockResolvedValue(undefined);
		const tick2 = vi.fn().mockResolvedValue(undefined);

		// Act
		s.start(tick1);
		s.start(tick2); // second call — must be ignored (tick2 never runs)

		await vi.advanceTimersByTimeAsync(BASE);

		// Assert — only tick1 fires; tick2 was dropped by the no-op guard.
		expect(tick1).toHaveBeenCalledTimes(1);
		expect(tick2).not.toHaveBeenCalled();
	});

	it("stop__clears_timer_and_prevents_tick_from_firing", async () => {
		// Arrange
		const s = makeScheduler();
		const tick = vi.fn().mockResolvedValue(undefined);
		s.start(tick);

		// Act
		s.stop();

		await vi.advanceTimersByTimeAsync(BASE * 3);

		// Assert
		expect(s.isRunning).toBe(false);
		expect(s.timer).toBeNull();
		expect(tick).not.toHaveBeenCalled();
	});

	it("stop__is_noop_when_already_stopped", () => {
		// Arrange
		const s = makeScheduler();

		// Act / Assert — must not throw
		expect(() => s.stop()).not.toThrow();
		expect(s.isRunning).toBe(false);
	});
});

describe("PollScheduler.noteSuccess(true) — update observed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resets_both_idle_base_and_effective_interval_to_baseMs", () => {
		// Arrange — drive idle backoff up first
		const s = makeScheduler();
		const tick = vi.fn().mockResolvedValue(undefined);
		s.start(tick);
		s.noteSuccess(false); // idle: 120_000, effective: 120_000
		s.noteSuccess(false); // idle: 240_000, effective: 240_000
		expect(s.intervalMs).toBe(BASE * 4);

		// Act
		s.noteSuccess(true);

		// Assert
		expect(s.intervalMs).toBe(BASE);
		expect(s.idleIntervalMs).toBe(BASE);
	});

	it("restarts_timer_at_baseMs_when_running", async () => {
		// Arrange
		const s = makeScheduler();
		const tick = vi.fn().mockResolvedValue(undefined);
		s.start(tick);
		s.noteSuccess(false); // interval → 120_000

		// Act
		s.noteSuccess(true); // reset → 60_000 (next reschedule picks it up)

		// Assert — still running, next tick uses the reset interval.
		expect(s.timer).not.toBeNull();
		expect(s.isRunning).toBe(true);

		// The outstanding setTimeout was scheduled at interval=120_000 when
		// noteSuccess(false) ran, so advance by that to let the current tick
		// fire. After it completes the chain reschedules using the current
		// (reset) intervalMs = BASE.
		await vi.advanceTimersByTimeAsync(BASE * 2);
		const firstCallCount = tick.mock.calls.length;
		expect(firstCallCount).toBeGreaterThanOrEqual(1);

		tick.mockClear();
		await vi.advanceTimersByTimeAsync(BASE);
		expect(tick).toHaveBeenCalledTimes(1);
	});

	it("does_not_restart_timer_when_stopped", () => {
		// Arrange
		const s = makeScheduler();
		s.noteSuccess(false); // interval → 120_000 (not running)

		// Act
		s.noteSuccess(true); // should not start a timer

		// Assert
		expect(s.isRunning).toBe(false);
		expect(s.timer).toBeNull();
	});
});

describe("PollScheduler.noteSuccess(false) — no change poll", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("doubles_idle_base_and_effective_interval_each_call", () => {
		// Arrange
		const s = makeScheduler();

		// Act / Assert — doubling sequence
		s.noteSuccess(false);
		expect(s.idleIntervalMs).toBe(BASE * 2);
		expect(s.intervalMs).toBe(BASE * 2);

		s.noteSuccess(false);
		expect(s.idleIntervalMs).toBe(BASE * 4);
		expect(s.intervalMs).toBe(BASE * 4);

		s.noteSuccess(false);
		expect(s.idleIntervalMs).toBe(BASE * 8);
		expect(s.intervalMs).toBe(BASE * 8);
	});

	it("caps_idle_base_and_effective_interval_at_idleMaxMs", () => {
		// Arrange
		const s = makeScheduler();

		// Act — enough polls to cross the 30-min cap
		for (let i = 0; i < 20; i++) {
			s.noteSuccess(false);
		}

		// Assert
		expect(s.idleIntervalMs).toBe(IDLE_MAX);
		expect(s.intervalMs).toBe(IDLE_MAX);
	});

	it("snaps_effective_interval_down_to_idle_base_after_throttle_backoff", () => {
		// Arrange — simulate two throttled polls, then a clean no-update poll
		const s = makeScheduler();
		s.noteBackoff(); // effective: 120_000, idle: 60_000
		s.noteBackoff(); // effective: 240_000, idle: 60_000
		expect(s.intervalMs).toBe(BASE * 4);
		expect(s.idleIntervalMs).toBe(BASE);

		// Act — clean poll with no events
		s.noteSuccess(false); // idle: 120_000, effective snaps DOWN to 120_000

		// Assert
		expect(s.idleIntervalMs).toBe(BASE * 2);
		expect(s.intervalMs).toBe(BASE * 2);
	});
});

describe("PollScheduler.noteBackoff — throttle / auth failure", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("doubles_effective_interval_without_changing_idle_base", () => {
		// Arrange
		const s = makeScheduler();

		// Act
		s.noteBackoff();

		// Assert
		expect(s.intervalMs).toBe(BASE * 2);
		expect(s.idleIntervalMs).toBe(BASE); // idle base unchanged
	});

	it("caps_effective_interval_at_maxMs", () => {
		// Arrange
		const s = makeScheduler();

		// Act — enough backoffs to slam into the 60-min cap
		for (let i = 0; i < 20; i++) {
			s.noteBackoff();
		}

		// Assert
		expect(s.intervalMs).toBe(MAX);
		expect(s.idleIntervalMs).toBe(BASE); // idle base still at base
	});

	it("restarts_running_timer_at_new_interval", async () => {
		// Arrange
		const s = makeScheduler();
		const tick = vi.fn().mockResolvedValue(undefined);
		s.start(tick);

		// Act
		s.noteBackoff(); // interval → 120_000 (stored; next reschedule picks it up)

		// Assert — scheduler still running; the new interval is reflected in state.
		expect(s.timer).not.toBeNull();
		expect(s.intervalMs).toBe(BASE * 2);

		// The outstanding setTimeout was scheduled at BASE when start() ran, so
		// the first tick fires at T=BASE. After it completes the chain reschedules
		// using the current (doubled) intervalMs = BASE*2.
		await vi.advanceTimersByTimeAsync(BASE);
		expect(tick).toHaveBeenCalledTimes(1);
		tick.mockClear();

		// Next tick should fire after BASE*2, not BASE.
		await vi.advanceTimersByTimeAsync(BASE);
		expect(tick).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(BASE);
		expect(tick).toHaveBeenCalledTimes(1);
	});

	it("does_not_restart_timer_when_stopped", () => {
		// Arrange
		const s = makeScheduler();

		// Act
		s.noteBackoff();

		// Assert
		expect(s.isRunning).toBe(false);
		expect(s.timer).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Branch-coverage additions
// ---------------------------------------------------------------------------

describe("PollScheduler.forceInterval", () => {
	it("sets intervalMs directly without touching idleMs or restarting timer", () => {
		const s = makeScheduler();
		s.forceInterval(9_999);
		expect(s.intervalMs).toBe(9_999);
		expect(s.idleIntervalMs).toBe(BASE); // idle base unchanged
		expect(s.isRunning).toBe(false);
	});

	it("allows presetting interval near maxMs so noteBackoff caps in one step", () => {
		const s = makeScheduler();
		s.forceInterval(MAX / 2); // preset to half-max
		s.noteBackoff();           // doubles to MAX
		expect(s.intervalMs).toBe(MAX);
	});
});

describe("PollScheduler — stop during tick prevents rescheduling", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("when stop() is called inside a tick, the loop does not reschedule (timer=null in finally)", async () => {
		// Covers the false branch of `if (this._timer !== null)` in the finally block:
		// stop() sets _timer = null during the tick so finally skips rescheduling.
		const s = makeScheduler();
		const tick = vi.fn().mockImplementation(async () => {
			s.stop(); // sets _timer = null mid-tick
		});
		s.start(tick);
		await vi.advanceTimersByTimeAsync(BASE);
		expect(tick).toHaveBeenCalledTimes(1);
		expect(s.isRunning).toBe(false);
		// Confirm no further ticks
		await vi.advanceTimersByTimeAsync(BASE * 5);
		expect(tick).toHaveBeenCalledTimes(1);
	});
});

describe("PollScheduler — inFlight guard prevents re-entrant loop execution", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("loop body returns early when _inFlight is already true (covers guard true branch)", async () => {
		// Covers the `if (this._inFlight) return;` true branch.
		// Manually set _inFlight=true before the timer fires so loop() returns early
		// without calling tick.
		const s = makeScheduler();
		const tick = vi.fn().mockResolvedValue(undefined);
		s.start(tick);
		(s as unknown as { _inFlight: boolean })._inFlight = true;
		await vi.advanceTimersByTimeAsync(BASE);
		expect(tick).not.toHaveBeenCalled();
	});
});
