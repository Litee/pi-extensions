/**
 * AwsBaseWatcher — abstract base class for AWS watcher extensions.
 *
 * Extends `BaseWatcher` with the boilerplate that is byte-identical across
 * pi-aws-ec2-watcher, pi-aws-s3-watcher, and pi-aws-glue-watcher:
 *
 *  - Per-watch `PollScheduler` management (`_watchSchedulers`, `schedulerFor`,
 *    `noteSchedulerSuccess`, `startPolling`, `stopPolling`).
 *  - `classifyError` delegating to the full AWS auth/throttle name sets
 *    (fixes a latent Glue bug where `ExpiredToken`, `ExpiredTokenException`,
 *    `SlowDown`, and `RequestLimitExceeded` were missing).
 *  - `addWatch` skeleton: validate profile → extract region → validateAwsProfile
 *    → mint ID → domain-specific parse → snapshot → optional post-seed
 *    validation → insert → start scheduler → return message.
 *  - `mintWatchId()` protected helper.
 *
 * ## How to subclass
 *
 * 1. Extend `AwsBaseWatcher<TWatch, TBaseline, TEvent>` instead of
 *    `BaseWatcher`.
 * 2. Implement all abstract methods from `BaseWatcher` as usual.
 * 3. Implement `parseAddParams`, `describeAddedWatch`.
 * 4. Optionally override `validateAfterSeed`, `awsAuthMessage`,
 *    `schedulerBaseMs`, `schedulerMaxMs`, `startupDelayMsForIndex`.
 */

import { BASE_POLL_MS, BaseWatcher, MAX_POLL_MS } from '../base-watcher.js'
import { PollScheduler } from '../poll-scheduler.js'
import { mintWatchId as _mintWatchId } from '../mint-watch-id.js'
import { classifyAwsError } from './classify-error.js'
import type { ClassifiedWatcherError } from '../classify-error.js'
import type { ToolResult, WatchLike } from '../base-watcher-types.js'

// ---------------------------------------------------------------------------
// Minimum shape for AWS watch objects
// ---------------------------------------------------------------------------

/**
 * Minimum fields every `TWatch` must have in an AWS watcher.
 * In addition to the base `WatchLike` contract, AWS watches always carry a
 * `watchId`, `profile`, optional `region`, and timestamps.
 */
export interface AwsWatchBase extends WatchLike {
  watchId: string
  profile: string
  region: string | undefined
  addedAt: number
  lastPolledAt: number | undefined
}

// ---------------------------------------------------------------------------
// Parameters passed from the shared addWatch skeleton to parseAddParams
// ---------------------------------------------------------------------------

/**
 * Pre-validated base parameters provided by `AwsBaseWatcher.addWatch` to
 * the domain-specific `parseAddParams` implementation.
 */
export interface AwsAddBaseParams {
  /** Trimmed, non-empty profile name (already validated with `validateAwsProfile`). */
  profile: string
  /** Trimmed region, or `undefined` when not supplied. */
  region: string | undefined
  /** Pre-minted watch ID for this watch. */
  watchId: string
}

// ---------------------------------------------------------------------------
// Abstract class
// ---------------------------------------------------------------------------

export abstract class AwsBaseWatcher<
  TWatch extends AwsWatchBase,
  TBaseline,
  TEvent,
> extends BaseWatcher<TWatch, TBaseline, TEvent> {

  // ── Per-watch scheduler storage (protected so subclasses can reach it) ───

  protected readonly _watchSchedulers = new Map<string, PollScheduler>()

  // ── classifyError ─────────────────────────────────────────────────────────

  override classifyError(err: unknown): ClassifiedWatcherError {
    return classifyAwsError(err, this.awsAuthMessage())
  }

  /**
   * Optional override for the auth-error user message.
   * Default: `"authentication expired — refresh AWS credentials"`.
   * Override (e.g. in Glue) to provide service-specific guidance.
   */
  protected awsAuthMessage(): string {
    return 'authentication expired — refresh AWS credentials'
  }

  // ── Scheduler configuration hooks ─────────────────────────────────────────

  /**
   * Base poll interval for newly created schedulers.
   * Default: `BASE_POLL_MS` (60 s).
   * Override in Glue to use the per-watch `pollIntervalMs`.
   */
  protected schedulerBaseMs(_watchKey: string): number {
    return BASE_POLL_MS
  }

  /**
   * Maximum poll interval for schedulers.
   * Default: `MAX_POLL_MS` (15 min).
   * Override in Glue to use `POLL_INTERVAL_MAX_MS`.
   */
  protected schedulerMaxMs(): number {
    return MAX_POLL_MS
  }

  /**
   * Startup stagger delay for `startPolling` in milliseconds.
   * Called with the slot index `i` (0-based, counting all non-terminal
   * watches including already-running ones).
   * Default: 0 (no stagger). Override in Glue to return `i * 2000`.
   */
  protected startupDelayMsForIndex(_i: number): number {
    return 0
  }

  // ── Per-watch scheduler management ───────────────────────────────────────

  /**
   * Return (or lazily create) the `PollScheduler` for `watchKey`.
   * Uses `schedulerBaseMs` and `schedulerMaxMs` for sizing so subclasses
   * only need to override those hooks, not the whole `schedulerFor` method.
   */
  protected override schedulerFor(watchKey: string): PollScheduler {
    let s = this._watchSchedulers.get(watchKey)
    if (s === undefined) {
      const baseMs = this.schedulerBaseMs(watchKey)
      const maxMs = this.schedulerMaxMs()
      s = new PollScheduler({ baseMs, maxMs, idleMaxMs: maxMs })
      this._watchSchedulers.set(watchKey, s)
    }
    return s
  }

  protected override noteSchedulerSuccess(anyChange: boolean, watchKey: string): void {
    this.schedulerFor(watchKey).noteSuccess(anyChange)
  }

  /**
   * Start polling for all non-terminal watches.
   *
   * Watches are started with an optional stagger determined by
   * `startupDelayMsForIndex(i)` where `i` is the slot index of the watch
   * in the non-terminal list (including already-running slots, matching the
   * Glue startup behaviour).
   */
  override startPolling(): void {
    let i = 0
    for (const [key, watch] of this.watches) {
      if (watch.terminal) continue
      const s = this.schedulerFor(key)
      const delay = this.startupDelayMsForIndex(i)
      if (!s.isRunning) {
        if (delay > 0) {
          const captured = s
          setTimeout(() => {
            if (this._watchSchedulers.get(key) === captured && !captured.isRunning) {
              captured.start(() => this.pollWatch(key))
            }
          }, delay)
        } else {
          s.start(() => this.pollWatch(key))
        }
      }
      i++
    }
  }

  /** Stop all per-watch schedulers. */
  override stopPolling(): void {
    for (const s of this._watchSchedulers.values()) s.stop()
  }

  // ── mintWatchId ───────────────────────────────────────────────────────────

  /** Generate a random watch ID (delegates to the shared utility). */
  protected mintWatchId(): string {
    return _mintWatchId()
  }

  // ── addWatch skeleton ─────────────────────────────────────────────────────

  /**
   * Parse domain-specific `add` parameters and construct the watch object.
   *
   * Called by the base `addWatch` after the common pre-validation
   * (profile trim/non-empty, `validateAwsProfile`, region extraction, ID
   * minting) has already run.
   *
   * @param params  Raw tool params as received by `executeTool`.
   * @param base    Pre-validated common fields (profile, region, watchId).
   * @returns       `{watch}` on success, or `{error: ToolResult}` to abort.
   */
  protected abstract parseAddParams(
    params: Record<string, unknown>,
    base: AwsAddBaseParams,
  ): Promise<{ watch: TWatch } | { error: ToolResult }>

  /**
   * Build the user-facing success (or partial-failure) message for the
   * `add` response.
   *
   * @param params     Original raw params (available for e.g. the "capped" note).
   * @param watch      The fully constructed watch object (post-parse, pre-insert).
   * @param baseline   The seeded baseline, or `undefined` if seeding threw.
   * @param seedError  The seeding exception message when snapshot threw; otherwise `undefined`.
   */
  protected abstract describeAddedWatch(
    params: Record<string, unknown>,
    watch: TWatch,
    baseline: TBaseline | undefined,
    seedError: string | undefined,
  ): string

  /**
   * Optional post-seed validation hook.
   *
   * Called after `snapshot(watch)` succeeds (i.e. `baseline` is defined).
   * Return a `ToolResult` to abort the add (watch will NOT be inserted),
   * or `null` to proceed.
   *
   * Use cases:
   *  - EC2: reject if `baseline.state === "not_found"`.
   *  - S3: reject if `target === "modification"` and object is currently absent.
   */
  protected validateAfterSeed?(
    watch: TWatch,
    baseline: TBaseline,
  ): ToolResult | null

  /**
   * Shared `addWatch` skeleton.
   *
   * 1. Trim + validate profile (non-empty check + `validateAwsProfile`).
   * 2. Extract region.
   * 3. Mint a watch ID.
   * 4. Call `parseAddParams` for domain-specific construction.
   * 5. Call `snapshot(watch)` to seed the baseline.
   * 6. Call `validateAfterSeed` (if defined) — abort on non-null result.
   * 7. Insert into `this.watches` and `this.baselines`.
   * 8. Start the per-watch scheduler.
   * 9. Return the result of `describeAddedWatch`.
   */
  override async addWatch(params: Record<string, unknown>): Promise<ToolResult> {
    const profile = (typeof params['profile'] === 'string' ? params['profile'] : '').trim()
    if (!profile) return this._toolError("'add' requires a profile.")

    const region =
      typeof params['region'] === 'string' && params['region'].trim()
        ? params['region'].trim()
        : undefined

    const watchId = this.mintWatchId()

    const parseResult = await this.parseAddParams(params, { profile, region, watchId })
    if ('error' in parseResult) return parseResult.error
    const { watch } = parseResult

    let baseline: TBaseline | undefined
    let seedError: string | undefined
    try {
      baseline = await this.snapshot(watch)
    } catch (err) {
      seedError = (err as Error).message
    }

    if (baseline !== undefined && this.validateAfterSeed !== undefined) {
      const vErr = this.validateAfterSeed(watch, baseline)
      if (vErr !== null) return vErr
    }

    this.watches.set(watchId, watch)
    if (baseline !== undefined) this.baselines.set(watchId, baseline)

    const s = this.schedulerFor(watchId)
    if (!s.isRunning) s.start(() => this.pollWatch(watchId))

    const message = this.describeAddedWatch(params, watch, baseline, seedError)
    return {
      content: [{ type: 'text', text: message }],
      details: { action: 'add', ok: true, message, watchId, watches: Array.from(this.watches.keys()) },
    }
  }
}
