/**
 * Shared below-editor TUI widget for pi watcher extensions.
 *
 * Creates a live panel anchored below the chat editor that displays the
 * current watch list using `WatcherView.renderItemRowTUI`. Automatically
 * re-renders when the `extensionName:change` event fires on `pi.events`.
 *
 * The widget manages its own 30-second refresh timer so timeout labels
 * (polling interval countdowns, deadlines) stay current.
 *
 * ## Layout
 *   ┌─────────────────────────────────────┐
 *   │ <extensionName> (N)                  │  ← header (DynamicBorder + Text)
 *   │ row 1                                │  ← renderItemRowTUI per watch
 *   │ row 2                                │
 *   │ p pause · q/esc close               │  ← footer hints
 *   └─────────────────────────────────────┘
 *
 * Pure helpers (`formatWidgetHeader`, `formatWidgetFooter`) are exported
 * for unit testing.
 *
 * The widget is read-only — use the command menu (browse view) for
 * detail inspection and row actions.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { DynamicBorder } from '@earendil-works/pi-coding-agent'
import { Container, Text } from '@earendil-works/pi-tui'

import type {
  WatcherState,
  WatcherWidgetLike,
  WatcherWidgetOptions,
  WatchLike,
  WatcherView,
} from './base-watcher-types.js'
import { renderRowColumns, renderDimmedRow } from './browse-view.js'

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Format the widget header: `<displayName> (N)` or `<displayName> (N) · PAUSED`.
 * Used in the DynamicBorder title row.
 */
export function formatWidgetHeader(extensionName: string, activeCount: number, totalCount: number): string {
  return `${extensionName} (${activeCount}/${totalCount})`
}

/**
 * Build the footer hint line shown at the bottom of the widget.
 * The widget is display-only — directs users to the command menu for actions.
 */
export function formatWidgetFooter(commandName: string): string {
  return `/${commandName} for menu`
}

// ---------------------------------------------------------------------------
// WatcherWidget implementation
// ---------------------------------------------------------------------------

class WatcherWidgetImpl<TWatch extends WatchLike, TEvent> implements WatcherWidgetLike {
  private ctx: unknown = undefined
  private refreshInterval: NodeJS.Timeout | undefined
  private readonly unsubscribe: () => void
  /**
   * Whether the widget panel is currently registered with `setWidget`.
   * Prevents `refresh()` from calling `setWidget` on every poll cycle,
   * which would cause pi to reorder panels (#0002).
   */
  private _registered = false

  constructor(
    private readonly piEvents: Pick<ExtensionAPI['events'], 'on' | 'emit'>,
    private readonly view: WatcherView<TWatch, TEvent>,
    private readonly opts: WatcherWidgetOptions<TWatch>,
    private readonly widgetId: string,
  ) {
    this.unsubscribe = this.piEvents.on(
      `${opts.extensionName}:change`,
      () => this.refresh(this.opts.getWatches(), this._makeState()),
    )
  }

  show(ctx: unknown): void {
    this.ctx = ctx
    const watches = this.opts.getWatches()

    if (watches.length === 0) {
      this.hide(ctx)
      return
    }

    if (!this._registered) {
      const anyCtx = ctx as { ui?: { setWidget?: (...args: unknown[]) => void } }
      anyCtx.ui?.setWidget?.(
        this.widgetId,
        (_tui: unknown, theme: unknown) => ({
          render: (width: number) => this._renderWidget(width, theme),
          invalidate: () => {},
        }),
        { placement: 'belowEditor' },
      )
      this._registered = true
    }

    if (this.refreshInterval === undefined) {
      this.refreshInterval = setInterval(
        () => this.refresh(this.opts.getWatches(), this._makeState()),
        30_000,
      )
    }
  }

  hide(ctx: unknown): void {
    const anyCtx = ctx as { ui?: { setWidget?: (...args: unknown[]) => void } }
    anyCtx.ui?.setWidget?.(this.widgetId, undefined)
    this._registered = false
    this.ctx = undefined
    if (this.refreshInterval !== undefined) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = undefined
    }
  }

  destroy(): void {
    this.unsubscribe()
    if (this.refreshInterval !== undefined) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = undefined
    }
  }

  refresh(_watches: readonly TWatch[], _state: WatcherState): void {
    if (this.ctx !== undefined) {
      if (!this._registered) {
        // Widget was hidden (e.g. watch list was empty); re-register now that
        // watches are present again.
        this.show(this.ctx)
      }
      // else: already registered — render callback already reads live watch
      // state via getWatches(), so no setWidget call needed. Skipping it
      // prevents pi from reordering panels on every poll cycle (#0002).
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private _renderWidget(width: number, theme: unknown): string[] {
    const t = theme as {
      fg(alias: string, text: string): string
      bold(text: string): string
    }

    const watches = this.opts.getWatches()
    const totalCount = watches.length
    const activeCount = watches.filter((w) => !w.terminal).length
    const name = this.opts.displayName ?? this.opts.extensionName
    const count = t.fg('dim', ` (${activeCount}/${totalCount})`)
    const footer = formatWidgetFooter(this.opts.commandName ?? this.opts.extensionName)

    const headerLine = `${t.fg('accent', t.bold(name))}${count}  ${t.fg('dim', footer)}`

    const container = new Container()
    const borderColor = (s: string) => t.fg('accent', s)
    container.addChild(new DynamicBorder(borderColor))
    container.addChild(
      new Text(headerLine, 1, 0),
    )

    const rowLines: string[] = []
    for (let i = 0; i < watches.length; i++) {
      const w = watches[i]
      if (w === undefined) continue
      // Render at width-1 to account for the 1-char left padding added by Text(…,1,0).
      // Strip first-column color (widget rows are plain; accent is reserved for browse selection).
      const rawCols = this.view.renderItemRowTUI(w, { theme: t as never, width: width - 2 })
      const baseCols = this.view.compressColumns
        ? this.view.compressColumns(rawCols, width - 2)
        : rawCols
      const { color: _drop, ...firstRest } = baseCols[0] ?? { name: '', text: '' }
      const cols = [{ ...firstRest } as typeof baseCols[0], ...baseCols.slice(1)]
      rowLines.push(this.view.isRowDimmed?.(w)
        ? renderDimmedRow(cols, width - 2, t)
        : renderRowColumns(cols, width - 2, t))
    }

    if (rowLines.length > 0) {
      container.addChild(new Text(rowLines.join('\n'), 1, 0))
    }

    container.addChild(new DynamicBorder(borderColor))
    return container.render(width)
  }

  private _makeState(): WatcherState {
    const watches = this.opts.getWatches()
    return {
      pollIntervalMs: 0,
      enabled: false,
      displayMode: 'widget',
      watchCount: watches.length,
      activeCount: watches.filter((w) => !w.terminal).length,
      hasErrors: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a widget that displays the watcher's current state below the editor.
 *
 * Call `widget.show(ctx)` from `onSessionStart` and `widget.hide(ctx)` from
 * `onSessionShutdown`. `widget.refresh(watches, state)` is called automatically
 * whenever the `extensionName:change` event fires on `pi.events`.
 *
 * @param piEvents  `pi.events` — used to subscribe to change notifications.
 * @param view      Rendering contract from the watcher subclass.
 * @param opts      Widget options including `extensionName`, `getWatches`, etc.
 */
export function createWatcherWidget<TWatch extends WatchLike, TEvent>(
  piEvents: Pick<ExtensionAPI['events'], 'on' | 'emit'>,
  view: WatcherView<TWatch, TEvent>,
  opts: WatcherWidgetOptions<TWatch>,
): WatcherWidgetLike {
  const widgetId = opts.extensionName
  return new WatcherWidgetImpl(piEvents, view, opts, widgetId)
}
