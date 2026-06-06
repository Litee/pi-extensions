/**
 * GlueWatcher — pi-aws-glue-watcher implemented via BaseWatcher.
 *
 * Wires Glue-specific snapshot / change-detection / rendering into the shared
 * BaseWatcher poll loop, persistence, and menu machinery.
 */

import { randomBytes } from 'node:crypto'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { BaseWatcher, POLL_ERROR_THRESHOLD } from 'pi-watcher-core/base-watcher'
import { PollScheduler } from 'pi-watcher-core/poll-scheduler'
import { createWatcherMessageRenderer } from 'pi-watcher-core/renderer'
import { addToolToActive } from 'pi-watcher-core/tool-activation'
import type { ClassifiedWatcherError } from 'pi-watcher-core/classify-error'
import type {
  BaseWatcherOptions,
  BrowseViewOptions,
  DetailField,
  RowColumn,
  ToolResult,
  WatcherView,
} from 'pi-watcher-core/base-watcher-types'

import { loadConfig, saveConfig } from './config.js'
import { buildChangeChatMessage as formatChangeChatMessage, buildStartupChatMessage } from './format.js'
import type { GlueClient } from './glue-client.js'
import {
  detectJobChanges,
  detectWorkflowChanges,
  snapshotJobRun,
  snapshotWorkflowRun,
} from './poller.js'
import { GlueWatcherParams } from './toolParams.js'
import type { GlueEvent, GlueWatch, JobBaseline, WatchBaseline, WatchMap, WorkflowBaseline } from './types.js'
import { GlueWidget } from './ui/glue-widget.js'

// ---------------------------------------------------------------------------
// Poll interval constants
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 120_000
export const POLL_INTERVAL_MAX_MS = 900_000
const MIN_POLL_MS = 5_000

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const AUTH_ERROR_NAMES = new Set([
  'CredentialsProviderError',
  'TokenProviderError',
  'ProviderError',
])

const THROTTLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFiniteNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// ---------------------------------------------------------------------------
// GlueWatcher
// ---------------------------------------------------------------------------

export class GlueWatcher extends BaseWatcher<GlueWatch, WatchBaseline, GlueEvent> {
  // ── Identity ───────────────────────────────────────────────────────────────
  readonly extensionName = 'pi-aws-glue-watcher'
  readonly toolName = 'glue_watcher'

  get itemSource() {
    return 'user-tool' as const
  }

  get hasWidget() {
    return true
  }

  protected override get eventChannel(): string {
    return 'glue:change'
  }

  protected override get toolLabel(): string {
    return 'Glue Watcher'
  }

  protected override get toolDescription(): string {
    return (
      'Manage the background AWS Glue job and workflow watcher. ' +
      'Actions: add (start watching a run), remove (stop watching), ' +
      'list (show all watches), status (show runtime state), ' +
      'set-interval (update poll interval for a specific watch). ' +
      'State-change events are injected into chat automatically.'
    )
  }

  protected override toolParameters(): unknown {
    return GlueWatcherParams
  }

  protected override get statusLabel(): string {
    return 'glue-watcher'
  }

  protected override get displayName(): string {
    return 'AWS Glue Watcher'
  }

  protected override get commandName(): string {
    return 'glue-watcher'
  }

  protected override get userDefaultDisplayMode(): 'widget' | 'statusline' | undefined {
    return loadConfig().defaultDisplayMode
  }

  protected override saveUserDefaultDisplayMode(mode: 'widget' | 'statusline' | undefined): void {
    saveConfig({ defaultDisplayMode: mode })
  }

  // ── View ───────────────────────────────────────────────────────────────────
  readonly view: WatcherView<GlueWatch, GlueEvent> = {
    noun: 'Glue run',
    nounPlural: 'Glue runs',

    itemSortKey: (w) => `${w.type}:${w.name}:${w.runId}`,
    itemGroup: (w) => w.profile,

    renderItemRowText(w): string {
      const state = (w.baseline?.state ?? '?').toUpperCase()
      const status = w.terminal
        ? 'DONE'
        : w.consecutiveErrors >= POLL_ERROR_THRESHOLD
          ? 'ERROR'
          : 'WATCHING'
      return `${w.type} ${w.name} (${w.runId})  ${state}  ${status}`
    },

    renderItemRowTUI(w, _ctx): RowColumn[] {
      const state = (w.baseline?.state ?? '?').toUpperCase()
      const status = w.terminal
        ? 'DONE'
        : w.consecutiveErrors >= POLL_ERROR_THRESHOLD
          ? 'ERROR'
          : 'WATCHING'
      return [
        { name: 'name', text: `${w.type} ${w.name} (${w.runId})`, color: 'accent' },
        { name: 'state', text: state, width: 14, color: 'dim' },
        {
          name: 'status',
          text: status,
          width: 10,
          color: w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? 'error' : 'warning',
        },
      ]
    },

    renderItemDetail(w, ctx): DetailField[] {
      const state = w.baseline?.state ?? 'unknown'
      return [
        { label: 'type', value: w.type },
        { label: 'name', value: w.name },
        { label: 'runId', value: w.runId },
        { label: 'profile', value: w.profile },
        { label: 'region', value: w.region ?? 'default' },
        { label: 'state', value: state },
        { label: 'added', value: new Date(w.addedAt).toISOString() },
        {
          label: 'polled',
          value:
            w.lastPolledAt !== undefined
              ? new Date(w.lastPolledAt).toISOString()
              : 'never',
        },
        {
          label: 'poll',
          value:
            ctx.pollIntervalMs !== undefined
              ? `${Math.round(ctx.pollIntervalMs / 1000)}s`
              : 'unknown',
        },
        { label: 'errors', value: String(w.consecutiveErrors) },
        { label: 'terminal', value: w.terminal ? 'yes' : 'no' },
      ]
    },

    renderEventRow: (e) => e.formatted,
    isRowDimmed: (w) => w.terminal,
  }

  // ── Per-watch schedulers ──────────────────────────────────────────────────
  private readonly _watchSchedulers = new Map<string, PollScheduler>()

  protected override schedulerFor(watchKey: string): PollScheduler {
    let s = this._watchSchedulers.get(watchKey)
    if (s === undefined) {
      const baseMs = this.watches.get(watchKey)?.pollIntervalMs ?? POLL_INTERVAL_MS
      s = new PollScheduler({
        baseMs,
        maxMs: POLL_INTERVAL_MAX_MS,
        idleMaxMs: POLL_INTERVAL_MAX_MS,
      })
      this._watchSchedulers.set(watchKey, s)
    }
    return s
  }

  protected override noteSchedulerSuccess(anyChange: boolean, watchKey: string): void {
    this.schedulerFor(watchKey).noteSuccess(anyChange)
  }

  private _minIntervalMs(): number {
    if (this._watchSchedulers.size === 0) return POLL_INTERVAL_MS
    let min = Infinity
    for (const s of this._watchSchedulers.values()) {
      if (s.intervalMs < min) min = s.intervalMs
    }
    return Number.isFinite(min) ? min : POLL_INTERVAL_MS
  }

  // ── Constructor ────────────────────────────────────────────────────────────
  constructor(opts: BaseWatcherOptions & { client: GlueClient }) {
    super({ ...opts, client: opts.client })
    this.widget = new GlueWidget(
      opts.pi,
      () => {
        const out: WatchMap = {}
        for (const [k, v] of this.watches) out[k] = v
        return out
      },
      () => this._minIntervalMs(),
    )
    const { defaultDisplayMode } = loadConfig()
    if (defaultDisplayMode !== undefined) {
      this.defaultDisplayMode = defaultDisplayMode
    }
  }

  // ── Domain hooks ───────────────────────────────────────────────────────────
  watchKey(watch: GlueWatch): string {
    return watch.watchId
  }

  async snapshot(watch: GlueWatch): Promise<WatchBaseline> {
    const c = this._client as GlueClient
    if (watch.type === 'job') {
      return snapshotJobRun(c, watch)
    }
    return snapshotWorkflowRun(c, watch)
  }

  async detectChanges(watch: GlueWatch): Promise<{
    newBaseline: WatchBaseline
    events: GlueEvent[]
    observedChange: boolean
  }> {
    // Sync inline baseline mirror from the base store (poller reads watch.baseline)
    watch.baseline = this.baselines.get(this.watchKey(watch))
    const c = this._client as GlueClient
    const out =
      watch.type === 'job'
        ? await detectJobChanges(c, watch)
        : await detectWorkflowChanges(c, watch)
    // Write back so the widget row renderer (widgetRows.ts) stays current
    watch.baseline = out.newBaseline
    return {
      newBaseline: out.newBaseline,
      events: out.events,
      observedChange: out.events.length > 0,
    }
  }

  normaliseWatch(raw: unknown): GlueWatch | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    if (
      typeof r['watchId'] !== 'string' ||
      (r['type'] !== 'job' && r['type'] !== 'workflow') ||
      typeof r['name'] !== 'string' ||
      typeof r['runId'] !== 'string' ||
      typeof r['profile'] !== 'string'
    ) {
      return null
    }
    const w: Partial<GlueWatch> = {
      watchId: r['watchId'],
      type: r['type'],
      name: r['name'],
      runId: r['runId'],
      profile: r['profile'],
      addedAt: toFiniteNumber(r['addedAt']),
      terminal: typeof r['terminal'] === 'boolean' ? r['terminal'] : false,
      consecutiveErrors:
        typeof r['consecutiveErrors'] === 'number' &&
        Number.isFinite(r['consecutiveErrors'])
          ? r['consecutiveErrors']
          : 0,
    }
    if (typeof r['region'] === 'string') w.region = r['region']
    if (typeof r['pollIntervalMs'] === 'number' && Number.isFinite(r['pollIntervalMs'])) {
      w.pollIntervalMs = r['pollIntervalMs']
    }
    if (typeof r['lastPolledAt'] === 'number') w.lastPolledAt = r['lastPolledAt']
    if (
      r['baseline'] != null &&
      typeof r['baseline'] === 'object' &&
      !Array.isArray(r['baseline'])
    ) {
      w.baseline = r['baseline'] as WatchBaseline
    }
    return w as GlueWatch
  }

  normaliseBaseline(raw: unknown): WatchBaseline | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    // Discriminate JobBaseline (has errorMessage) vs WorkflowBaseline (has totalActions)
    if ('errorMessage' in r) {
      if (typeof r['state'] !== 'string') return null
      const b: JobBaseline = {
        state: r['state'],
        errorMessage: typeof r['errorMessage'] === 'string' ? r['errorMessage'] : '',
      }
      if (typeof r['startedOn'] === 'string') b.startedOn = r['startedOn']
      if (typeof r['completedOn'] === 'string') b.completedOn = r['completedOn']
      if (typeof r['numberOfWorkers'] === 'number') b.numberOfWorkers = r['numberOfWorkers']
      if (typeof r['workerType'] === 'string') b.workerType = r['workerType']
      if (typeof r['timeoutMinutes'] === 'number') b.timeoutMinutes = r['timeoutMinutes']
      return b
    }
    if ('totalActions' in r) {
      if (typeof r['state'] !== 'string') return null
      const b: WorkflowBaseline = {
        state: r['state'],
        totalActions: typeof r['totalActions'] === 'number' ? r['totalActions'] : 0,
        succeededActions:
          typeof r['succeededActions'] === 'number' ? r['succeededActions'] : 0,
        failedActions: typeof r['failedActions'] === 'number' ? r['failedActions'] : 0,
        runningActions: typeof r['runningActions'] === 'number' ? r['runningActions'] : 0,
        reportedFailedNodes: Array.isArray(r['reportedFailedNodes'])
          ? (r['reportedFailedNodes'] as string[]).filter((s) => typeof s === 'string')
          : [],
      }
      if (Array.isArray(r['nodes'])) b.nodes = r['nodes'] as WorkflowBaseline['nodes'] ?? []
      return b
    }
    return null
  }

  classifyError(err: unknown): ClassifiedWatcherError {
    const name = (err as Error)?.name ?? ''
    if (AUTH_ERROR_NAMES.has(name)) {
      return {
        userMessage: 'authentication expired — run `aws sso login` to re-authenticate',
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

  buildChangeChatMessage(events: readonly GlueEvent[], now: Date): string {
    return formatChangeChatMessage([...events], now)
  }

  protected override containsTerminalStateEvent(events: GlueEvent[]): boolean {
    return events.some((e) => e.isTerminal)
  }

  // ── Add / Remove ───────────────────────────────────────────────────────────
  async addWatch(params: Record<string, unknown>): Promise<ToolResult> {
    if (params['type'] !== 'job' && params['type'] !== 'workflow') {
      return this._toolError(
        `'add' requires type to be 'job' or 'workflow', got ${JSON.stringify(params['type'] ?? '')}.`,
      )
    }
    const name = (typeof params['name'] === 'string' ? params['name'] : '').trim()
    if (!name) {
      return this._toolError("'add' requires a non-empty name.")
    }
    const profile = (typeof params['profile'] === 'string' ? params['profile'] : '').trim()
    if (!profile) {
      return this._toolError("'add' requires a profile.")
    }
    const region =
      typeof params['region'] === 'string' && params['region'].trim()
        ? params['region'].trim()
        : undefined
    const type = params['type']

    // Validate and clamp poll interval
    let watchPollMs: number | undefined
    if (params['pollIntervalMs'] !== undefined) {
      const ms = params['pollIntervalMs']
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < MIN_POLL_MS) {
        return this._toolError(
          `'add' pollIntervalMs must be a finite number >= ${MIN_POLL_MS}ms.`,
        )
      }
      watchPollMs = ms
    }

    let runId = (typeof params['runId'] === 'string' ? params['runId'] : '').trim()
    const client = this._client as GlueClient
    if (!runId) {
      try {
        runId =
          type === 'job'
            ? await client.getLatestJobRunId(name, profile, region)
            : await client.getLatestWorkflowRunId(name, profile, region)
      } catch (err) {
        const msg = `Failed to fetch latest run ID for ${type} '${name}': ${(err as Error).message}`
        return this._toolError(msg)
      }
    }

    const watchId = randomBytes(4).toString('hex')
    const watch = {
      watchId,
      type,
      name,
      runId,
      profile,
      region,
      addedAt: this._now(),
      lastPolledAt: undefined as number | undefined,
      baseline: undefined as WatchBaseline | undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...(watchPollMs !== undefined ? { pollIntervalMs: watchPollMs } : {}),
    } as GlueWatch

    let seedError: string | undefined
    try {
      watch.baseline = await this.snapshot(watch)
    } catch (err) {
      seedError = (err as Error).message
    }

    this.watches.set(watchId, watch)
    if (watch.baseline !== undefined) {
      this.baselines.set(watchId, watch.baseline)
    }

    // Start per-watch scheduler immediately
    const s = this.schedulerFor(watchId)
    if (!s.isRunning) s.start(() => this.pollWatch(watchId))

    const intervalNote =
      watchPollMs !== undefined ? ` | poll: ${Math.round(watchPollMs / 1000)}s` : ''
    const stateLabel = watch.baseline ? watch.baseline.state || '?' : '?'
    const message = watch.baseline
      ? `added ${type} '${name}' (${runId}) — state=${stateLabel}${intervalNote}. Watch ID: ${watchId}`
      : `added ${type} '${name}' (${runId}), but seeding failed (${seedError ?? 'unknown'})${intervalNote}. Watch ID: ${watchId}`

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

  override removeWatch(watch: GlueWatch): Promise<ToolResult> {
    const remaining = this.watches.size - 1
    const key = this.watchKey(watch)
    const s = this._watchSchedulers.get(key)
    if (s) {
      s.stop()
      this._watchSchedulers.delete(key)
    }
    const message = `glue-watcher: removed ${watch.type} '${watch.name}' (${watch.runId}). ${remaining} watch(es) remaining.`
    return Promise.resolve({
      content: [{ type: 'text', text: message }],
      details: { action: 'remove', ok: true, watchKey: key },
    })
  }

  // ── executeTool: set-interval override ───────────────────────────────────
  override async executeTool(params: Record<string, unknown>): Promise<ToolResult> {
    const action = typeof params['action'] === 'string' ? params['action'] : 'add'
    if (action === 'set-interval') {
      const id = (typeof params['watchId'] === 'string' ? params['watchId'] : '').trim()
      if (!id) return this._toolError("'set-interval' requires a watchId.")
      const watch = this.watches.get(id)
      if (!watch) return this._toolError(`Watch '${id}' not found.`)
      const ms = params['pollIntervalMs']
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < MIN_POLL_MS) {
        return this._toolError(
          `'set-interval' requires pollIntervalMs >= ${MIN_POLL_MS}ms.`,
        )
      }
      watch.pollIntervalMs = ms
      const old = this._watchSchedulers.get(id)
      if (old) {
        old.stop()
        this._watchSchedulers.delete(id)
      }
      if (!watch.terminal) {
        const s = this.schedulerFor(id)
        s.start(() => this.pollWatch(id))
      }
      this.writeState()
      this.refreshStatus()
      const message = `Poll interval for watch '${id}' set to ${Math.round(ms / 1000)}s.`
      return {
        content: [{ type: 'text', text: message }],
        details: { action: 'set-interval', ok: true, message },
      }
    }
    return super.executeTool(params)
  }

  // ── Polling ────────────────────────────────────────────────────────────────
  override startPolling(): void {
    let i = 0
    for (const [key, watch] of this.watches) {
      if (watch.terminal) continue
      const s = this.schedulerFor(key)
      if (s.isRunning) {
        i++
        continue
      }
      const delay = i * 2000
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
      i++
    }
  }

  override stopPolling(): void {
    for (const s of this._watchSchedulers.values()) s.stop()
    this._watchSchedulers.clear()
  }

  // ── Session start (legacy migration + crash recovery) ─────────────────────
  override async onSessionStart(ctx: unknown): Promise<void> {
    await super.onSessionStart(ctx)
    // Legacy persisted entries stored enabled under data.baselines.enabled.
    // _rehydrateState ignores it. If we have active watches but enabled=false,
    // force it back on (crash-recovery path: session ended before turn_end
    // persisted enabled=true).
    const hasActive = Array.from(this.watches.values()).some((w) => !w.terminal)
    if (hasActive && !this.enabled) {
      this.enabled = true
      addToolToActive(this._pi, this.toolName)
      if (this.hasWidget && this.widget !== null && this.displayMode === 'widget') {
        this.widget.show(ctx)
      }
      this.refreshStatus()
    }
  }

  // ── register: re-register with expandedTextOverride ───────────────────────
  override register(pi: ExtensionAPI): void {
    super.register(pi)
    // Re-register renderer with legacy expandedTextOverride so pre-migration
    // persisted startup messages still expand correctly.
    pi.registerMessageRenderer(
      this.customMessageType,
      createWatcherMessageRenderer(this.extensionName, {
        expandedTextOverride: (message) => {
          if (
            message.details &&
            typeof message.details === 'object' &&
            'watches' in message.details
          ) {
            const d = message.details as {
              watches: WatchMap
              date: string
              pollMs?: number
            }
            return buildStartupChatMessage(d.watches, new Date(d.date), {
              expanded: true,
              ...(typeof d.pollMs === 'number' ? { pollMs: d.pollMs } : {}),
            })
          }
          return undefined
        },
      }),
    )
  }

  // ── Browse options ────────────────────────────────────────────────────────
  protected override browseOptions(): Partial<BrowseViewOptions<GlueWatch>> {
    return {
      rowActions: [
        {
          id: 'stop',
          label: 'Stop run',
          keybind: 's',
          visible: (w) => !w.terminal,
          run: async (watch) => {
            const c = this._client as GlueClient
            if (watch.type === 'job') {
              await c.stopJobRun(watch.name, watch.runId, watch.profile, watch.region)
            } else {
              await c.stopWorkflowRun(watch.name, watch.runId, watch.profile, watch.region)
            }
          },
        },
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
      getPollIntervalMs: (w) => this.schedulerFor(w.watchId).intervalMs,
    }
  }
}
