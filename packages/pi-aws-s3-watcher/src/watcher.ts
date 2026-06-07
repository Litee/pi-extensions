/**
 * S3Watcher — pi-aws-s3-watcher implemented via BaseWatcher.
 *
 * Wires S3-specific snapshot / change-detection / rendering into the shared
 * BaseWatcher poll loop, persistence, and menu machinery.
 */

import { randomBytes } from 'node:crypto'

import { BaseWatcher, BASE_POLL_MS, MAX_POLL_MS, POLL_ERROR_THRESHOLD } from 'pi-watcher-core/base-watcher'
import { validateAwsProfile } from 'pi-watcher-core/validate-aws-profile'
import { PollScheduler } from 'pi-watcher-core/poll-scheduler'
import { createWatcherWidget } from 'pi-watcher-core/watcher-widget'
import type { ClassifiedWatcherError } from 'pi-watcher-core/classify-error'
import type {
  BaseWatcherOptions,
  BrowseViewOptions,
  DetailField,
  RowColumn,
  ToolResult,
  WatcherView,
} from 'pi-watcher-core/base-watcher-types'

import {
  buildChangeChatMessage as formatChangeChatMessage,
} from './format.js'
import { buildTimeoutEvent, detectChanges as pollerDetectChanges, snapshotObject } from './poller.js'
import type { S3Client } from './s3-client.js'
import { MAX_TIMEOUT_SECONDS, S3WatcherParams, TARGETS } from './toolAction.js'
import type { S3Baseline, S3Event, S3Watch } from './types.js'
import { compressS3Uri, parseS3Uri, S3UriError } from './uri.js'

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Format the time remaining until a timeout, or special labels for
 * undefined / expired timeouts.
 */
export function formatTimeLeft(timeoutAt: number | undefined, now: number): string {
  if (timeoutAt === undefined) return '-'
  const remainingMs = timeoutAt - now
  if (remainingMs <= 0) return 'expired'
  const s = Math.ceil(remainingMs / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rem = s % 60
  if (h >= 1) return `${h}h left`
  if (m >= 1) return `${m}m left`
  return `${rem}s left`
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const AUTH_ERROR_NAMES = new Set([
  'CredentialsProviderError',
  'TokenProviderError',
  'ProviderError',
  'ExpiredToken',
  'ExpiredTokenException',
])

const THROTTLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'SlowDown',
  'RequestLimitExceeded',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFiniteNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function normaliseBaselineField(raw: unknown): S3Baseline | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r['exists'] !== 'boolean') return undefined
  const b: S3Baseline = { exists: r['exists'] }
  if (typeof r['etag'] === 'string') b.etag = r['etag']
  if (typeof r['contentLength'] === 'number' && Number.isFinite(r['contentLength'])) {
    b.contentLength = r['contentLength']
  }
  return b
}

// ---------------------------------------------------------------------------
// S3Watcher
// ---------------------------------------------------------------------------

export class S3Watcher extends BaseWatcher<S3Watch, S3Baseline, S3Event> {
  // ── Identity ───────────────────────────────────────────────────────────────
  readonly extensionName = 'pi-aws-s3-watcher'
  readonly toolName = 's3_watcher'

  get itemSource() {
    return 'user-tool' as const
  }
  get hasWidget() {
    return true
  }

  // ── View ───────────────────────────────────────────────────────────────────
  readonly view: WatcherView<S3Watch, S3Event> = {
    noun: 'S3 object',
    nounPlural: 'S3 objects',

    itemSortKey: (w) => `${w.bucket}/${w.key}`,
    itemGroup: (w) => w.bucket,

    renderItemRowText(w) {
      const statusText = w.terminal ? 'DONE' : w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? 'ERROR' : 'WATCHING'
      const timeLeft = formatTimeLeft(w.timeoutAt, Date.now())
      return `s3://${w.bucket}/${w.key}  ${statusText}  ${timeLeft}  ${w.target}`
    },

    renderItemRowTUI(w, _ctx): RowColumn[] {
      const uriColor = w.consecutiveErrors >= POLL_ERROR_THRESHOLD
        ? 'warning'
        : 'accent'
      const statusText = w.terminal ? 'DONE' : w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? 'ERROR' : 'WATCHING'
      const statusColor = w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? 'error' : 'warning'
      const timeLeft = formatTimeLeft(w.timeoutAt, Date.now())
      const timeColor: string = w.timeoutAt !== undefined && w.timeoutAt - Date.now() < 5 * 60 * 1000
        ? 'warning'
        : 'dim'
      return [
        { name: 'uri',     text: `s3://${w.bucket}/${w.key}`, color: uriColor },
        { name: 'status',  text: statusText,              width: 10, color: statusColor },
        { name: 'timeout', text: timeLeft,                width: 10, color: timeColor },
        { name: 'target',  text: w.target, width: 10, color: 'dim' },
      ]
    },

    renderItemDetail(w, ctx): DetailField[] {
      const state =
        w.baseline === undefined ? 'unknown' : w.baseline.exists ? 'present' : 'absent'
      return [
        { label: 'uri',      value: `s3://${w.bucket}/${w.key}` },
        { label: 'target',   value: w.target },
        { label: 'profile',  value: w.profile },
        { label: 'region',   value: w.region ?? 'default' },
        { label: 'state',    value: state },
        { label: 'added',    value: new Date(w.addedAt).toISOString() },
        { label: 'polled',   value: w.lastPolledAt !== undefined ? new Date(w.lastPolledAt).toISOString() : 'never' },
        { label: 'timeout',  value: w.timeoutAt !== undefined ? new Date(w.timeoutAt).toISOString() : 'none' },
        { label: 'poll',     value: ctx.pollIntervalMs !== undefined ? `${Math.round(ctx.pollIntervalMs / 1000)}s` : 'unknown' },
        { label: 'errors',   value: String(w.consecutiveErrors) },
        { label: 'terminal', value: w.terminal ? 'yes' : 'no' },
      ]
    },

    renderEventRow(e) {
      return e.formatted
    },

    isRowDimmed: (w: S3Watch) => w.terminal,

    compressColumns(cols: RowColumn[], totalWidth: number): RowColumn[] {
      const SEP = 2
      const fixedTotal = cols
        .filter(c => c.width !== undefined)
        .reduce((sum, c) => sum + c.width!, 0)
      const separators = (cols.length - 1) * SEP
      const uriWidth = totalWidth - fixedTotal - separators

      return cols.map(c => {
        if (c.name !== 'uri') return c
        const compressed = compressS3Uri(c.text, uriWidth)
        return compressed === c.text ? c : { ...c, text: compressed }
      })
    },
  }

  // ── Tool metadata ──────────────────────────────────────────────────────────
  protected override get toolLabel(): string {
    return 'AWS S3 Watcher'
  }

  protected override get toolDescription(): string {
    return (
      'Watch an S3 object URI for existence, update, or removal. ' +
      'Polls HeadObject at increasing intervals (60s → 15min) and fires ' +
      'exactly one chat notification when the target condition is met ' +
      '(or when an optional timeout elapses). ' +
      'Actions: add, remove, list, status.'
    )
  }

  protected override toolParameters(): unknown {
    return S3WatcherParams
  }

  protected override get statusLabel(): string { return 'aws-s3' }
  protected override get displayName(): string { return 'AWS S3 Watcher' }
  protected override get commandName(): string { return 'aws-s3-watcher' }

  // ── Constructor ────────────────────────────────────────────────────────────
  constructor(opts: BaseWatcherOptions & { client: S3Client }) {
    super({ ...opts, client: opts.client })
    this.widget = createWatcherWidget(opts.pi.events, this.view, {
      extensionName: this.extensionName,
      displayName: this.displayName,
      commandName: this.commandName,
      getWatches: () => Array.from(this.watches.values()),
    })
    const { defaultDisplayMode } = this.loadWatcherConfig()
    if (defaultDisplayMode !== undefined) {
      this.defaultDisplayMode = defaultDisplayMode
    }
  }

  // ── Domain hooks ───────────────────────────────────────────────────────────
  watchKey(watch: S3Watch): string {
    return watch.watchId
  }

  async snapshot(watch: S3Watch): Promise<S3Baseline> {
    return snapshotObject(this._client as S3Client, watch)
  }

  async detectChanges(watch: S3Watch): Promise<{
    newBaseline: S3Baseline
    events: S3Event[]
    observedChange: boolean
  }> {
    const nowTs = this._now()
    if (watch.timeoutAt !== undefined && nowTs >= watch.timeoutAt) {
      return {
        newBaseline: this.baselines.get(this.watchKey(watch)) ?? { exists: false },
        events: [buildTimeoutEvent(watch)],
        observedChange: true,
      }
    }
    // Sync base-class baseline into watch record so poller can read it
    watch.baseline = this.baselines.get(this.watchKey(watch))
    return pollerDetectChanges(this._client as S3Client, watch)
  }

  normaliseWatch(raw: unknown): S3Watch | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    if (
      typeof r['watchId'] !== 'string' ||
      typeof r['bucket'] !== 'string' ||
      typeof r['key'] !== 'string' ||
      typeof r['profile'] !== 'string'
    ) {
      return null
    }
    const rawTarget = r['target']
    // Migration shim: remap old TargetCondition values that were persisted before the
    // "creation/modification/deletion" rename so that saved sessions from before the
    // rename continue to load correctly.
    const target =
      rawTarget === 'exists' ? 'creation' :
      rawTarget === 'updated' ? 'modification' :
      rawTarget === 'removed' ? 'deletion' :
      rawTarget
    if (typeof target !== 'string' || !(TARGETS as ReadonlySet<string>).has(target)) {
      return null
    }
    return {
      watchId: r['watchId'],
      bucket: r['bucket'],
      key: r['key'],
      profile: r['profile'],
      region: typeof r['region'] === 'string' ? r['region'] : undefined,
      target: target as S3Watch['target'],
      timeoutAt:
        typeof r['timeoutAt'] === 'number' && Number.isFinite(r['timeoutAt'])
          ? r['timeoutAt']
          : undefined,
      addedAt: toFiniteNumber(r['addedAt']),
      lastPolledAt: typeof r['lastPolledAt'] === 'number' ? r['lastPolledAt'] : undefined,
      baseline: normaliseBaselineField(r['baseline']),
      terminal: typeof r['terminal'] === 'boolean' ? r['terminal'] : false,
      consecutiveErrors:
        typeof r['consecutiveErrors'] === 'number' && Number.isFinite(r['consecutiveErrors'])
          ? r['consecutiveErrors']
          : 0,
    }
  }

  normaliseBaseline(raw: unknown): S3Baseline | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    if (typeof r['exists'] !== 'boolean') return null
    const b: S3Baseline = { exists: r['exists'] }
    if (typeof r['etag'] === 'string') b.etag = r['etag']
    if (typeof r['contentLength'] === 'number' && Number.isFinite(r['contentLength'])) {
      b.contentLength = r['contentLength']
    }
    return b
  }

  classifyError(err: unknown): ClassifiedWatcherError {
    const name = (err as Error)?.name ?? ''
    if (AUTH_ERROR_NAMES.has(name)) {
      return {
        userMessage: 'authentication expired — refresh AWS credentials',
        kind: 'auth',
        shouldBackoff: false,
        statusModifier: 'auth-error',
      }
    }
    if (THROTTLE_ERROR_NAMES.has(name)) {
      return {
        userMessage: 'request throttled by AWS',
        kind: 'throttle',
        shouldBackoff: true,
        statusModifier: 'throttled',
      }
    }
    return {
      userMessage: 'poll failed — check AWS connectivity',
      kind: 'generic',
      shouldBackoff: false,
      statusModifier: 'none',
    }
  }

  buildChangeChatMessage(events: readonly S3Event[], now: Date): string {
    return formatChangeChatMessage(Array.from(events), now)
  }

  protected override containsTerminalStateEvent(events: S3Event[]): boolean {
    return events.some(e => e.isTerminal)
  }

  // ── Add / Remove ───────────────────────────────────────────────────────────
  async addWatch(params: Record<string, unknown>): Promise<ToolResult> {
    const uri = (typeof params['uri'] === 'string' ? params['uri'] : '').trim()
    if (!uri) {
      return this._toolError("'add' requires 'uri' (s3://bucket/key).")
    }

    let parsed: { bucket: string; key: string }
    try {
      parsed = parseS3Uri(uri)
    } catch (err) {
      const msg = err instanceof S3UriError ? err.message : String(err)
      return this._toolError(msg)
    }

    const target = (typeof params['target'] === 'string' ? params['target'] : '').trim()
    if (!(TARGETS as ReadonlySet<string>).has(target)) {
      return this._toolError("'add' requires target to be 'creation', 'modification', or 'deletion'.")
    }

    const profile = (typeof params['profile'] === 'string' ? params['profile'] : '').trim()
    if (!profile) {
      return this._toolError("'add' requires a profile.")
    }

    const region =
      typeof params['region'] === 'string' && params['region'].trim()
        ? params['region'].trim()
        : undefined

    const requestedSeconds =
      typeof params['timeoutSeconds'] === 'number' ? params['timeoutSeconds'] : undefined
    if (requestedSeconds !== undefined) {
      if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
        return this._toolError("'timeoutSeconds' must be a positive finite number.")
      }
    }

    const profileError = validateAwsProfile(profile)
    if (profileError) return this._toolError(profileError)

    const capped = requestedSeconds !== undefined && requestedSeconds > MAX_TIMEOUT_SECONDS
    const effectiveSeconds =
      requestedSeconds !== undefined
        ? Math.min(requestedSeconds, MAX_TIMEOUT_SECONDS)
        : MAX_TIMEOUT_SECONDS
    const timeoutAt = this._now() + effectiveSeconds * 1000

    const watchId = randomBytes(4).toString('hex')
    const watch: S3Watch = {
      watchId,
      bucket: parsed.bucket,
      key: parsed.key,
      profile,
      region,
      target: target as S3Watch['target'],
      timeoutAt,
      addedAt: this._now(),
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    }

    let seedError: string | undefined
    try {
      watch.baseline = await this.snapshot(watch)
    } catch (err) {
      seedError = (err as Error).message
    }

    // target='modification' requires an existing baseline to diff against
    if (target === 'modification' && watch.baseline !== undefined && !watch.baseline.exists) {
      return this._toolError(
        `target='modification' requires the object to exist at add-time, ` +
          `but s3://${parsed.bucket}/${parsed.key} is currently absent.`,
      )
    }

    this.watches.set(watchId, watch)
    if (watch.baseline !== undefined) {
      this.baselines.set(watchId, watch.baseline)
    }

    // Start per-watch scheduler immediately
    const s = this.schedulerFor(watchId)
    if (!s.isRunning) s.start(() => this.pollWatch(watchId))

    const stateLabel =
      watch.baseline === undefined ? '?' : watch.baseline.exists ? 'present' : 'absent'
    const cappedNote = capped ? ` (capped from ${requestedSeconds}s)` : ''
    const timeoutLabel = ` timeout=${effectiveSeconds}s${cappedNote}`
    const message = seedError
      ? `s3-watcher: added watch ${watchId} for s3://${parsed.bucket}/${parsed.key} (target=${target}${timeoutLabel}), but seeding failed (${seedError}). Will retry on next poll.`
      : `s3-watcher: added watch ${watchId} for s3://${parsed.bucket}/${parsed.key} (target=${target}${timeoutLabel}) — baseline=${stateLabel}.`

    return {
      content: [{ type: 'text', text: message }],
      details: {
        action: 'add',
        ok: true,
        message,
        watchId,
        watches: Array.from(this.watches.keys()),
      },
    }
  }

  // base class removeWatch provides the generic message; no domain-specific override needed

  protected override browseOptions(): Partial<BrowseViewOptions<S3Watch>> {
    return {
      searchable: false,
      rowActions: [
        {
          id: 'remove',
          label: 'Unwatch',
          keybind: 'ctrl+x',
          visible: (w) => !w.terminal,
          run: async (watch) => {
            await this.executeTool({ action: 'remove', watchId: this.watchKey(watch) })
          },
        },
      ],
      onRefresh: () => this.pollOnce(),
      onPurge: () => this.executePurge(),
      getPollIntervalMs: (w: S3Watch) => this.schedulerFor(w.watchId).intervalMs,
    }
  }

  // ── Per-watch schedulers (Fix 3) ──────────────────────────────────────────
  private readonly _watchSchedulers = new Map<string, PollScheduler>()

  protected override schedulerFor(watchKey: string): PollScheduler {
    let s = this._watchSchedulers.get(watchKey)
    if (s === undefined) {
      s = new PollScheduler({
        baseMs: BASE_POLL_MS,
        maxMs: MAX_POLL_MS,
        idleMaxMs: MAX_POLL_MS,
      })
      this._watchSchedulers.set(watchKey, s)
    }
    return s
  }

  protected override noteSchedulerSuccess(anyChange: boolean, watchKey: string): void {
    this.schedulerFor(watchKey).noteSuccess(anyChange)
  }

  override startPolling(): void {
    for (const [key, watch] of this.watches) {
      if (watch.terminal) continue
      const s = this.schedulerFor(key)
      if (!s.isRunning) s.start(() => this.pollWatch(key))
    }
  }

  override stopPolling(): void {
    for (const s of this._watchSchedulers.values()) s.stop()
  }

}

