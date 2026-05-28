/**
 * Unit tests for watcher-widget pure helpers.
 *
 * Only tests `formatWidgetHeader` and `formatWidgetFooter` — the pure
 * text-generation functions that are exercisable without a live pi-tui
 * runtime. The full `createWatcherWidget` factory (which creates a
 * Container + DynamicBorder shell and subscribes to pi.events) is
 * integration-only and excluded from unit-test coverage.
 */

import { describe, expect, it } from 'vitest'

import { formatWidgetFooter, formatWidgetHeader } from '../src/watcher-widget.js'

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
    expect(formatWidgetFooter('s3-watcher')).toBe('/s3-watcher for actions')
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
