/**
 * BaseWatcher<TWatch, TBaseline, TEvent> — abstract base class for all
 * pi watcher extensions.
 *
 * Provides concrete implementations of all shared lifecycle, poll-loop,
 * persistence, status, and menu logic. Subclasses supply only the
 * domain-specific snapshot / change-detection / rendering logic.
 *
 * ## Terminology
 *   TWatch    — the domain entity being watched (S3Watch, issue file, …)
 *   TBaseline — a point-in-time snapshot used as the comparison anchor
 *   TEvent    — a detected change emitted to chat
 *
 * ## itemSource modes
 *   "user-tool" — watches are added via an LLM tool; persisted across
 *                 sessions; each has a terminal flag.
 *   "scan"      — the watcher scans a data source on each poll cycle and
 *                 diffs against the previous scan.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { DEFAULT_POLL_ERROR_THRESHOLD } from './error-tracker.js'
import { PollScheduler } from './poll-scheduler.js'
import { createWatcherMessageRenderer } from './renderer.js'
import { statusLineColorAlias } from './status-line.js'
import { reconcileToolActivation, removeToolFromActive } from './tool-activation.js'
import { colorize, extractUiSurface, type UiSurface } from './ui-surface.js'
import type { ClassifiedWatcherError } from './classify-error.js'
import type {
  BaseWatcherOptions,
  BrowseViewOptions,
  CommandCtx,
  MenuItem,
  MenuResult,
  ToolResult,
  WatcherItemSource,
  WatcherState,
  WatcherView,
  WatcherWidgetLike,
  WatchLike,
} from './base-watcher-types.js'

export type { WatcherItemSource, WatcherState, WatcherView, WatcherWidgetLike, WatchLike } from './base-watcher-types.js'
export type { ClassifiedWatcherError }

// ---------------------------------------------------------------------------
// Poll loop constants (overridable via constructor)
// ---------------------------------------------------------------------------

export const BASE_POLL_MS = 60_000
export const MAX_POLL_MS = 900_000
export const POLL_ERROR_THRESHOLD = DEFAULT_POLL_ERROR_THRESHOLD

// ---------------------------------------------------------------------------
// Session ctx shapes (untyped in pi SDK at this layer)
// ---------------------------------------------------------------------------

interface SessionEntry {
  type?: string
  customType?: string
  data?: unknown
}

interface SessionLike {
  sessionManager: { getEntries(): SessionEntry[] }
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

/**
 * Abstract base class for pi watcher extensions.
 *
 * ### How to subclass
 *
 * 1. Declare `readonly extensionName = "my-watcher"`.
 * 2. Declare `get itemSource(): WatcherItemSource { return "user-tool" }`.
 * 3. Implement all abstract methods.
 * 4. In your extension default export: `new MyWatcher(opts).register(pi)`.
 */
export abstract class BaseWatcher<
  TWatch extends WatchLike,
  TBaseline,
  TEvent,
> {
  // -------------------------------------------------------------------------
  // Abstract — identity / capability
  // -------------------------------------------------------------------------

  /** Package/command name, e.g. `"pi-aws-s3-watcher"`. Used to derive all keys. */
  abstract readonly extensionName: string

  /**
   * LLM-facing tool name, e.g. `"s3_watcher"`. Must be a valid identifier (no hyphens).
   * Intentionally separate from `extensionName`.
   */
  abstract readonly toolName: string

  /**
   * How the watch list is populated.
   * - `"user-tool"` → register LLM tool, persist watches
   * - `"scan"`      → call `scanItems()` on each poll; no LLM tool
   */
  abstract get itemSource(): WatcherItemSource

  /**
   * Whether to create and manage a below-editor TUI widget.
   * When `false`, the watcher only uses the pinned status row.
   */
  abstract get hasWidget(): boolean

  /** Domain-specific rendering contract. */
  abstract get view(): WatcherView<TWatch, TEvent>

  // -------------------------------------------------------------------------
  // Abstract — domain hooks
  // -------------------------------------------------------------------------

  /**
   * Return a stable, unique string key for a watch item.
   * Used as the `Map<string, TWatch>` key and as the baseline lookup key.
   *
   * @example return watch.watchId
   * @example return watch.filePath
   */
  abstract watchKey(watch: TWatch): string

  /**
   * Capture the current state of `watch` as a baseline.
   * Called during seeding (session_start) for watches that lack a baseline.
   */
  abstract snapshot(watch: TWatch): Promise<TBaseline>

  /**
   * Compare the current state of `watch` against its stored baseline and
   * return any detected events plus the fresh baseline to store.
   *
   * The previous baseline is available as `this.baselines.get(this.watchKey(watch))`.
   * Returning `observedChange: true` but `events: []` is valid — it resets
   * the idle back-off without emitting a chat message.
   */
  abstract detectChanges(watch: TWatch): Promise<{
    newBaseline: TBaseline
    events: TEvent[]
    observedChange: boolean
  }>

  /**
   * Deserialise a raw (JSON-parsed) watch object from the session log.
   * Return `null` to silently skip malformed entries.
   */
  abstract normaliseWatch(raw: unknown): TWatch | null

  /**
   * Deserialise a raw (JSON-parsed) baseline from the session log.
   * Return `null` to silently skip malformed entries.
   */
  abstract normaliseBaseline(raw: unknown): TBaseline | null

  /**
   * Classify a caught error into a structured `ClassifiedWatcherError`.
   * The returned `userMessage` is the ONLY error text that may appear in
   * user-facing surfaces (chat, `ui.notify`, `appendEntry` payloads).
   * Never pass `err.message` to user-facing surfaces directly.
   */
  abstract classifyError(err: unknown): ClassifiedWatcherError

  /**
   * Build the chat message announcing one or more detected change events.
   * Sent via `sendMessage({ display: true, triggerTurn: true })`.
   */
  abstract buildChangeChatMessage(events: readonly TEvent[], now: Date): string

  /**
   * Create a new watch from validated LLM tool parameters and add it to
   * `this.watches`. Called by the base class `executeTool` handler when
   * `params.action === "add"` (or when no action is provided).
   *
   * Responsibilities:
   *   - Validate domain-specific params (throw `ToolError` with a safe message on invalid input).
   *   - Call `this.snapshot(watch)` to seed the baseline; store in `this.baselines`.
   *   - Add the watch to `this.watches` via `this.watches.set(this.watchKey(watch), watch)`.
   *   - Return a `ToolResult` describing what was added.
   *
   * The base class handles `writeState()`, `startPolling()`, `refreshStatus()`,
   * and `pi.events.emit(eventChannel)` after this method returns successfully.
   */
  abstract addWatch(params: Record<string, unknown>): Promise<ToolResult>

  /**
   * Remove a watch by its key. Called by the base class `executeTool` handler
   * when `params.action === "remove"`.
   *
   * The base class passes the resolved watch object. The default implementation
   * returns a generic "removed X, N remaining" message. Override for
   * domain-specific wording (e.g. including the S3 URI or EC2 instance ID).
   *
   * The base class handles removing the key from `this.watches` and
   * `this.baselines` after this method returns successfully.
   */
  removeWatch(watch: TWatch): Promise<ToolResult> {
    const remaining = this.watches.size - 1
    return Promise.resolve({
      content: [{
        type: 'text' as const,
        text: `${this.statusLabel}: removed '${this.watchKey(watch)}'. ${remaining} watch(es) remaining.`,
      }],
      details: { action: 'remove', ok: true, watchKey: this.watchKey(watch) },
    })
  }

  // -------------------------------------------------------------------------
  // Optional abstract — per-source hooks
  // -------------------------------------------------------------------------

  /**
   * Populate the watch list by scanning a data source.
   * Called by `pollOnce` and `onSessionStart` when `itemSource === "scan"`.
   * Must be implemented when `itemSource === "scan"`.
   */
  scanItems?(): Promise<TWatch[]>

  // -------------------------------------------------------------------------
  // Overridable hooks — sensible defaults provided
  // -------------------------------------------------------------------------

  /**
   * Return the scheduler to use for back-off on a given watch key.
   * Default: returns `this.sharedScheduler` (single shared scheduler).
   * Override to maintain per-watch schedulers for independent back-off.
   */
  protected schedulerFor(_watchKey: string): PollScheduler {
    return this.sharedScheduler
  }

  /**
   * Called after each poll cycle to update the scheduler.
   * Default: calls `this.sharedScheduler.noteSuccess(anyChange)`.
   */
  protected noteSchedulerSuccess(anyChange: boolean, _watchKey: string): void {
    this.sharedScheduler.noteSuccess(anyChange)
  }

  /**
   * Current user-persisted default display mode.
   * `undefined` means "no preference saved — use session default".
   * Scan watchers and watchers without widgets always return undefined.
   * Override to read from your config source.
   */
  protected get userDefaultDisplayMode(): 'widget' | 'statusline' | undefined {
    return undefined
  }

  /**
   * Persist a new user-default display mode preference.
   * Called by the userDefaultDisplayMode menu item. No-op by default.
   * Override to write to your config source.
   */
  protected saveUserDefaultDisplayMode(_mode: 'widget' | 'statusline' | undefined): void {
    // no-op in base class
  }

  /**
   * Customise the command menu before it is rendered.
   * Add, remove, or reorder items as needed. Default: identity.
   */
  protected customizeMenu(items: MenuItem[]): MenuItem[] {
    return items
  }

  /**
   * Return `true` if `watch` should appear when `query` is applied.
   * Default: substring match on `view.renderItemRowText(watch)`.
   */
  protected browseFilter(watch: TWatch, query: string): boolean {
    return this.view
      .renderItemRowText(watch)
      .toLowerCase()
      .includes(query.toLowerCase())
  }

  /**
   * Browse-view header line given current count/filter state.
   * Default: `"<N> <noun(s)>"` or `"<filtered>/<total> <noun(s)>"`.
   */
  protected browseHeader(state: { count: number; filtered: number; activeCount?: number }): string {
    const active = state.activeCount ?? state.count
    return `(${active}/${state.count})`
  }

  /**
   * Short count label shown in the "Browse" menu item.
   * Default: total watch count as a string.
   * Override to show e.g. `"3 open"` for issue-style watchers.
   */
  protected browseCount(state: WatcherState): string {
    return `${state.activeCount}/${state.watchCount}`
  }

  /**
   * Return `true` if the batch of events should mark the watch terminal.
   * Override when a watcher produces multiple event batches before completion.
   */
  protected abstract containsTerminalStateEvent(events: TEvent[]): boolean

  // -------------------------------------------------------------------------
  // Tool metadata (user-tool only — overridable)
  // -------------------------------------------------------------------------

  /**
   * Short prefix used in status-line text and tool response messages.
   * Defaults to `extensionName`. Override to use a compact label, e.g.
   * `"aws-s3"` instead of `"pi-aws-s3-watcher"`.
   */
  protected get statusLabel(): string {
    return this.extensionName
  }

  /**
   * Human-readable display name for visual surfaces (widget header, browse
   * overlay title, command menu title). Defaults to `extensionName`.
   * Override to provide a proper display name, e.g. `"AWS S3 Watcher"`.
   */
  protected get displayName(): string {
    return this.extensionName
  }

  /**
   * The slash-command name registered with pi, e.g. `"aws-s3-watcher"`.
   * Users invoke it as `/<commandName>`.
   *
   * Defaults to `extensionName`. Override to use a shorter, user-facing name
   * independent of the package name.
   */
  protected get commandName(): string {
    return this.extensionName
  }

  /** Display label for the LLM tool, e.g. `"S3 Watcher"`. */
  protected get toolLabel(): string {
    return this.extensionName
  }

  /** Tool description passed to the model. */
  protected get toolDescription(): string {
    return `Manage ${this.extensionName} watches.`
  }

  /**
   * TypeBox (or JSON Schema) parameters object for the tool.
   * Return `undefined` to register with no parameters schema.
   */
  protected toolParameters(): unknown {
    return undefined
  }

  // -------------------------------------------------------------------------
  // Derived keys (computed from extensionName)
  // -------------------------------------------------------------------------

  /** Key used in `ui.setStatus` calls. */
  protected get statusKey(): string {
    return this.extensionName
  }

  /** customType written on every outbound chat message. */
  protected get customMessageType(): string {
    return this.extensionName
  }

  /** pi.events channel emitted after each poll cycle. */
  protected get eventChannel(): string {
    return `${this.extensionName}:change`
  }

  /** customType used by `pi.appendEntry` for persisted state entries. */
  protected get stateCustomType(): string {
    return `${this.extensionName}:state`
  }

  // -------------------------------------------------------------------------
  // Runtime state
  // -------------------------------------------------------------------------

  /** Current watches — key = `watchKey(watch)`. */
  protected readonly watches = new Map<string, TWatch>()
  /** Per-watch baselines — key = `watchKey(watch)`. */
  protected readonly baselines = new Map<string, TBaseline>()
  /** Whether the LLM tool is active (user-tool only). */
  protected enabled = false
  protected displayMode: 'widget' | 'statusline' = 'widget'
  /**
   * Subclasses may set this in their constructor to supply a config-driven
   * default display mode. The base class `onSessionStart` applies it as a
   * fallback when no persisted display mode is found in the session log.
   *
   * Set before calling `super.onSessionStart` (or in the constructor).
   */
  protected defaultDisplayMode?: 'widget' | 'statusline'
  protected readonly sharedScheduler: PollScheduler
  protected ui: UiSurface | null = null
  protected widget: WatcherWidgetLike | null = null

  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  protected _pi: ExtensionAPI
  protected readonly _client: unknown
  protected readonly _now: () => number

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor(opts: BaseWatcherOptions) {
    this._pi = opts.pi
    this._client = opts.client
    this._now = opts.now ?? Date.now
    this.sharedScheduler = new PollScheduler({
      baseMs: BASE_POLL_MS,
      maxMs: MAX_POLL_MS,
      idleMaxMs: MAX_POLL_MS,
    })
  }

  // -------------------------------------------------------------------------
  // Concrete tool execute handler
  // -------------------------------------------------------------------------

  /**
   * Concrete tool execute handler. Routes the `action` param to the
   * appropriate base-class or subclass handler.
   *
   * Actions handled entirely by the base class (no override needed):
   *   list, pause, resume, status
   *
   * Actions delegated to subclass abstract methods:
   *   add    → addWatch(params)
   *   remove → removeWatch(watch)  (base class resolves the watch first)
   *
   * If `params.action` is absent, defaults to `"add"`.
   */
  async executeTool(params: Record<string, unknown>): Promise<ToolResult> {
    const action = typeof params['action'] === 'string' ? params['action'] : 'add'

    switch (action) {
      case 'add': {
        const result = await this.addWatch(params)
        this.writeState()
        this.startPolling()
        this._pi.events.emit(this.eventChannel, {})
        this.refreshStatus()
        return result
      }

      case 'remove': {
        const watchId = params['watchId'] ?? params['id'] ?? params['watchKey']
        if (typeof watchId !== 'string') {
          return this._toolError('remove requires a watchId parameter.')
        }
        const watch = this.watches.get(watchId)
        if (watch === undefined) {
          return this._toolError(`No watch found with id: ${watchId}`)
        }
        const result = await this.removeWatch(watch)
        this.watches.delete(watchId)
        this.baselines.delete(watchId)
        this.writeState()
        this._pi.events.emit(this.eventChannel, {})
        this.refreshStatus()
        return result
      }

      case 'list': {
        const entries = Array.from(this.watches.values()).map((w) => ({
          key: this.watchKey(w),
          terminal: w.terminal,
          errors: w.consecutiveErrors,
          row: this.view.renderItemRowText(w),
        }))
        return {
          content: [{ type: 'text' as const, text: entries.length === 0
            ? `${this.statusLabel}: no active watches.`
            : entries.map((e) => `• ${e.row}${e.terminal ? ' (done)' : ''}${e.errors > 0 ? ` (${e.errors} errors)` : ''}`).join('\n')
          }],
          details: { action: 'list', watches: entries },
        }
      }

      case 'status': {
        const active = Array.from(this.watches.values()).filter((w) => !w.terminal)
        const errors = active.filter((w) => w.consecutiveErrors >= POLL_ERROR_THRESHOLD).length
        const text = [
          `${this.statusLabel}: ${active.length} active watch(es)`,
          errors > 0 ? `  ${errors} watch(es) with repeated errors` : null,
          `  poll interval: ${Math.round(this.sharedScheduler.intervalMs / 1000)}s`,
        ].filter(Boolean).join('\n')
        return { content: [{ type: 'text' as const, text }], details: { action: 'status', activeCount: active.length } }
      }

      default:
        return this._toolError(`Unknown action: "${action}". Valid actions: add, remove, list, status.`)
    }
  }

  protected _toolError(message: string): ToolResult {
    return {
      content: [{ type: 'text' as const, text: `${this.statusLabel}: ${message}` }],
      details: { ok: false, message },
    }
  }

  // -------------------------------------------------------------------------
  // register — wire pi lifecycle
  // -------------------------------------------------------------------------

  /**
   * Wire all pi event handlers, command, message renderer, and tool
   * (if `itemSource === "user-tool"`).
   *
   * Call once from your extension's default export:
   * ```ts
   * export default function myWatcher(pi: ExtensionAPI): void {
   *   new MyWatcher({ pi }).register(pi)
   * }
   * ```
   */
  register(pi: ExtensionAPI): void {
    this._pi = pi

    // Message renderer — collapses/expands change messages in the chat
    pi.registerMessageRenderer(
      this.customMessageType,
      createWatcherMessageRenderer(this.extensionName),
    )

    // Slash command
    pi.registerCommand(this.commandName, {
      description: `Open the ${this.displayName} menu`,
      handler: (args, ctx) => this.commandHandler()(args, ctx),
    })

    // Tool (user-tool only)
    if (this.itemSource === 'user-tool') {
      pi.registerTool({
        name: this.toolName,
        label: this.toolLabel,
        description: this.toolDescription,
        parameters: this.toolParameters() ?? {},
        execute: async (_toolCallId: string, params: unknown) =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
          this.executeTool(params as Record<string, unknown>) as unknown as Promise<any>,
      })
    }

    // Lifecycle events
    pi.on('session_start', async (_evt: unknown, ctx: unknown) => {
      await this.onSessionStart(ctx)
    })
    pi.on('turn_end', (_evt: unknown, ctx: unknown) => {
      this.onTurnEnd(ctx)
    })
    pi.on('session_shutdown', (_evt: unknown, ctx: unknown) => {
      this.onSessionShutdown(ctx)
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle — session_start
  // -------------------------------------------------------------------------

  async onSessionStart(ctx: unknown): Promise<void> {
    this.ui = extractUiSurface(ctx)

    // Apply config-driven default before rehydration so persisted state wins.
    if (this.defaultDisplayMode !== undefined) {
      this.displayMode = this.defaultDisplayMode
    }

    // Rehydrate persisted state from session log first so that
    // `this.enabled` reflects the persisted value before we decide
    // whether to remove the tool from the active set.
    this._rehydrateState(ctx as SessionLike)

    // For user-tool watchers, remove the tool from active set when the
    // persisted (or default) enabled state is false. Pi auto-activates all
    // extension tools on session_start; we undo that unless the user had
    // previously activated the tool. Polling continues independently of
    // tool-active state.
    if (this.itemSource === 'user-tool' && !this.enabled) {
      removeToolFromActive(this._pi, this.toolName)
    }

    // For scan watchers, populate the watch list from the data source
    if (this.itemSource === 'scan' && this.scanItems !== undefined) {
      const items = await this.scanItems()
      this.watches.clear()
      for (const item of items) {
        this.watches.set(this.watchKey(item), item)
      }
    }

    // Seed baselines for watches that survived without one
    await this._seedMissingBaselines()

    // Start polling if there are active watches
    const activeWatches = Array.from(this.watches.values()).filter(
      (w) => !w.terminal,
    )
    if (activeWatches.length > 0) this.startPolling()

    // Show/hide widget
    if (this.hasWidget && this.widget !== null) {
      if (this.displayMode === 'widget') this.widget.show(ctx)
      else this.widget.hide(ctx)
    }

    this.refreshStatus()

  }

  // -------------------------------------------------------------------------
  // Lifecycle — turn_end
  // -------------------------------------------------------------------------

  /**
   * Reconcile tool activation: if the LLM ran `manage_tools` during the turn
   * to activate or deactivate the tool, sync `enabled` and start/stop polling.
   */
  onTurnEnd(ctx: unknown): void {
    if (this.itemSource !== 'user-tool') return

    const intent = reconcileToolActivation(
      this.toolName,
      this.enabled,
      this._pi.getActiveTools(),
    )
    if (intent === 'noop') return

    if (intent === 'activate') {
      this.enabled = true
      this.writeState()
      const anyActive = Array.from(this.watches.values()).some((w) => !w.terminal)
      if (anyActive && !this.sharedScheduler.isRunning) {
        this.startPolling()
      }
      this.refreshStatus()
      if (this.hasWidget && this.widget !== null) {
        if (this.displayMode === 'widget') this.widget.show(ctx)
        else this.widget.hide(ctx)
      }
    } else {
      // Deactivate — stop LLM access but keep polling (notifications still fire)
      this.enabled = false
      this.writeState()
      this.refreshStatus()
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle — session_shutdown
  // -------------------------------------------------------------------------

  onSessionShutdown(ctx: unknown): void {
    this.stopPolling()
    try {
      if (this.widget !== null) {
        this.widget.hide(ctx)
        this.widget.destroy()
      }
    } catch {
      // UI may already be torn down — swallow safely
    }
    this.ui = null
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  startPolling(): void {
    this.sharedScheduler.start(() => this.pollOnce())
  }

  stopPolling(): void {
    this.sharedScheduler.stop()
  }

  /**
   * Poll a single watch identified by `watchKey`.
   *
   * - Returns early when the watch is not found or already terminal.
   * - Runs `detectChanges`, handles errors in isolation.
   * - Emits a change chat message and writes state when events are produced.
   * - For user-tool watchers: marks terminal when events fire, stops polling
   *   when no active watches remain.
   * - Always emits `eventChannel` and calls `refreshStatus` on exit.
   */
  async pollWatch(watchKey: string): Promise<void> {
    const watch = this.watches.get(watchKey)
    if (watch === undefined || watch.terminal) return

    const nowTs = this._now()
    const scheduler = this.schedulerFor(watchKey)
    const allEvents: TEvent[] = []
    let anyObservedChange = false

    try {
      const result = await this.detectChanges(watch)

      // Recovery notification
      const prevErrors = watch.consecutiveErrors
      watch.consecutiveErrors = 0
      if (prevErrors >= POLL_ERROR_THRESHOLD) {
        this._pi.sendMessage(
          {
            customType: this.customMessageType,
            content: `✓ ${this.statusLabel}: ${watchKey} recovered after ${prevErrors} consecutive error(s).`,
            display: true,
          },
          { deliverAs: 'followUp', triggerTurn: false },
        )
      }

      // Store fresh baseline
      this.baselines.set(watchKey, result.newBaseline)

      // Stamp last-polled time if the watch has the optional field
      const anyWatch = watch as WatchLike & { lastPolledAt?: number }
      if ('lastPolledAt' in anyWatch) anyWatch.lastPolledAt = nowTs

      if (result.observedChange) anyObservedChange = true
      if (result.events.length > 0) {
        allEvents.push(...result.events)
        // For user-tool watchers mark terminal only when the batch is terminal
        if (this.itemSource === 'user-tool' && this.containsTerminalStateEvent(result.events)) watch.terminal = true
      }
    } catch (err) {
      watch.consecutiveErrors += 1
      const classified = this.classifyError(err)

      if (classified.shouldBackoff) scheduler.noteBackoff()

      this._pi.appendEntry(`${this.extensionName}:poll-error`, {
        watchKey,
        message: classified.userMessage,
      })

      if (watch.consecutiveErrors === POLL_ERROR_THRESHOLD) {
        this._pi.sendMessage(
          {
            customType: this.customMessageType,
            content:
              `⚠ ${this.statusLabel}: ${watchKey} has failed ` +
              `${POLL_ERROR_THRESHOLD} consecutive polls. ` +
              `Last error: ${classified.userMessage}`,
            display: true,
          },
          { deliverAs: 'followUp', triggerTurn: true },
        )
      }
    }

    if (allEvents.length > 0) {
      const content = this.buildChangeChatMessage(allEvents, new Date(nowTs))
      const reactivationHint =
        this.itemSource === 'user-tool' && !this.enabled
          ? `\nRun manage_tools({action:"activate", tools:["${this.toolName}"]}) to manage this watcher.`
          : ''
      this._pi.sendMessage(
        {
          customType: this.customMessageType,
          content: content + reactivationHint,
          display: true,
          details: { events: allEvents },
        },
        { deliverAs: 'followUp', triggerTurn: true },
      )
      this.writeState()
    }

    this.noteSchedulerSuccess(anyObservedChange, watchKey)

    // Stop per-watch scheduler when the watch goes terminal
    // (no-op for the shared scheduler; meaningful for subclass per-watch schedulers)
    if (watch.terminal) {
      const sch = this.schedulerFor(watchKey)
      if (sch !== this.sharedScheduler) sch.stop()
    }

    // Stop polling once all user-tool watches are terminal
    if (this.itemSource === 'user-tool') {
      const stillActive = Array.from(this.watches.values()).some((w) => !w.terminal)
      if (!stillActive) this.stopPolling()
    }

    this._pi.events.emit(this.eventChannel, {})
    this.refreshStatus()
  }

  /**
   * Single poll cycle.
   *
   * For `itemSource === "scan"`: calls `scanItems()` to refresh the watch list
   * before iterating. For `itemSource === "user-tool"`: iterates the persisted
   * watch map directly.
   *
   * All active watches are polled in parallel via `Promise.all`. Individual
   * errors are isolated inside `pollWatch`.
   */
  async pollOnce(): Promise<void> {
    // Scan watchers: refresh watch list from data source
    if (this.itemSource === 'scan' && this.scanItems !== undefined) {
      const items = await this.scanItems()
      // Add / update
      for (const item of items) {
        this.watches.set(this.watchKey(item), item)
      }
      // Remove items that have disappeared from the scan
      const scannedKeys = new Set(items.map((i) => this.watchKey(i)))
      for (const key of Array.from(this.watches.keys())) {
        if (!scannedKeys.has(key)) this.watches.delete(key)
      }
    }

    const active = Array.from(this.watches.entries()).filter(([, w]) => !w.terminal)
    if (active.length === 0) {
      this.refreshStatus()
      return
    }

    await Promise.all(active.map(([key]) => this.pollWatch(key)))
  }

  // -------------------------------------------------------------------------
  // State persistence
  // -------------------------------------------------------------------------

  /**
   * Append a combined-state entry to the session log.
   * Best-effort — errors from `appendEntry` are swallowed.
   */
  writeState(): void {
    try {
      const watchesArr = Array.from(this.watches.values())
      const baselinesObj: Record<string, TBaseline> = {}
      for (const [k, v] of this.baselines) baselinesObj[k] = v
      this._pi.appendEntry(this.stateCustomType, {
        savedAt: this._now(),
        watches: watchesArr,
        baselines: baselinesObj,
        enabled: this.enabled,
        displayMode: this.displayMode,
      })
    } catch {
      // Best-effort — never block user-facing actions on persistence failures
    }
  }

  // -------------------------------------------------------------------------
  // Purge
  // -------------------------------------------------------------------------

  /**
   * Remove all terminal watches from `this.watches` and `this.baselines`.
   * Persists state, emits the change event, and refreshes the status line.
   * Returns the list of removed watches (for visual list updates in the browse view).
   * No-op for scan watchers (returns empty array).
   */
  protected executePurge(): TWatch[] {
    if (this.itemSource !== 'user-tool') return []
    const removed: TWatch[] = []
    for (const [key, watch] of this.watches) {
      if (watch.terminal) {
        removed.push(watch)
        this.watches.delete(key)
        this.baselines.delete(key)
      }
    }
    if (removed.length > 0) {
      this.writeState()
      this._pi.events.emit(this.eventChannel, {})
      this.refreshStatus()
    }
    return removed
  }

  // -------------------------------------------------------------------------
  // Status row
  // -------------------------------------------------------------------------

  /**
   * Re-pin (or clear) the `ui.setStatus` row.
   *
   * When `displayMode === "widget"`, clears the status pin so only the widget
   * is visible. When `displayMode === "statusline"`, renders a compact count
   * with color alias based on paused/error state.
   */
  refreshStatus(): void {
    if (this.displayMode !== 'statusline') {
      this.ui?.setStatus?.(this.statusKey, undefined)
      return
    }

    const activeCount = Array.from(this.watches.values()).filter(
      (w) => !w.terminal,
    ).length

    if (activeCount === 0) {
      this.ui?.setStatus?.(this.statusKey, undefined)
      return
    }

    const hasErrors = Array.from(this.watches.values()).some(
      (w) => !w.terminal && w.consecutiveErrors >= POLL_ERROR_THRESHOLD,
    )
    const modifier = hasErrors ? ('auth-error' as const) : ('none' as const)
    const alias = statusLineColorAlias(modifier)

    const suffix = hasErrors ? ' (errors)' : ''
    const text = `${this.statusLabel}: ${activeCount}${suffix}`

    this.ui?.setStatus?.(this.statusKey, colorize(this.ui?.theme, alias, text))
  }

  // -------------------------------------------------------------------------
  // Command handler (slash command entry point)
  // -------------------------------------------------------------------------

  /**
   * Returns a pi command handler that opens the declarative menu loop.
   * Wired via `pi.registerCommand(this.extensionName, { handler: ... })` in
   * `register()`.
   */
  commandHandler(): (
    _args: string | undefined,
    ctx: unknown,
  ) => Promise<void> {
    return async (_args, ctx) => {
      const surface = extractUiSurface(ctx)

      if (!surface) {
        // No interactive UI (ctx.hasUI is false or ui is absent).
        // Fall back to the session-stored surface so the notification is visible.
        this.ui?.notify?.(
          `${this.extensionName}: requires an interactive UI.`,
          'warning',
        )
        return
      }

      const { openMenuView } = await import('./browse-view.js')

      await openMenuView(
        this.displayName,
        () => {
          const state = this._currentState()
          return this.buildMenu()
            .filter((m) => m.visible === undefined || m.visible(state))
            .map((m) => ({
              id: m.id,
              label: m.label(state),
              disabled: m.disabled?.(state) ?? false,
              run: async () => {
                const commandCtx = this._makeCommandCtx(surface ?? this.ui ?? {}, state, ctx)
                return m.run(commandCtx)
              },
            }))
        },
        ctx,
      )
    }
  }

  /**
   * Override to supply additional `BrowseViewOptions` merged into the default
   * options constructed by `browseAction`. Use to set `searchable`,
   * `rowActions`, `onRemove`, `onRefresh`, etc.
   */
  protected browseOptions(): Partial<BrowseViewOptions<TWatch>> {
    return {}
  }

  /**
   * Open the shared browse-view overlay.
   * Called from the "Browse" menu item and from `CommandCtx.browse()`.
   */
  async browseAction(ctx: unknown): Promise<'stay' | 'close'> {
    const surface = extractUiSurface(ctx)
    const anyCtx = ctx as {
      ui?: {
        custom?: <T>(
          factory: (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (v: T) => void,
          ) => unknown,
          options?: unknown,
        ) => Promise<T>
      }
    }

    if (!anyCtx?.ui?.custom) {
      surface?.notify?.(
        `${this.extensionName}: browse requires an interactive UI.`,
        'warning',
      )
      return 'stay'
    }

    const { openBrowseView } = await import('./browse-view.js')
    const watches = Array.from(this.watches.values())
    const activeCount = watches.filter((w) => !w.terminal).length
    let quit = false
    const baseOpts: BrowseViewOptions<TWatch> = {
      title: this.displayName,
      watches,
      view: this.view,
      filter: (w, q) => this.browseFilter(w, q),
      header: (s) => this.browseHeader({ ...s, activeCount }),
      onQuit: () => { quit = true },
    }
    const opts: BrowseViewOptions<TWatch> = { ...baseOpts, ...this.browseOptions() }
    // Hide the widget so the docked overlay has a clean bottom area
    this.widget?.hide(ctx)
    try {
      await openBrowseView(opts, anyCtx)
    } finally {
      this.widget?.show(ctx)
    }
    return quit ? 'close' : 'stay'
  }

  // -------------------------------------------------------------------------
  // Menu construction
  // -------------------------------------------------------------------------

  /**
   * Assemble the menu item list from built-in defaults and capability flags,
   * then pass through `customizeMenu()` for subclass overrides.
   *
   * Built-in items (in order):
   *   - Browse <noun>s (N)
   *   - Refresh                — scan watchers only
   *   - Paused: on/off
   *   - Display mode: widget/statusline  — hasWidget only
   *   - Close
   */
  buildMenu(): MenuItem[] {
    const items: MenuItem[] = []

    // Browse
    items.push({
      id: 'browse',
      label: (state) =>
        `Browse ${this.view.nounPlural ?? this.view.noun + 's'} (${this.browseCount(state)})`,
      disabled: (state) => state.watchCount === 0,
      run: (ctx) => ctx.browse(),
    })

    // Purge completed watches (user-tool watchers only) — inserted after browse
    if (this.itemSource === 'user-tool') {
      items.push({
        id: 'purge',
        label: (state) => `Purge completed (${state.watchCount - state.activeCount})`,
        disabled: (state) => (state.watchCount - state.activeCount) === 0,
        run: async (ctx): Promise<MenuResult> => {
          const count = ctx.state.watchCount - ctx.state.activeCount
          if (count === 0) return 'stay'
          const ok = await ctx.confirm(
            `Purge ${count} completed watch${count === 1 ? '' : 'es'}?`,
            `Yes, purge ${count}`,
          )
          if (!ok) return 'stay'
          const removed = this.executePurge()
          ctx.ui.notify?.(
            `${this.statusLabel}: purged ${removed.length} completed watch${removed.length === 1 ? '' : 'es'}.`,
            'info',
          )
          return 'rerender'
        },
      })
    }

    // Refresh (scan watchers only)
    if (this.itemSource === 'scan') {
      items.push({
        id: 'refresh',
        label: () => 'Refresh',
        run: (ctx): Promise<MenuResult> => {
          ctx.refresh()
          return Promise.resolve('rerender')
        },
      })
    }

    // Display mode toggle (widget-capable watchers only)
    if (this.hasWidget) {
      items.push({
        id: 'displayMode',
        label: (state) => `Display mode: ${state.displayMode}`,
        run: (ctx): Promise<MenuResult> => {
          ctx.setDisplayMode(ctx.state.displayMode === 'widget' ? 'statusline' : 'widget')
          return Promise.resolve('rerender')
        },
      })

      // User default display mode (persisted preference)
      items.push({
        id: 'userDefaultDisplayMode',
        label: (state) => `Default display mode: ${state.userDefaultDisplayMode ?? 'unset'}`,
        run: (ctx): Promise<MenuResult> => {
          const current = this.userDefaultDisplayMode
          const next: 'widget' | 'statusline' | undefined =
            current === undefined ? 'widget'
            : current === 'widget' ? 'statusline'
            : undefined
          try {
            this.saveUserDefaultDisplayMode(next)
            const label = next ?? 'unset'
            ctx.ui.notify?.(`${this.statusLabel}: default display → ${label} (saved).`, 'info')
          } catch (err) {
            ctx.ui.notify?.(
              `${this.statusLabel}: failed to save default display mode — ${err instanceof Error ? err.message : String(err)}`,
              'warning',
            )
          }
          return Promise.resolve('rerender')
        },
      })
    }

    // Close
    items.push({
      id: 'close',
      label: () => 'Close',
      run: (): Promise<MenuResult> => Promise.resolve('close'),
    })

    return this.customizeMenu(items)
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Snapshot of current state for menu labels and CommandCtx. */
  protected _currentState(): WatcherState {
    const allWatches = Array.from(this.watches.values())
    const activeCount = allWatches.filter((w) => !w.terminal).length
    const hasErrors = allWatches.some(
      (w) => !w.terminal && w.consecutiveErrors >= POLL_ERROR_THRESHOLD,
    )
    const ud = this.userDefaultDisplayMode
    return {
      pollIntervalMs: this.sharedScheduler.intervalMs,
      enabled: this.enabled,
      displayMode: this.displayMode,
      watchCount: allWatches.length,
      activeCount,
      hasErrors,
      ...(ud !== undefined ? { userDefaultDisplayMode: ud } : {}),
    }
  }

  /** Build the CommandCtx passed to MenuItem.run(). */
  private _makeCommandCtx(
    surface: UiSurface,
    state: WatcherState,
    ctx: unknown,
  ): CommandCtx {
    return {
      ui: surface,
      state,
      browse: () => this.browseAction(ctx),
      refresh: () => this.refreshStatus(),

      setDisplayMode: (mode) => {
        this.displayMode = mode
        this.writeState()
        if (this.hasWidget && this.widget !== null) {
          if (mode === 'widget') {
            this.ui?.setStatus?.(this.statusKey, undefined)
            this.widget.show(ctx)
          } else {
            this.widget.hide(ctx)
            this.refreshStatus()
          }
        } else {
          this.refreshStatus()
        }
      },
      setUserDefault: () => {
        // Default no-op. Subclasses that support persisted user defaults
        // should override this method via customizeMenu + RowAction.
      },
      confirm: async (message, confirmLabel) => {
        const { openMenuView } = await import('./browse-view.js')
        let confirmed = false
        await openMenuView(message, () => [
          {
            id: 'yes',
            label: confirmLabel ?? 'Confirm',
            run: () => { confirmed = true; return Promise.resolve<MenuResult>('close') },
          },
          {
            id: 'no',
            label: 'Cancel',
            run: () => Promise.resolve<MenuResult>('close'),
          },
        ], ctx)
        return confirmed
      },
    }
  }

  /** Walk the session log newest→oldest and restore watches, baselines, flags. */
  private _rehydrateState(ctx: SessionLike): void {
    let entries: SessionEntry[]
    try {
      entries = ctx.sessionManager.getEntries()
    } catch {
      return
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (
        entry === undefined ||
        entry.type !== 'custom' ||
        entry.customType !== this.stateCustomType
      ) {
        continue
      }
      const data = entry.data as Record<string, unknown> | undefined
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue

      const savedAt =
        typeof data['savedAt'] === 'number' ? data['savedAt'] : NaN
      if (!Number.isFinite(savedAt)) continue

      const rawWatches = data['watches']
      if (!Array.isArray(rawWatches)) continue

      // Valid entry found — apply it
      this.enabled =
        typeof data['enabled'] === 'boolean' ? data['enabled'] : false
      this.displayMode =
        data['displayMode'] === 'statusline' ? 'statusline' : 'widget'

      for (const raw of rawWatches) {
        const w = this.normaliseWatch(raw)
        if (w !== null) this.watches.set(this.watchKey(w), w)
      }

      const rawBaselines = data['baselines']
      if (
        rawBaselines !== null &&
        rawBaselines !== undefined &&
        typeof rawBaselines === 'object' &&
        !Array.isArray(rawBaselines)
      ) {
        for (const [k, v] of Object.entries(
          rawBaselines as Record<string, unknown>,
        )) {
          const b = this.normaliseBaseline(v)
          if (b !== null) this.baselines.set(k, b)
        }
      }

      return // Stop at the first valid entry (newest wins)
    }
  }

  /** Seed baselines for watches that lack one. */
  private async _seedMissingBaselines(): Promise<void> {
    for (const [key, watch] of this.watches) {
      if (watch.terminal || this.baselines.has(key)) continue
      try {
        const baseline = await this.snapshot(watch)
        this.baselines.set(key, baseline)
      } catch (err) {
        this._pi.appendEntry(`${this.extensionName}:seed-error`, {
          watchKey: key,
          message: (err as Error)?.message ?? String(err),
        })
      }
    }
  }
}
