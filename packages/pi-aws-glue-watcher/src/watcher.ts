/**
 * GlueWatcher — pi-aws-glue-watcher implemented via BaseWatcher.
 *
 * Wires Glue-specific snapshot / change-detection / rendering into the shared
 * BaseWatcher poll loop, persistence, and menu machinery.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { AwsBaseWatcher, type AwsAddBaseParams } from 'pi-watcher-core/aws/base-watcher'
import { POLL_ERROR_THRESHOLD } from 'pi-watcher-core/base-watcher'
import { createWatcherMessageRenderer } from 'pi-watcher-core/renderer'
import { addToolToActive } from 'pi-watcher-core/tool-activation'
import type {
  BaseWatcherOptions,
  BrowseViewOptions,
  DetailField,
  RowColumn,
  ToolResult,
  WatcherView,
} from 'pi-watcher-core/base-watcher-types'

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
import { formatElapsed, GlueWidget } from './ui/glue-widget.js'

// ---------------------------------------------------------------------------
// State colour helper
// ---------------------------------------------------------------------------

/**
 * Map a Glue run state string to a TUI colour token.
 * Mirrors the stateStyle() mapping in widgetRows.ts but returns 'dim' for
 * the "none" bucket so browse-mode rows use the same semantic colours as
 * the widget.
 */
export function stateColor(state: string): string {
  if (state === 'RUNNING' || state === 'STARTING') return 'warning'
  if (state === 'SUCCEEDED' || state === 'COMPLETED') return 'success'
  if (
    state === 'FAILED' ||
    state === 'ERROR' ||
    state === 'TIMEOUT' ||
    state === 'STOPPED'
  ) {
    return 'error'
  }
  return 'dim'
}

// ---------------------------------------------------------------------------
// Poll interval constants
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 120_000
export const POLL_INTERVAL_MAX_MS = 900_000
const MIN_POLL_MS = 5_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFiniteNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// ---------------------------------------------------------------------------
// GlueWatcher
// ---------------------------------------------------------------------------

export class GlueWatcher extends AwsBaseWatcher<GlueWatch, WatchBaseline, GlueEvent> {
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
      return `${w.type} ${w.name} [${w.runId.slice(-4)}]  ${state}  ${status}`
    },

    renderItemRowTUI(w, _ctx): RowColumn[] {
      const state = (w.baseline?.state ?? '?').toUpperCase()
      const status = w.terminal
        ? 'DONE'
        : w.consecutiveErrors >= POLL_ERROR_THRESHOLD
          ? 'ERROR'
          : 'WATCHING'

      let elapsed = '-'
      let workers = '-'
      if (w.type === 'job') {
        const b = w.baseline as JobBaseline | undefined
        elapsed = formatElapsed(b?.startedOn, b?.completedOn)
        if (b?.numberOfWorkers != null && b.workerType != null) {
          workers = `${b.numberOfWorkers}\u00d7${b.workerType}`
        }
      }

      return [
        { name: 'name', text: `${w.type} ${w.name} [${w.runId.slice(-4)}]`, color: 'accent' },
        { name: 'state', text: state, width: 14, color: stateColor(state) },
        { name: 'elapsed', text: elapsed, width: 7 },
        { name: 'workers', text: workers, width: 10 },
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

  // ── Scheduler configuration (per-watch intervals + startup stagger) ──────────

  protected override schedulerBaseMs(watchKey: string): number {
    return this.watches.get(watchKey)?.pollIntervalMs ?? POLL_INTERVAL_MS
  }

  protected override schedulerMaxMs(): number {
    return POLL_INTERVAL_MAX_MS
  }

  protected override startupDelayMsForIndex(i: number): number {
    return i * 2000
  }

  protected override awsAuthMessage(): string {
    return 'authentication expired — run `aws sso login` to re-authenticate'
  }

  // stopPolling also clears the map (Glue restarts with fresh schedulers)
  override stopPolling(): void {
    super.stopPolling()
    this._watchSchedulers.clear()
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
    const { defaultDisplayMode } = this.loadWatcherConfig()
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
      // Route through normaliseBaseline so watch.baseline undergoes the same
      // field-level validation as entries in this.baselines — keeps the two in
      // sync and ensures numberOfWorkers / workerType survive the round-trip.
      const nb = this.normaliseBaseline(r['baseline'])
      if (nb !== null) w.baseline = nb
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

  buildChangeChatMessage(events: readonly GlueEvent[], now: Date): string {
    return formatChangeChatMessage([...events], now)
  }

  protected override containsTerminalStateEvent(events: GlueEvent[]): boolean {
    return events.some((e) => e.isTerminal)
  }

  // ── Add (AwsBaseWatcher hooks) ───────────────────────────────────────────────

  protected override async parseAddParams(
    params: Record<string, unknown>,
    base: AwsAddBaseParams,
  ): Promise<{ watch: GlueWatch } | { error: ToolResult }> {
    if (params['type'] !== 'job' && params['type'] !== 'workflow') {
      return {
        error: this._toolError(
          `'add' requires type to be 'job' or 'workflow', got ${JSON.stringify(params['type'] ?? '')}.`,
        ),
      }
    }
    const name = (typeof params['name'] === 'string' ? params['name'] : '').trim()
    if (!name) {
      return { error: this._toolError("'add' requires a non-empty name.") }
    }
    const type = params['type']

    // Validate and clamp poll interval
    let watchPollMs: number | undefined
    if (params['pollIntervalMs'] !== undefined) {
      const ms = params['pollIntervalMs']
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < MIN_POLL_MS) {
        return {
          error: this._toolError(
            `'add' pollIntervalMs must be a finite number >= ${MIN_POLL_MS}ms.`,
          ),
        }
      }
      watchPollMs = ms
    }

    let runId = (typeof params['runId'] === 'string' ? params['runId'] : '').trim()
    const client = this._client as GlueClient
    if (!runId) {
      try {
        runId =
          type === 'job'
            ? await client.getLatestJobRunId(name, base.profile, base.region)
            : await client.getLatestWorkflowRunId(name, base.profile, base.region)
      } catch (err) {
        const msg = `Failed to fetch latest run ID for ${type} '${name}': ${(err as Error).message}`
        return { error: this._toolError(msg) }
      }
    }

    const watch = {
      watchId: base.watchId,
      type,
      name,
      runId,
      profile: base.profile,
      region: base.region,
      addedAt: this._now(),
      lastPolledAt: undefined as number | undefined,
      baseline: undefined as WatchBaseline | undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...(watchPollMs !== undefined ? { pollIntervalMs: watchPollMs } : {}),
    } as GlueWatch
    return { watch }
  }

  protected override describeAddedWatch(
    _params: Record<string, unknown>,
    watch: GlueWatch,
    baseline: WatchBaseline | undefined,
    seedError: string | undefined,
  ): string {
    const intervalNote =
      watch.pollIntervalMs !== undefined
        ? ` | poll: ${Math.round(watch.pollIntervalMs / 1000)}s`
        : ''
    const stateLabel = baseline ? baseline.state || '?' : '?'
    return baseline
      ? `added ${watch.type} '${watch.name}' (${watch.runId}) — state=${stateLabel}${intervalNote}. Watch ID: ${watch.watchId}`
      : `added ${watch.type} '${watch.name}' (${watch.runId}), but seeding failed (${seedError ?? 'unknown'})${intervalNote}. Watch ID: ${watch.watchId}`
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
    return await super.executeTool(params)
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
      searchable: false,
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
