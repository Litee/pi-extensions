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
import type { WatcherWidgetOptions } from '../src/base-watcher-types.js'
import type { WatchLike } from '../src/base-watcher-types.js'

// ---------------------------------------------------------------------------
// formatWidgetHeader
// ---------------------------------------------------------------------------

describe('formatWidgetHeader', () => {
  it('formats header as "name (active/total)"', () => {
    expect(formatWidgetHeader('AWS S3 Watcher', 2, 3, false)).toBe('AWS S3 Watcher (2/3)')
  })
  it('shows PAUSED suffix when paused', () => {
    expect(formatWidgetHeader('AWS S3 Watcher', 2, 3, true)).toBe('AWS S3 Watcher (2/3) · PAUSED')
  })
  it('shows (0/3) when all terminal', () => {
    expect(formatWidgetHeader('X', 0, 3, false)).toBe('X (0/3)')
  })
  it('shows (3/3) when all active', () => {
    expect(formatWidgetHeader('X', 3, 3, false)).toBe('X (3/3)')
  })
})

// ---------------------------------------------------------------------------
// Change 6: formatWidgetHeader paused
// ---------------------------------------------------------------------------

describe('formatWidgetHeader paused', () => {
  it('shows PAUSED suffix when paused', () => {
    expect(formatWidgetHeader('AWS S3 Watcher', 2, 3, true)).toBe('AWS S3 Watcher (2/3) · PAUSED')
  })
  it('no suffix when not paused', () => {
    expect(formatWidgetHeader('AWS S3 Watcher', 2, 3, false)).toBe('AWS S3 Watcher (2/3)')
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
    getPaused: () => false,
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
