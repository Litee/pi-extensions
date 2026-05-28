/**
 * Shared two-mode TUI browse component for pi watcher extensions.
 *
 * Provides a consistent list+detail browse overlay for any `TWatch` type.
 * Pure logic (filter, sort) is exported at the bottom for unit testing
 * without requiring a live pi-tui runtime.
 *
 * ## Modes
 *   list   — header + search Input + SelectList of filtered/sorted watches
 *            + footer keybind hints
 *   detail — full detail pane from `view.renderItemDetail` + back hint
 *            + optional RowAction buttons
 *
 * ## Navigation
 *   - Esc in list mode:   close the overlay
 *   - Enter in list mode: open detail for highlighted row
 *   - Esc in detail mode: return to list (query + cursor preserved)
 *   - Ctrl-C anywhere:    close
 */

import { matchesKey, Container, Input, SelectList, Text } from '@earendil-works/pi-tui'
import { getSelectListTheme, DynamicBorder } from '@earendil-works/pi-coding-agent'
import type { BrowseViewOptions, DetailField, MenuResult, RowColumn } from './base-watcher-types.js'

// ---------------------------------------------------------------------------
// openBrowseView — TUI entry point
// ---------------------------------------------------------------------------

type CustomFn = <T>(
  factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
  options?: { overlay?: boolean; overlayOptions?: { width?: string; maxHeight?: string; anchor?: string } },
) => Promise<T>

type BrowseCtx = {
  ui?: {
    custom?: CustomFn
    theme?: {
      fg(alias: string, text: string): string
      bold(text: string): string
    }
  }
}

/** Chars reserved by SelectList for its selection pointer and trailing margin. */
const SELECT_LIST_OVERHEAD = 4

/**
 * Open the browse overlay for the given `opts.watches`.
 *
 * Requires `ctx.ui.custom` (available in interactive pi sessions). Returns
 * immediately (no-op) when that function is absent.
 *
 * This module is intentionally excluded from coverage — the TUI factory
 * function requires a live pi-tui runtime. The pure filter/sort helpers
 * (`filterWatches`, `sortWatches`) are exported separately and are fully
 * covered by `browse-view.test.ts`.
 */
export async function openBrowseView<TWatch>(
  opts: BrowseViewOptions<TWatch>,
  ctx: unknown,
): Promise<void> {
  const anyCtx = ctx as BrowseCtx
  if (!anyCtx?.ui?.custom) return

  await anyCtx.ui.custom<void>(
    (tui, _themeParam, _kb, done) => {
      const theme = anyCtx.ui?.theme ?? {
        fg: (_: string, t: string) => t,
        bold: (t: string) => t,
      }
      const requestRender = (tui as { requestRender: () => void }).requestRender.bind(tui)
      const inner = _buildBrowseComponent(opts, theme, requestRender, done) as {
        render(w: number): string[]
        invalidate(): void
        handleInput(data: string): void
      }
      const border = new DynamicBorder((s) => theme.fg('dim', s))
      return {
        render: (w: number) => [...border.render(w), ...inner.render(w), ...border.render(w)],
        invalidate: () => { border.invalidate(); inner.invalidate() },
        handleInput: (data: string) => inner.handleInput(data),
      }
    },
    { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'bottom-center' } },
  )
}

// ---------------------------------------------------------------------------
// openMenuView — persistent menu overlay with position preservation
// ---------------------------------------------------------------------------

/**
 * A single item in a `openMenuView` menu.
 */
export interface MenuViewItem {
  id: string
  label: string
  disabled?: boolean
  run: () => Promise<MenuResult>
}

/** Internal: the value resolved by the custom overlay when an item is selected. */
interface _MenuSelection {
  index: number
  item: MenuViewItem
}

/**
 * Open a persistent interactive menu overlay using a close→run→reopen loop.
 *
 * Each iteration opens a single `ctx.ui.custom` overlay.  When the user picks
 * an item the overlay is fully closed (awaited) **before** `item.run()` is
 * called, so menu and action overlays are never simultaneously active.
 *
 * After `item.run()` resolves:
 *   - `'close'`  → exit
 *   - `'stay'` / `'rerender'` → reopen at the same `selectedIndex`
 *
 * Requires `ctx.ui.custom`. Returns immediately (no-op) when absent or when
 * the items list is empty.
 */
export async function openMenuView(
  title: string,
  getItems: () => MenuViewItem[],
  anyCtx: unknown,
): Promise<void> {
  const ctxUi = (anyCtx as { ui?: { custom?: unknown } })?.ui
  if (typeof (ctxUi as { custom?: unknown })?.custom !== 'function') return

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const customFn = (ctxUi as { custom: Function }).custom.bind(ctxUi)

  let savedIndex = 0

  while (true) {
    const items = getItems()
    if (items.length === 0) break

    // Open menu overlay — resolves only when user picks an item or closes
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const sel = await (customFn as (
      factory: (
        tui: unknown,
        theme: unknown,
        kb: unknown,
        done: (result: _MenuSelection | null) => void,
      ) => unknown,
    ) => Promise<_MenuSelection | null>)(
      (
        _tui: unknown,
        _theme: unknown,
        _kb: unknown,
        done: (result: _MenuSelection | null) => void,
      ) => {
        const theme = (anyCtx as { ui?: { theme?: unknown } })?.ui?.theme as
          | { fg(alias: string, text: string): string; bold(text: string): string }
          | undefined

        const slItems = items.map((i) => ({ value: i.id, label: i.label }))
        const sl = new SelectList(slItems, Math.min(slItems.length + 2, 20), getSelectListTheme())
        const slInt = sl as unknown as {
          selectedIndex: number
          filteredItems: { value: string; label: string }[]
        }
        slInt.selectedIndex = Math.min(savedIndex, Math.max(0, items.length - 1))

        // Patch renderItem to dim disabled menu items
        const slInternal = sl as unknown as {
          selectedIndex: number
          renderItem?: (item: { value: string; label: string }, isSelected: boolean, itemWidth: number) => string
        }
        slInternal.renderItem = (
          item: { value: string; label: string },
          isSelected: boolean,
          itemWidth: number,
        ): string => {
          const contentWidth = Math.max(1, itemWidth - SELECT_LIST_OVERHEAD)
          const menuItem = items.find((i) => i.id === item.value)
          const isDisabled = menuItem?.disabled === true

          if (isDisabled) {
            const prefix = isSelected ? theme?.fg('dim', '→') ?? '→' : '  '
            const text = theme?.fg('dim', item.label.slice(0, contentWidth)) ?? item.label.slice(0, contentWidth)
            return `${prefix} ${text}`
          }

          if (!isSelected) {
            return '  ' + item.label.slice(0, contentWidth)
          }

          const arrow = theme?.fg('accent', '→') ?? '→'
          const label = theme?.fg('accent', item.label.slice(0, contentWidth)) ?? item.label.slice(0, contentWidth)
          return `${arrow} ${label}`
        }

        const container = new Container()
        if (theme?.bold) {
          container.addChild(new Text(theme.bold(title)))
        } else {
          container.addChild(new Text(title))
        }
        container.addChild(new Text(''))
        container.addChild(sl)

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, 'escape') || matchesKey(data, 'q')) {
              done(null)
              return
            }
            if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
              const idx = slInt.selectedIndex ?? 0
              const item = items[idx]
              if (item && !item.disabled) done({ index: idx, item })
              return
            }
            sl.handleInput(data)
            ;(_tui as { requestRender?: () => void } | undefined)?.requestRender?.()
          },
        }
      },
    )

    if (sel === null) break

    savedIndex = sel.index
    const result = await sel.item.run()
    if (result === 'close') break
    // 'stay' / 'rerender': loop → reopen at savedIndex
  }
}

// ---------------------------------------------------------------------------
// Component factory (implementation detail — not exported)
// ---------------------------------------------------------------------------

/**
 * Render a single watch row as a terminal-width label string.
 * Calls `view.renderItemRowTUI`, optionally `view.compressColumns`, then
 * `renderRowColumns`. Used for both initial item construction and rebuilds
 * when the terminal width changes.
 */
function computeRowLabel<TWatch>(
  watch: TWatch,
  view: BrowseViewOptions<TWatch>['view'],
  width: number,
  theme: { fg(alias: string, text: string): string },
): string {
  const rawCols = view.renderItemRowTUI(watch, { theme: theme as never, width })
  const cols = view.compressColumns ? view.compressColumns(rawCols, width) : rawCols
  return renderRowColumns(cols, width, theme)
}

function _buildBrowseComponent<TWatch>(
  opts: BrowseViewOptions<TWatch>,
  theme: { fg(alias: string, text: string): string; bold(text: string): string },
  requestRender: () => void,
  done: (v: void) => void,
): unknown {
  // pi-tui components are imported at the top of this module.
  // They are mocked in unit tests so that _buildBrowseComponent can run
  // without a live pi-tui runtime.

  type Mode = 'list' | 'detail'
  let mode: Mode = 'list'
  let detailLines: string[] = []
  let lastWidth = 80

  // ── Confirmation state ───────────────────────────────────────────────────
  type ConfirmState =
    | { kind: 'unwatch'; watch: TWatch; label: string }
    | { kind: 'drain'; count: number }
    | null
  let confirmState: ConfirmState = null

  const sortedWatches = sortWatches(opts.watches, opts.view)

  // watchByValue: stable plain-text key → watch object
  const watchByValue = new Map(sortedWatches.map((w) => [opts.view.renderItemRowText(w), w]))

  // ── Footer hint (computed once; referenced by header child render) ────────
  const footerHint = [
    'Enter: detail',
    opts.onRefresh !== undefined ? 'ctrl+r: refresh' : null,
    opts.rowActions?.some((a) => a.id === 'remove') ? 'ctrl+x: unwatch' : null,
    opts.onDrain !== undefined ? 'ctrl+d: drain' : null,
    '←/Esc: back',
    'q: close',
    opts.searchable !== false ? 'type to filter' : null,
  ].filter(Boolean).join(' · ')

  // ── list subtree ────────────────────────────────────────────────────────

  const listContainer = new Container()
  const searchInput = new Input()

  listContainer.addChild({
    render: () => {
      if (confirmState !== null) {
        if (confirmState.kind === 'unwatch') {
          return [theme.fg('warning', `Unwatch "${confirmState.label}"?`) + '  ' + theme.fg('dim', 'y: confirm  n: cancel')]
        } else {
          const n = confirmState.count
          return [theme.fg('warning', `Purge ${n} completed watch${n === 1 ? '' : 'es'}?`) + '  ' + theme.fg('dim', 'y: confirm  n: cancel')]
        }
      }
      const currentFilter = searchInput.getValue()
      const filteredCount = currentFilter
        ? filterWatches(sortedWatches, currentFilter, opts.filter).length
        : sortedWatches.length
      const hdr = opts.header({ count: sortedWatches.length, filtered: filteredCount })
      const titleLine = hdr
        ? `${theme.fg('accent', theme.bold(opts.title))} ${theme.fg('dim', hdr)}`
        : theme.fg('accent', theme.bold(opts.title))
      return [titleLine + '  ' + theme.fg('dim', footerHint)]
    },
    invalidate: () => {},
  })

  if (opts.searchable !== false) {
    listContainer.addChild({
      render: () => [theme.fg('dim', 'search:')],
      invalidate: () => {},
    })
    listContainer.addChild(searchInput)
  }

  const slItems = sortedWatches.map((w) => ({
    value: opts.view.renderItemRowText(w),  // stable lookup key
    label: computeRowLabel(w, opts.view, Math.max(1, lastWidth - SELECT_LIST_OVERHEAD), theme),
  }))
  const selectList = new SelectList(slItems, Math.min(slItems.length + 2, 20), getSelectListTheme())

  // Patch setFilter to use our domain-aware browseFilter predicate
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
  const slInternal = selectList as any
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  slInternal.setFilter = (filter: string): void => {
    const filtered = filterWatches(sortedWatches, filter, opts.filter)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    slInternal.filteredItems = filtered.map((w) => ({
      value: opts.view.renderItemRowText(w),
      label: computeRowLabel(w, opts.view, Math.max(1, lastWidth - SELECT_LIST_OVERHEAD), theme),
    }))
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    slInternal.selectedIndex = 0
  }

  // Override per-item rendering for selection-aware colour handling
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  slInternal.renderItem = (
    item: { value: string; label: string },
    isSelected: boolean,
    itemWidth: number,
  ): string => {
    const watch = watchByValue.get(item.value)
    const contentWidth = Math.max(1, itemWidth - SELECT_LIST_OVERHEAD)

    if (watch === undefined) {
      // Fallback — watch not in map (shouldn't happen, but be safe)
      return isSelected
        ? theme.fg('accent', '→') + ' ' + item.label.slice(0, contentWidth)
        : '  ' + item.label.slice(0, contentWidth)
    }

    const rawCols = opts.view.renderItemRowTUI(watch, { theme: theme as never, width: contentWidth })
    const cols = opts.view.compressColumns
      ? opts.view.compressColumns(rawCols, contentWidth)
      : rawCols

    if (!isSelected) {
      // First column: no color (plain). Remaining columns: keep natural colors.
      const plainCols = cols.map((c, i) => {
        if (i !== 0) return c
        const { color: _drop, ...rest } = c
        return rest as typeof c
      })
      return '  ' + renderRowColumns(plainCols, contentWidth, theme)
    }

    // Selected: accent arrow + accent first column + natural colors on the rest
    const accentedCols = cols.map((c, i) =>
      i === 0 ? { ...c, color: 'accent' as const } : c,
    )
    return theme.fg('accent', '→') + ' ' + renderRowColumns(accentedCols, contentWidth, theme)
  }

  listContainer.addChild(selectList)

  // ── Shared helper: rebuild filteredItems after mutation ───────────────────────
  function rebuildFilteredItems(): void {
    const currentFilter = searchInput.getValue()
    const filtered = filterWatches(sortedWatches, currentFilter, opts.filter)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    slInternal.filteredItems = filtered.map((w) => ({
      value: opts.view.renderItemRowText(w),
      label: computeRowLabel(w, opts.view, Math.max(1, lastWidth - SELECT_LIST_OVERHEAD), theme),
    }))
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    slInternal.selectedIndex = Math.min(
      (slInternal.selectedIndex as number) ?? 0,
      Math.max(0, ((slInternal.filteredItems as unknown[])?.length ?? 1) - 1),
    )
  }

  // (footer moved into header child above)

  // ── detail subtree ───────────────────────────────────────────────────────

  const detailContainer = new Container()
  const detailHeader = new Text('', 0, 0)  // updated on each entry into detail mode
  const previewText = new Text('', 0, 0)
  detailContainer.addChild(detailHeader)
  detailContainer.addChild(previewText)

  // ── SelectList callbacks ──────────────────────────────────────────────────

  selectList.onCancel = () => done(undefined)
  selectList.onSelect = (item) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const watch = watchByValue.get(item.value)
    if (watch === undefined) return
    const pollIntervalMs = opts.getPollIntervalMs?.(watch)
    const fields = opts.view.renderItemDetail(watch, {
      theme: theme as never,
      width: lastWidth,
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    })
    detailLines = renderDetailFields(fields)
    detailHeader.setText(
      theme.bold(opts.view.renderItemRowText(watch)) + '  ' + theme.fg('dim', '\u2190/Esc: back to list'),
    )
    previewText.setText(detailLines.join('\n'))
    mode = 'detail'
    requestRender()
  }

  // ── Input routing ─────────────────────────────────────────────────────────

  return {
    render: (w: number) => {
      if (w !== lastWidth) {
        lastWidth = w
        const currentFilter = searchInput.getValue()
        const filtered = filterWatches(sortedWatches, currentFilter, opts.filter)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        slInternal.filteredItems = filtered.map((watch) => ({
          value: opts.view.renderItemRowText(watch),
          label: computeRowLabel(watch, opts.view, Math.max(1, w - SELECT_LIST_OVERHEAD), theme),
        }))
        // Also update allItems so resets after filter-clear work correctly
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        slInternal.allItems = sortedWatches.map((watch) => ({
          value: opts.view.renderItemRowText(watch),
          label: computeRowLabel(watch, opts.view, Math.max(1, w - SELECT_LIST_OVERHEAD), theme),
        }))
      }
      return mode === 'list' ? listContainer.render(w) : detailContainer.render(w)
    },
    invalidate: () => {
      listContainer.invalidate()
      detailContainer.invalidate()
    },
    handleInput: (data: string) => {
      // Ctrl-C: emergency exit in both modes
      if (matchesKey(data, 'ctrl+c')) {
        done(undefined)
        return
      }

      if (mode === 'detail') {
        if (matchesKey(data, 'escape') || matchesKey(data, 'left')) {
          mode = 'list'
          requestRender()
        }
        return
      }

      // list mode

      // ── Confirm mode ───────────────────────────────────────────────────────
      if (confirmState !== null) {
        if (matchesKey(data, 'y') || matchesKey(data, 'enter')) {
          const target = confirmState
          confirmState = null
          if (target.kind === 'unwatch') {
            const removeAction = opts.rowActions?.find((a) => a.id === 'remove')
            void removeAction?.run(target.watch, {} as never).then(() => {
              opts.onRemove?.(target.watch)
              const idx = sortedWatches.indexOf(target.watch)
              if (idx !== -1) sortedWatches.splice(idx, 1)
              rebuildFilteredItems()
              requestRender()
            })
          } else {
            const removed = opts.onDrain?.() ?? []
            if (removed.length > 0) {
              for (const w of removed) {
                const idx = sortedWatches.indexOf(w)
                if (idx !== -1) sortedWatches.splice(idx, 1)
              }
              rebuildFilteredItems()
            }
            requestRender()
          }
        } else if (matchesKey(data, 'n') || matchesKey(data, 'escape')) {
          confirmState = null
          requestRender()
        }
        return  // consume all input in confirm mode
      }

      if (matchesKey(data, 'q')) {
        opts.onQuit?.()
        done(undefined)
        return
      }

      if (matchesKey(data, 'escape') || matchesKey(data, 'left')) {
        done(undefined)
        return
      }

      const isNav =
        matchesKey(data, 'up') ||
        matchesKey(data, 'down') ||
        matchesKey(data, 'enter') ||
        matchesKey(data, 'home') ||
        matchesKey(data, 'end')

      if (isNav) {
        selectList.handleInput(data)
        requestRender()
        return
      }

      // ctrl+r — force refresh
      if (matchesKey(data, 'ctrl+r') && opts.onRefresh !== undefined) {
        void opts.onRefresh()
        return
      }

      // ctrl+x — enter confirmation to detach/remove selected watch
      if (matchesKey(data, 'ctrl+x') && opts.rowActions !== undefined) {
        const removeAction = opts.rowActions.find((a) => a.id === 'remove')
        if (removeAction !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          const selectedValue = (slInternal.filteredItems as Array<{ value: string; label: string }> | undefined)
            ?.[slInternal.selectedIndex as number ?? 0]?.value
          const watch = selectedValue !== undefined ? watchByValue.get(selectedValue) : undefined
          if (watch !== undefined) {
            confirmState = { kind: 'unwatch', watch, label: opts.view.renderItemRowText(watch) }
            requestRender()
          }
        }
        return
      }

      // ctrl+d — enter confirmation to drain all terminal watches
      if (matchesKey(data, 'ctrl+d') && opts.onDrain !== undefined) {
        const drainCount = sortedWatches.filter(
          (w) => (w as import('./base-watcher-types.js').WatchLike).terminal,
        ).length
        if (drainCount > 0) {
          confirmState = { kind: 'drain', count: drainCount }
          requestRender()
        }
        return
      }

      // Printable input → search (only when searchable)
      if (opts.searchable !== false) {
        searchInput.handleInput(data)
        selectList.setFilter(searchInput.getValue())
        requestRender()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Pure render helpers — exported for unit testing and watcher-widget
// ---------------------------------------------------------------------------

/**
 * Render an array of `DetailField` objects into aligned `label:  value` lines.
 *
 * All labels are padded to the same width (longest label + colon) so values
 * line up in a clean two-column layout:
 *
 *   target:   exists
 *   profile:  my-profile
 *   region:   us-east-1
 */
export function renderDetailFields(fields: DetailField[]): string[] {
  if (fields.length === 0) return []
  const labelWidth = Math.max(...fields.map((f) => f.label.length)) + 1 // +1 for colon
  return fields.map((f) => `${(f.label + ':').padEnd(labelWidth)}  ${f.value}`)
}

/**
 * Render a row's columns into a single terminal-width string.
 *
 * Fixed-width columns get exactly `col.width` chars (truncated with `…`
 * when the text is longer). Flexible columns (no `width`) share the
 * remaining space equally. Column separator is two spaces.
 *
 * @param columns  Column definitions from `WatcherView.renderItemRowTUI`.
 * @param totalWidth  Available terminal width in chars.
 * @param theme  Optional theme for colourising columns.
 */
export function renderRowColumns(
  columns: RowColumn[],
  totalWidth: number,
  theme?: { fg(alias: string, text: string): string },
): string {
  const SEP = '  '
  const sepTotal = SEP.length * Math.max(0, columns.length - 1)
  const fixedTotal = columns.reduce((sum, c) => sum + (c.width ?? 0), 0)
  const flexCount = columns.filter((c) => c.width === undefined).length
  const flexWidth =
    flexCount > 0
      ? Math.max(1, Math.floor((totalWidth - fixedTotal - sepTotal) / flexCount))
      : 0

  return columns
    .map((col) => {
      const w = col.width ?? flexWidth
      let text = col.text
      if (text.length > w) {
        text = text.slice(0, Math.max(0, w - 1)) + '\u2026'
      }
      const padded = col.align === 'right' ? text.padStart(w) : text.padEnd(w)
      return col.color && theme ? theme.fg(col.color, padded) : padded
    })
    .join(SEP)
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Filter a watch list using the provided filter predicate.
 * When `query` is empty, returns all watches unchanged.
 */
export function filterWatches<TWatch>(
  watches: readonly TWatch[],
  query: string,
  filterFn: (w: TWatch, q: string) => boolean,
): TWatch[] {
  if (query === '') return Array.from(watches)
  return watches.filter((w) => filterFn(w, query))
}

/**
 * Sort a watch list by `view.itemSortKey`, ascending.
 * String keys sort lexicographically; number keys sort numerically.
 * Original array is not mutated.
 */
export function sortWatches<TWatch>(
  watches: readonly TWatch[],
  view: { itemSortKey(w: TWatch): string | number },
): TWatch[] {
  return Array.from(watches).sort((a, b) => {
    const ka = view.itemSortKey(a)
    const kb = view.itemSortKey(b)
    if (typeof ka === 'number' && typeof kb === 'number') return ka - kb
    const sa = String(ka)
    const sb = String(kb)
    return sa < sb ? -1 : sa > sb ? 1 : 0
  })
}

/**
 * Group a sorted watch list by `view.itemGroup`, preserving order within
 * each group. Returns an array of `{ group: string | undefined; watches }`.
 */
export function groupWatches<TWatch>(
  watches: readonly TWatch[],
  view: { itemGroup?(w: TWatch): string | undefined },
): Array<{ group: string | undefined; watches: TWatch[] }> {
  if (view.itemGroup === undefined) {
    return [{ group: undefined, watches: Array.from(watches) }]
  }
  const groups: Array<{ group: string | undefined; watches: TWatch[] }> = []
  for (const w of watches) {
    const g = view.itemGroup(w)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.group === g) {
      last.watches.push(w)
    } else {
      groups.push({ group: g, watches: [w] })
    }
  }
  return groups
}
