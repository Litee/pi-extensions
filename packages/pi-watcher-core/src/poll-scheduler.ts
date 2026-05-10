/**
 * Generic poll-interval state machine.
 *
 * Manages a setInterval-based poll loop with three distinct back-off
 * behaviours:
 *
 *   - **Idle back-off**: after each poll that finds no changes, the idle base
 *     doubles (up to {@link PollSchedulerOptions.idleMaxMs}), and the
 *     effective interval snaps to the idle base. This undoes any throttle
 *     overhead once the server starts responding normally again.
 *
 *   - **Throttle / auth back-off**: doubles the effective interval (up to
 *     {@link PollSchedulerOptions.maxMs}) without touching the idle base.
 *     Call {@link PollScheduler.noteBackoff} on every throttle or auth error.
 *
 *   - **Update reset**: when a poll finds at least one change, both the idle
 *     base and the effective interval snap back to
 *     {@link PollSchedulerOptions.baseMs} so the next poll fires quickly.
 *
 * The tick function is supplied once at {@link PollScheduler.start} time and
 * is stored internally so the timer can be restarted transparently when the
 * effective interval changes.
 */

export interface PollSchedulerOptions {
	/** Base poll interval in ms. Also the reset target after an update. */
	baseMs: number;
	/** Ceiling for throttle / auth back-off (never exceeded by noteBackoff). */
	maxMs: number;
	/** Ceiling for idle back-off (never exceeded by noteSuccess(false)). */
	idleMaxMs: number;
}

export class PollScheduler {
	private readonly _baseMs: number;
	private readonly _maxMs: number;
	private readonly _idleMaxMs: number;
	private _intervalMs: number;
	private _idleMs: number;
	private _timer: ReturnType<typeof setTimeout> | null = null;
	private _inFlight = false;

	constructor(opts: PollSchedulerOptions) {
		this._baseMs = opts.baseMs;
		this._maxMs = opts.maxMs;
		this._idleMaxMs = opts.idleMaxMs;
		this._intervalMs = opts.baseMs;
		this._idleMs = opts.baseMs;
	}

	/** Current effective poll interval in ms. */
	get intervalMs(): number {
		return this._intervalMs;
	}

	/** Current idle back-off base in ms. */
	get idleIntervalMs(): number {
		return this._idleMs;
	}

	/** Whether the poll loop is currently running. */
	get isRunning(): boolean {
		return this._timer !== null;
	}

	/**
	 * Raw timer handle — exposed for tests that verify the timer was replaced
	 * (stop + start) by comparing references.
	 */
	get timer(): ReturnType<typeof setTimeout> | null {
		return this._timer;
	}

	/**
	 * Start the poll loop. No-op if already running.
	 *
	 * Uses a self-chained `setTimeout` with an `_inFlight` guard so that a
	 * tick that parks on an internal `await` (e.g. throttle back-off sleep)
	 * cannot be re-entered by the timer. The next tick is scheduled from the
	 * END of the previous tick rather than at a fixed wall-clock boundary.
	 */
	start(tick: () => Promise<void>): void {
		if (this._timer !== null) return;
		const loop = async (): Promise<void> => {
			// Defensive: the setTimeout chain should never re-enter while a prior
			// tick is still awaiting, but guard anyway so a rogue external caller
			// can't double-invoke.
			if (this._inFlight) return;
			this._inFlight = true;
			try {
				await tick();
			} finally {
				this._inFlight = false;
				// Only reschedule if we haven't been stopped during the tick.
				if (this._timer !== null) {
					this._timer = setTimeout(() => {
						void loop();
					}, this._intervalMs);
				}
			}
		};
		this._timer = setTimeout(() => {
			void loop();
		}, this._intervalMs);
	}

	/** Stop the poll loop. No-op if already stopped. */
	stop(): void {
		if (this._timer !== null) {
			clearTimeout(this._timer);
			this._timer = null;
		}
	}

	/**
	 * Call after a successful poll.
	 *
	 * - `hadEvents = true`: reset idle base to {@link baseMs} and snap the
	 *   effective interval back to base.
	 * - `hadEvents = false`: double the idle base (capped at
	 *   {@link idleMaxMs}), then snap the effective interval down to the
	 *   current idle base — this undoes any throttle overhead once the server
	 *   recovers.
	 */
	noteSuccess(hadEvents: boolean): void {
		if (hadEvents) {
			this._idleMs = this._baseMs;
			this._applyInterval(this._baseMs);
		} else {
			this._idleMs = Math.min(this._idleMs * 2, this._idleMaxMs);
			this._applyInterval(this._idleMs);
		}
	}

	/**
	 * Call after a throttle or auth failure.
	 * Doubles the effective interval (capped at {@link maxMs}).
	 * Does NOT touch the idle base.
	 */
	noteBackoff(): void {
		this._applyInterval(Math.min(this._intervalMs * 2, this._maxMs));
	}

	/**
	 * Force the effective interval to `ms` without restarting the timer or
	 * touching the idle base. Intended for tests that need to preset the
	 * interval close to a cap so back-off assertions don't require iterating
	 * through many doublings.
	 *
	 * @internal Not part of the public API. Do not call from production code.
	 */
	forceInterval(ms: number): void {
		this._intervalMs = ms;
	}

	private _applyInterval(nextMs: number): void {
		// The setTimeout chain in start() reads `_intervalMs` each time it
		// schedules the next tick, so we just store the new value and the next
		// reschedule picks it up naturally — no clear/replace dance needed.
		this._intervalMs = nextMs;
	}
}
