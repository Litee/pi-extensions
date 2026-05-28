/**
 * Shared types and interfaces for the BaseWatcher abstraction.
 *
 * Consumed by base-watcher.ts, browse-view.ts, and watcher-widget.ts.
 * Import from concrete watcher packages is intentionally forbidden —
 * pi-watcher-core must not depend on its consumers.
 */

import type { Theme } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import type { UiSurface } from './ui-surface.js'

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/**
 * How the watcher's `TWatch` list is populated.
 *
 * - `"user-tool"` — a registered LLM tool (`s3_watcher`, `glue_watcher`, …)
 *   drives `add` / `remove`. Watches are persisted across sessions.
 *   `register()` will call `pi.registerTool(...)` automatically.
 *
 * - `"scan"` — the watcher scans a data source on each poll cycle (e.g.
 *   reading a filesystem directory, calling an API without explicit watch IDs).
 *   No LLM tool is registered. `scanItems()` must be implemented.
 */
export type WatcherItemSource = 'user-tool' | 'scan'

// ---------------------------------------------------------------------------
// Minimum watch shape
// ---------------------------------------------------------------------------

/**
 * Minimum shape every `TWatch` must satisfy so the base class can drive the
 * poll loop and error bookkeeping without knowing the domain.
 */
export interface WatchLike {
  /** True once the watch's terminal condition has fired (or it was removed). */
  terminal: boolean
  /** Consecutive poll failures; reset to 0 on any successful poll. */
  consecutiveErrors: number
}

// ---------------------------------------------------------------------------
// Runtime state snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot of the watcher's current runtime state. Passed to
 * `MenuItem.label()`, `MenuItem.visible?()`, and `browseCount()` so menu
 * labels stay in sync with runtime state without requiring direct access to
 * the watcher instance.
 */
export interface WatcherState {
  paused: boolean
  pollIntervalMs: number
  /** Whether the LLM tool is active in the current session (user-tool only). */
  enabled: boolean
  displayMode: 'widget' | 'statusline'
  /** Total watches (including terminal). */
  watchCount: number
  /** Non-terminal watches. */
  activeCount: number
  /** Any watch is at or above the error threshold. */
  hasErrors: boolean
  /** User-persisted default display mode preference. `undefined` = no preference saved. */
  userDefaultDisplayMode?: 'widget' | 'statusline'
}

// ---------------------------------------------------------------------------
// View context objects
// ---------------------------------------------------------------------------

/** Context passed to `WatcherView.renderItemRowTUI`. */
export interface RowCtx {
  theme: Theme
  width: number
}

/** Context passed to `WatcherView.renderItemDetail`. */
export interface DetailCtx {
  theme: Theme
  width: number
  /** Current effective poll interval for this watch in ms. */
  pollIntervalMs?: number
}

// ---------------------------------------------------------------------------
// Structured render types
// ---------------------------------------------------------------------------

/**
 * A single labelled field in a detail pane.
 * The base class renders these as a two-column aligned table:
 *
 *   target:   exists
 *   profile:  my-profile
 *   region:   us-east-1
 */
export interface DetailField {
  label: string
  value: string
}

/**
 * A single column in a TUI row.
 *
 * Columns with `width` set are fixed. Columns without `width` are flexible
 * and share the remaining terminal width equally. When rendered, text is
 * truncated with `…` if it exceeds the column width.
 *
 * `color` is a theme alias passed to `theme.fg(color, text)`.
 * When absent, text is rendered without colouring.
 */
export interface RowColumn {
  /** Stable column identifier used by `compressColumns` to target specific columns. */
  name: string
  text: string
  /** Fixed width in chars. Omit for a flexible (fill) column. */
  width?: number
  align?: 'left' | 'right'
  color?: string
}

// ---------------------------------------------------------------------------
// WatcherView — domain-specific rendering hooks
// ---------------------------------------------------------------------------

/**
 * Rendering contract that each watcher subclass provides.
 *
 * Pure functions — no side effects, no I/O. The TUI components
 * (browse-view, watcher-widget) call these to render rows and details.
 */
export interface WatcherView<TWatch, TEvent> {
  /**
   * Singular noun for a watch item, e.g. `"watch"`, `"issue"`, `"job"`.
   * Used by default `browseHeader` and `browseCount` implementations.
   */
  noun: string
  /**
   * Optional explicit plural. Defaults to `noun + "s"` when absent.
   * Override for irregular forms: `"issue"` → `"issues"` (regular, no override
   * needed); a hypothetical `"query"` → `"queries"` (irregular, override).
   */
  nounPlural?: string

  /** Plain-text label for a watch row. Used for filter matching in browse. */
  renderItemRowText(watch: TWatch): string
  /**
   * Themed TUI render of a watch row as an array of columns.
   * Passed to `renderRowColumns` to produce a single terminal-width string.
   */
  renderItemRowTUI(watch: TWatch, ctx: RowCtx): RowColumn[]
  /**
   * Detail pane for a selected watch as an array of labelled fields.
   * Passed to `renderDetailFields` to produce aligned `label:  value` lines.
   */
  renderItemDetail(watch: TWatch, ctx: DetailCtx): DetailField[]
  /**
   * Single-line text summary of a change event, used in chat messages.
   * Should start with a bullet: `"• s3://bucket/key — object now exists"`.
   */
  renderEventRow(event: TEvent): string

  /**
   * Optional row-level compression hook. Called with ALL columns for a watch
   * row and the total available terminal width BEFORE `renderRowColumns` lays
   * them out.
   *
   * Use to apply domain-specific compression: shrink or drop individual
   * column values based on available space and cross-column knowledge.
   *
   * Return a new (or the same) `RowColumn[]`. The returned array is passed
   * directly to `renderRowColumns`.
   *
   * When absent, `renderRowColumns` truncates overflowing text with `…`.
   */
  compressColumns?(columns: RowColumn[], totalWidth: number): RowColumn[]

  /**
   * Sort key for the browse list. Rows are sorted ascending by this key.
   * String keys sort lexicographically; number keys sort numerically.
   */
  itemSortKey(watch: TWatch): string | number
  /**
   * Optional grouping key. When provided, the browse list renders a group
   * header between consecutive watches whose group key differs.
   */
  itemGroup?(watch: TWatch): string | undefined
}

// ---------------------------------------------------------------------------
// Declarative menu system
// ---------------------------------------------------------------------------

/** Result returned by `MenuItem.run()`. */
export type MenuResult = 'stay' | 'close' | 'rerender'

/**
 * Callbacks available to `MenuItem.run()`.
 * Provided by the base class `commandHandler()` implementation.
 */
export interface CommandCtx {
  ui: UiSurface
  state: WatcherState
  /** Open the shared browse-view overlay. Returns 'close' if the user pressed q to quit entirely. */
  browse(): Promise<'stay' | 'close'>
  /** Force a synchronous status refresh (re-pins the status row). */
  refresh(): void
  /** Toggle `paused` and start/stop polling accordingly. */
  toggle(flag: 'paused'): void
  /** Set the session-scoped display mode (widget ↔ statusline). */
  setDisplayMode(mode: 'widget' | 'statusline'): void
  /** Persist the user-default display mode preference. Pass `undefined` to clear. */
  setUserDefault(mode: 'widget' | 'statusline' | undefined): void
}

/**
 * Declarative menu item consumed by the base class `commandHandler()` loop.
 *
 * `label(state)` is evaluated on every menu iteration so it can include
 * live counts and toggle indicators.
 * `visible?(state)` gates items behind capability flags (e.g. hide
 * "Display mode" for scan watchers that have no widget).
 */
export interface MenuItem {
  /** Stable identifier for tests and customization hooks. */
  id: string
  /** Display label, evaluated fresh on each menu open. */
  label(state: WatcherState): string
  /** Return false to hide this item; defaults to always visible. */
  visible?(state: WatcherState): boolean
  /** Return true to show the item dimmed and non-interactive; defaults to always enabled. */
  disabled?(state: WatcherState): boolean
  /** Execute the action and return the next menu state. */
  run(ctx: CommandCtx): Promise<MenuResult>
}

// ---------------------------------------------------------------------------
// Row actions (per-watch actions in browse + widget)
// ---------------------------------------------------------------------------

/**
 * An action button that can be attached to a watch row in the browse-view
 * and widget action bar.
 */
export interface RowAction<TWatch> {
  /** Stable identifier. */
  id: string
  /** Button label. */
  label: string
  /** Optional keybind hint displayed next to the button, e.g. `"d"`. */
  keybind?: string
  /** Return false to hide for a specific watch. */
  visible?(watch: TWatch): boolean
  /** Execute the action on the given watch. */
  run(watch: TWatch, ctx: CommandCtx): Promise<void>
}

// ---------------------------------------------------------------------------
// Browse view options
// ---------------------------------------------------------------------------

/**
 * Options passed to `openBrowseView`.
 *
 * `filter` and `header` have sensible defaults in `BaseWatcher` and only
 * need to be supplied when opening the view outside the watcher context.
 */
export interface BrowseViewOptions<TWatch> {
  /** Title shown in the browse overlay header. */
  title: string
  /** Current watch list (pre-sorted is fine; the view re-sorts internally). */
  watches: readonly TWatch[]
  /** Rendering contract. */
  view: WatcherView<TWatch, never>
  /** Optional per-row action buttons. */
  rowActions?: ReadonlyArray<RowAction<TWatch>>
  /** Called when the user removes the currently selected watch (via `ctrl+d` key). */
  onRemove?(watch: TWatch): void
  /**
   * Called when the user presses `ctrl+r` to force an immediate refresh of all items.
   * Typically triggers an immediate `pollOnce()`.
   */
  onRefresh?(): Promise<void>
  /**
   * Called when the user presses `ctrl+x` to drain all terminal watches.
   * The implementation should remove all terminal watches from the data source
   * and return the list of removed watches so the visual list stays in sync.
   */
  onDrain?(): TWatch[]
  /** Called when the user presses `q` to quit entirely (skip menu). */
  onQuit?: () => void
  /**
   * When `false`, the search input is hidden and all watches are always shown.
   * Defaults to `true`.
   */
  searchable?: boolean
  /** Called per-watch to get its current poll interval for the detail pane. */
  getPollIntervalMs?(watch: TWatch): number
  /** Returns true if `watch` matches `query`. */
  filter(watch: TWatch, query: string): boolean
  /** Header line above the list, e.g. `"12 watches (3 filtered)"`. */
  header(state: { count: number; filtered: number; paused?: boolean; activeCount?: number }): string
}

// ---------------------------------------------------------------------------
// Widget options
// ---------------------------------------------------------------------------

/**
 * Options passed to `createWatcherWidget`.
 */
export interface WatcherWidgetOptions<TWatch> {
  /** Extension name used for event channel subscription and widget ID. */
  extensionName: string
  /** Human-readable display name used in the widget header; falls back to extensionName. */
  displayName?: string
  /** The slash-command name shown in the widget footer hint. Defaults to `extensionName`. */
  commandName?: string
  /** Getter called on every refresh — always returns the latest watches. */
  getWatches(): readonly TWatch[]
  /** Optional per-row action buttons shown in the widget. */
  rowActions?: ReadonlyArray<RowAction<TWatch>>
  /** Returns current paused state for display in the widget header. */
  getPaused?(): boolean
}

// ---------------------------------------------------------------------------
// Widget lifecycle interface (returned by createWatcherWidget)
// ---------------------------------------------------------------------------

/**
 * Minimal widget lifecycle contract. Typed as a plain interface so the
 * abstract class can reference it without importing from watcher-widget.ts
 * (which would create a circular dependency once watcher-widget imports
 * the abstract class).
 */
export interface WatcherWidgetLike {
  show(ctx: unknown): void
  hide(ctx: unknown): void
  destroy(): void
  refresh(watches: readonly WatchLike[], state: WatcherState): void
}

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

/** Standard pi tool result (must match `AgentToolResult<unknown>`). */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
  terminate?: boolean
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by the `BaseWatcher` constructor.
 */
export interface BaseWatcherOptions {
  /**
   * The pi ExtensionAPI instance. Stored so lifecycle methods can call
   * `sendMessage`, `appendEntry`, etc. without requiring it to be passed
   * down through every method call. `register(pi)` ALSO accepts pi and
   * overwrites this value — pass the same instance to both for consistency.
   */
  pi: ExtensionAPI
  /** Injected API client. Domain-specific watchers narrow this to their SDK type. */
  client?: unknown
  /**
   * Overridable clock for deterministic tests. Defaults to `Date.now`.
   */
  now?: () => number
}
