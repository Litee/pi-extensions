/**
 * Unit tests for watcher-widget pure helpers.
 *
 * Only tests `formatWidgetHeader` and `formatWidgetFooter` — the pure
 * text-generation functions that are exercisable without a live pi-tui
 * runtime. The full `createWatcherWidget` factory (which creates a
 * Container + DynamicBorder shell and subscribes to pi.events) is
 * integration-only and excluded from unit-test coverage.
 */

import { describe, expect, it, vi } from 'vitest'

import { createWatcherWidget, formatWidgetFooter, formatWidgetHeader } from '../src/watcher-widget.js'
import type { WatcherWidgetOptions, WatchLike } from '../src/base-watcher-types.js'

// ---------------------------------------------------------------------------
// formatWidgetHeader
// ---------------------------------------------------------------------------

describe('formatWidgetHeader', () => {
  it('formats header as "name (active/total)"', () => {
    expect(formatWidgetHeader('AWS S3 Watcher', 2, 3)).toBe('AWS S3 Watcher (2/3)')
  })
  it('shows (0/3) when all terminal', () => {
    expect(formatWidgetHeader('X', 0, 3)).toBe('X (0/3)')
  })
  it('shows (3/3) when all active', () => {
    expect(formatWidgetHeader('X', 3, 3)).toBe('X (3/3)')
  })
})

// ---------------------------------------------------------------------------
// formatWidgetFooter — Fix 2: widget is display-only, points to command menu
// ---------------------------------------------------------------------------

describe('formatWidgetFooter', () => {
  it('points to command menu instead of hotkeys', () => {
    expect(formatWidgetFooter('s3-watcher')).toBe('/s3-watcher for menu')
  })

  it('uses the provided command name', () => {
    expect(formatWidgetFooter('glue-watcher')).toContain('glue-watcher')
  })

  it('always returns a non-empty string', () => {
    expect(formatWidgetFooter('my-watcher').length).toBeGreaterThan(0)
  })

  it('does not mention p pause or q/esc hotkeys', () => {
    const footer = formatWidgetFooter('s3-watcher')
    expect(footer).not.toContain('p pause')
    expect(footer).not.toContain('q/esc')
  })
})

// ---------------------------------------------------------------------------
// WatcherWidgetImpl — setWidget guard (#0002)
// ---------------------------------------------------------------------------

type SimpleWatch = WatchLike & { id: string }

function makeWidget(watches: SimpleWatch[]) {
  const setWidget = vi.fn()
  const ctx = { ui: { setWidget } }

  let listener: (() => void) | undefined

  const opts: WatcherWidgetOptions<SimpleWatch> = {
    extensionName: 'test-watcher',
    getWatches: () => watches,
  }

  const view = {
    renderItemRowText: (w: SimpleWatch) => w.id,
    renderWidgetRows: () => ['row'],
  } as unknown as Parameters<typeof createWatcherWidget>[1]

  // piEvents mock: cast through unknown to satisfy ExtensionAPI['events'] shape
  const piEvents = {
    on: (_channel: string, cb: (...args: unknown[]) => void) => {
      listener = cb
      return () => { listener = undefined }
    },
    emit: vi.fn(),
  } as unknown as Parameters<typeof createWatcherWidget>[0]

  const widget = createWatcherWidget(piEvents, view, opts)
  return { widget, ctx, setWidget, fireChange: () => listener?.() }
}

describe('WatcherWidgetImpl — setWidget guard (#0002)', () => {
  it('calls setWidget exactly once on initial show()', () => {
    const watches: SimpleWatch[] = [{ id: 'w1', terminal: false, consecutiveErrors: 0 }]
    const { widget, ctx, setWidget } = makeWidget(watches)
    widget.show(ctx)
    expect(setWidget).toHaveBeenCalledTimes(1)
  })

  it('does NOT call setWidget again when refresh() fires after initial show()', () => {
    const watches: SimpleWatch[] = [{ id: 'w1', terminal: false, consecutiveErrors: 0 }]
    const { widget, ctx, setWidget, fireChange } = makeWidget(watches)
    widget.show(ctx)
    setWidget.mockClear()

    // Simulate poll cycle firing the change event multiple times
    fireChange()
    fireChange()
    fireChange()

    expect(setWidget).not.toHaveBeenCalled()
  })

  it('does NOT call setWidget in refresh() after hide() — re-registration requires a new show() call (#0002)', () => {
    const watches: SimpleWatch[] = [{ id: 'w1', terminal: false, consecutiveErrors: 0 }]
    const { widget, ctx, setWidget, fireChange } = makeWidget(watches)
    widget.show(ctx)
    widget.hide(ctx)
    setWidget.mockClear()

    // refresh() after hide() should NOT call setWidget — ctx is cleared by
    // hide(), so the refresh guard already exits early. Re-registration
    // happens on the next show() call (e.g. next onTurnEnd).
    fireChange()
    expect(setWidget).not.toHaveBeenCalled()

    // Explicit show() re-registers.
    widget.show(ctx)
    expect(setWidget).toHaveBeenCalledTimes(1)
  })

  it('does not call setWidget when show() is called with no watches', () => {
    const { widget, ctx, setWidget } = makeWidget([])
    widget.show(ctx)
    expect(setWidget).not.toHaveBeenCalledWith('test-watcher', expect.any(Function), expect.anything())
  })
})

// ---------------------------------------------------------------------------
// _renderWidget faint dimming
// ---------------------------------------------------------------------------

/**
 * Minimal theme stub for _renderWidget: passes text through unchanged so the
 * raw ANSI escapes (faint markers) are visible in the rendered output.
 */
const stubTheme = {
  fg: (_alias: string, text: string) => text,
  bold: (text: string) => text,
}

type RenderWatch = WatchLike & { id: string }

function makeWidgetForRender(watches: RenderWatch[]) {
  const setWidget = vi.fn()
  const ctx = { ui: { setWidget } }

  const opts: WatcherWidgetOptions<RenderWatch> = {
    extensionName: 'test-render-watcher',
    getWatches: () => watches,
  }

  // Richer view stub: provides renderItemRowTUI and isRowDimmed so
  // _renderWidget can complete without a live pi-tui session.
  const view = {
    renderItemRowText: (w: RenderWatch) => w.id,
    renderItemRowTUI: (w: RenderWatch, _ctx: unknown) => [
      { name: 'id', text: w.id },
      { name: 'status', text: w.terminal ? 'DONE' : 'WATCHING', width: 10, color: 'warning' },
    ],
    isRowDimmed: (w: RenderWatch) => w.terminal,
  } as unknown as Parameters<typeof createWatcherWidget>[1]

  const piEvents = {
    on: (_channel: string, _cb: (...args: unknown[]) => void) => () => {},
    emit: vi.fn(),
  } as unknown as Parameters<typeof createWatcherWidget>[0]

  const widget = createWatcherWidget(piEvents, view, opts)
  widget.show(ctx)

  // show() calls ctx.ui.setWidget(id, factory, opts). The factory is at index 1.
  // Call factory(null, stubTheme) → { render(width): string[] }
  // then call render(width) to exercise the real _renderWidget code path.
  type WidgetFactory = (tui: unknown, theme: unknown) => { render(w: number): string[] }
  const factory = setWidget.mock.calls[0]?.[1] as WidgetFactory | undefined

  const renderWidget = (width = 80): string => {
    if (!factory) throw new Error('setWidget was not called — no watches?')
    return factory(null, stubTheme).render(width).join('\n')
  }

  return { renderWidget }
}

describe('_renderWidget faint dimming', () => {
  it('terminal watch row is wrapped with SGR-2 faint (\\x1b[2m … \\x1b[22m)', () => {
    const { renderWidget } = makeWidgetForRender([
      { id: 'done-job', terminal: true, consecutiveErrors: 0 },
    ])
    const output = renderWidget()
    expect(output).toContain('\x1b[2m')
    expect(output).toContain('\x1b[22m')
  })

  it('active watch row contains no faint escapes', () => {
    const { renderWidget } = makeWidgetForRender([
      { id: 'live-job', terminal: false, consecutiveErrors: 0 },
    ])
    const output = renderWidget()
    expect(output).not.toContain('\x1b[2m')
  })

  it('mixed list: terminal row is faint-wrapped, active row is not', () => {
    const { renderWidget } = makeWidgetForRender([
      { id: 'active-job', terminal: false, consecutiveErrors: 0 },
      { id: 'done-job', terminal: true, consecutiveErrors: 0 },
    ])
    const output = renderWidget()
    const lines = output.split('\n')

    const terminalLine = lines.find((l) => l.includes('done-job'))
    const activeLine = lines.find((l) => l.includes('active-job'))

    expect(terminalLine, 'terminal watch line should be found').toBeDefined()
    expect(activeLine, 'active watch line should be found').toBeDefined()

    expect(terminalLine).toContain('\x1b[2m')
    expect(terminalLine).toContain('\x1b[22m')
    expect(activeLine).not.toContain('\x1b[2m')
  })
})
