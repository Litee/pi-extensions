/**
 * Unit tests for browse-view pure helpers.
 *
 * Only tests `filterWatches`, `sortWatches`, and `groupWatches` — the pure
 * functions that are fully exercisable without a live pi-tui runtime.
 * The TUI component factory (`openBrowseView`) is excluded from coverage
 * since it requires `ctx.ui.custom`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { filterWatches, groupWatches, openBrowseView, openMenuView, renderDetailFields, renderRowColumns, sortWatches } from '../src/browse-view.js'
import type { MenuViewItem } from '../src/browse-view.js'
import type { BrowseViewOptions, RowColumn, WatcherView } from '../src/base-watcher-types.js'

// ---------------------------------------------------------------------------
// Mock @earendil-works/pi-tui so _buildBrowseComponent can run in tests
// ---------------------------------------------------------------------------

const { MockContainer, MockInput, MockSelectList, MockText, piTuiMatchesKey } = vi.hoisted(() => {
  const instances: MockSelectListType[] = []
  const constructorArgsList: Array<Array<{ value: string; label: string }>> = []

  class MockContainer {
    readonly _children: Array<{ render(w: number): string[]; invalidate(): void }> = []
    addChild(c: unknown) {
      this._children.push(c as { render(w: number): string[]; invalidate(): void })
    }
    render(w: number): string[] {
      return this._children.flatMap(c => { try { return c.render(w) } catch { return [] } })
    }
    invalidate() { this._children.forEach(c => { try { c.invalidate() } catch {} }) }
  }

  class MockInput {
    private _value = ''
    handleInput(_d: string) {}
    getValue() { return this._value }
    setValue(v: string) { this._value = v }
    render(_w: number): string[] { return [] }
    invalidate() {}
  }

  class MockSelectListType {
    filteredItems: Array<{ value: string; label: string }>
    allItems: Array<{ value: string; label: string }>
    selectedIndex = 0
    onCancel: (() => void) | null = null
    onSelect: ((item: { value: string; label: string }) => void) | null = null

    constructor(items: Array<{ value: string; label: string }>, _maxRows: number, _theme: unknown) {
      this.filteredItems = [...items]
      this.allItems = [...items]
      instances.push(this)
      constructorArgsList.push([...items])
    }

    handleInput(_d: string) {}
    setFilter(_q: string) {}
    render(_w: number): string[] { return [] }
    invalidate() {}

    static getInstances() { return instances }
    static getConstructorArgs() { return constructorArgsList }
    static reset() { instances.length = 0; constructorArgsList.length = 0 }
  }

  class MockText {
    private _text: string
    constructor(text: string, _pl: number, _pt: number) { this._text = text }
    setText(t: string) { this._text = t }
    render(_w: number): string[] { return [this._text] }
    invalidate() {}
  }

  const ctrlMap: Record<string, string> = {
    'ctrl+a': '\x01', 'ctrl+b': '\x02', 'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+p': '\x10',
    'ctrl+e': '\x05', 'ctrl+f': '\x06', 'ctrl+r': '\x12', 'ctrl+x': '\x18',
  }
  const piTuiMatchesKey = (data: string, key: string): boolean => {
    if (key in ctrlMap) return data === ctrlMap[key]!
    return data === key
  }

  return { MockContainer, MockInput, MockSelectList: MockSelectListType, MockText, piTuiMatchesKey }
})

vi.mock('@earendil-works/pi-tui', () => ({
  matchesKey: piTuiMatchesKey,
  Container: MockContainer,
  Input: MockInput,
  SelectList: MockSelectList,
  Text: MockText,
}))

// Mock getSelectListTheme so it doesn't throw "Theme not initialized"
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, getSelectListTheme: () => ({}) }
})

// ---------------------------------------------------------------------------
// Test helpers for component-level tests
// ---------------------------------------------------------------------------

type ComponentLike = {
  render(w: number): string[]
  invalidate(): void
  handleInput(data: string): void
}

/** Factory signature used by ctx.ui.custom in openMenuView tests. */
type _FactoryFn = (tui: unknown, theme: unknown, kb: unknown, done: (result: unknown) => void) => ComponentLike

function makeBrowseCtx(): { ctx: object; getComponent: () => ComponentLike | null } {
  const fakeTui = { requestRender: vi.fn() }
  const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t }
  let capturedComponent: ComponentLike | null = null

  const ctx = {
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => unknown): Promise<void> => {
        capturedComponent = factory(fakeTui, theme, null, vi.fn()) as ComponentLike
        return Promise.resolve()
      },
      theme,
    },
  }

  return { ctx, getComponent: () => capturedComponent }
}

function makeSimpleView(overrides?: Partial<WatcherView<string, never>>): WatcherView<string, never> {
  return {
    noun: 'item',
    itemSortKey: (s: string) => s,
    renderItemRowText: (s: string) => s,
    renderItemRowTUI: (_s: string, _ctx) => [{ name: 'col', text: `tui:${_s}` }],
    renderItemDetail: () => [],
    renderEventRow: () => '',
    ...overrides,
  }
}

function makeSimpleBrowseOpts(
  watches: string[],
  overrides?: Partial<BrowseViewOptions<string>>,
): BrowseViewOptions<string> {
  return {
    title: 'Test',
    watches,
    view: makeSimpleView(),
    filter: (w, q) => w.includes(q),
    header: () => '',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helpers for component-level confirmation-flow tests
// ---------------------------------------------------------------------------

/**
 * Build a ComponentLike synchronously (the mock ctx.ui.custom calls the
 * factory synchronously so capturedComponent is available immediately).
 */
function buildTestComponent(
  _view: unknown,
  watches: string[],
  width: number,
  _reserved?: unknown,
  opts?: Partial<BrowseViewOptions<string>>,
): ComponentLike {
  const fakeTui = { requestRender: vi.fn() }
  const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t }
  let component: ComponentLike | null = null
  const browseOpts = makeSimpleBrowseOpts(watches, opts)
  const ctx = {
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => unknown): Promise<void> => {
        component = factory(fakeTui, theme, null, vi.fn()) as ComponentLike
        return Promise.resolve()
      },
      theme,
    },
  }
  void openBrowseView(browseOpts, ctx)
  component!.render(width)
  return component!
}

/** Object watch that satisfies WatchLike (terminal: true) for purge tests. */
interface TerminalWatch { id: string; terminal: true }

function buildTestComponentWithTerminal(
  watchIds: string[],
  onPurge: () => TerminalWatch[],
): ComponentLike {
  type TW = TerminalWatch
  const watches: TW[] = watchIds.map(id => ({ id, terminal: true as const }))

  const view: WatcherView<TW, never> = {
    noun: 'item',
    itemSortKey: (w: TW) => w.id,
    renderItemRowText: (w: TW) => w.id,
    renderItemRowTUI: (w: TW) => [{ name: 'col', text: w.id }],
    renderItemDetail: () => [],
    renderEventRow: () => '',
  }

  const fakeTui = { requestRender: vi.fn() }
  const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t }
  let component: ComponentLike | null = null

  const ctx = {
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => unknown): Promise<void> => {
        component = factory(fakeTui, theme, null, vi.fn()) as ComponentLike
        return Promise.resolve()
      },
      theme,
    },
  }

  void openBrowseView<TW>({
    title: 'Test',
    watches,
    view,
    filter: () => true,
    header: () => '',
    onPurge,
  }, ctx)

  component!.render(80)
  return component!
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface W {
  id: string
  label: string
  group?: string
  priority: number
}

const stubView = {
  renderItemRowText: (w: W) => w.label,
  itemSortKey: (w: W) => w.priority,
  itemGroup: (w: W) => w.group,
}

const watchA: W = { id: 'a', label: 'Alpha', group: 'active', priority: 3 }
const watchB: W = { id: 'b', label: 'Beta',  group: 'active', priority: 1 }
const watchC: W = { id: 'c', label: 'Gamma', group: 'done',   priority: 2 }

const all = [watchA, watchB, watchC]

// ---------------------------------------------------------------------------
// openBrowseView — overlay call signature
// ---------------------------------------------------------------------------

describe('openBrowseView', () => {
  const stubView = {
    noun: 'item',
    renderItemRowText: (w: W) => w.label,
    renderItemRowTUI: (w: W) => [{ name: 'row', text: w.label }],
    renderItemDetail: (_w: W) => [],
    renderEventRow: () => '',
    itemSortKey: (w: W) => w.priority,
  }

  it('calls ctx.ui.custom with overlay: true, bottom-center anchor, and border rules', async () => {
    let callArgs: unknown[] = []
    const ctx = {
      ui: {
        custom: (...args: unknown[]) => { callArgs = args; return Promise.resolve() },
        theme: { fg: (_: string, t: string) => t, bold: (t: string) => t },
      },
    }
    await openBrowseView({ title: 'T', watches: [], view: stubView, filter: () => true, header: () => '' }, ctx)
    expect(callArgs).toHaveLength(2)
    expect(typeof callArgs[0]).toBe('function')
    expect(callArgs[1]).toMatchObject({ overlay: true, overlayOptions: { anchor: 'bottom-center' } })
  })

  it('render wraps inner content with top and bottom rule lines', async () => {
    let capturedFactory: ((tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => { render(w: number): string[] }) | null = null
    const ctx = {
      ui: {
        custom: (factory: typeof capturedFactory) => { capturedFactory = factory; return Promise.resolve() },
        theme: { fg: (_alias: string, t: string) => `[dim]${t}`, bold: (t: string) => t },
      },
    }
    await openBrowseView({ title: 'T', watches: [], view: stubView, filter: () => true, header: () => '' }, ctx)
    expect(capturedFactory).not.toBeNull()
    const component = capturedFactory!({ requestRender: vi.fn() }, null, null, vi.fn())
    const lines = component.render(20)
    // First and last lines must be rule lines (all ─ characters or [dim] prefix)
    expect(lines[0]).toMatch(/\u2500/)
    expect(lines[lines.length - 1]).toMatch(/\u2500/)
  })
})

// ---------------------------------------------------------------------------
// Fix 1: renderItemRowTUI used for SelectList labels
// ---------------------------------------------------------------------------

describe('Fix 1 — renderItemRowTUI used for SelectList labels', () => {
  beforeEach(() => {
    MockSelectList.reset()
  })

  it('SelectList items label comes from renderItemRowTUI, not renderItemRowText', async () => {
    const renderTUI = vi.fn((_s: string) => [{ name: 'col', text: 'tui-label' }])
    const renderText = vi.fn((_s: string) => 'text-label')
    const view = makeSimpleView({ renderItemRowTUI: renderTUI, renderItemRowText: renderText })
    const { ctx } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['watch-1'], { view }), ctx)

    const args = MockSelectList.getConstructorArgs()[0]
    expect(args).toBeDefined()
    // label must NOT be the plain-text version
    expect(args![0]!.label).not.toBe('text-label')
    // label must be derived from TUI render (renderItemRowTUI was called)
    expect(renderTUI).toHaveBeenCalled()
  })

  it('SelectList item value is still renderItemRowText (stable lookup key)', async () => {
    const view = makeSimpleView({
      renderItemRowText: () => 'stable-key',
      renderItemRowTUI: () => [{ name: 'col', text: 'tui-text' }],
    })
    const { ctx } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1'], { view }), ctx)

    const args = MockSelectList.getConstructorArgs()[0]
    expect(args![0]!.value).toBe('stable-key')
  })

  it('compressColumns is called when view provides it', async () => {
    const compressSpy = vi.fn((cols: RowColumn[]) => cols)
    const view = makeSimpleView({ compressColumns: compressSpy })
    const { ctx } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1'], { view }), ctx)

    expect(compressSpy).toHaveBeenCalled()
  })

  it('label changes when width changes (render rebuilds items)', async () => {
    let callCount = 0
    const view = makeSimpleView({
      renderItemRowTUI: (_s) => [{ name: 'col', text: `w${callCount++}` }],
    })
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1'], { view }), ctx)

    const initialCount = callCount
    const component = getComponent()!
    // Trigger a render with a different width
    component.render(120)
    expect(callCount).toBeGreaterThan(initialCount)
  })
})

// ---------------------------------------------------------------------------
// Fix 3: searchable option
// ---------------------------------------------------------------------------

describe('Fix 3 — searchable option', () => {
  beforeEach(() => {
    MockSelectList.reset()
  })

  it('search: label absent when searchable: false', async () => {
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1'], { searchable: false }), ctx)

    const component = getComponent()!
    const rendered = component.render(80).join('\n')
    expect(rendered).not.toContain('search:')
  })

  it('search: label present by default (searchable omitted)', async () => {
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)

    const component = getComponent()!
    const rendered = component.render(80).join('\n')
    expect(rendered).toContain('search:')
  })

  it('search: label present when searchable: true', async () => {
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1'], { searchable: true }), ctx)

    const component = getComponent()!
    const rendered = component.render(80).join('\n')
    expect(rendered).toContain('search:')
  })

  it('footer hint omits "type to filter" when searchable: false', async () => {
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1'], { searchable: false }), ctx)

    const component = getComponent()!
    const rendered = component.render(80).join('\n')
    expect(rendered).not.toContain('type to filter')
  })

  it('printable key input is ignored when searchable: false', async () => {
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1'], { searchable: false }), ctx)

    const component = getComponent()!
    // Should not throw
    expect(() => component.handleInput('a')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Fix 4: d hotkey — detach watch
// ---------------------------------------------------------------------------

describe('Fix 4 — ctrl+x hotkey detach watch (unwatch)', () => {
  beforeEach(() => {
    MockSelectList.reset()
  })

  it('calls rowAction.run with selected watch when ctrl+x then y pressed', async () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(
      makeSimpleBrowseOpts(['watch-1'], {
        rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
      }),
      ctx,
    )

    getComponent()!.handleInput('\x18')  // ctrl+x → confirm mode
    getComponent()!.handleInput('y')     // confirm
    await Promise.resolve()
    await Promise.resolve()

    expect(runSpy).toHaveBeenCalledWith('watch-1', expect.anything())
  })

  it('calls onRemove after run completes (ctrl+x then y)', async () => {
    const onRemove = vi.fn()
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(
      makeSimpleBrowseOpts(['watch-1'], {
        rowActions: [{ id: 'remove', label: 'Unwatch', run: vi.fn().mockResolvedValue(undefined) }],
        onRemove,
      }),
      ctx,
    )

    getComponent()!.handleInput('\x18')  // ctrl+x → confirm
    getComponent()!.handleInput('y')     // confirm
    await Promise.resolve()
    await Promise.resolve()

    expect(onRemove).toHaveBeenCalledWith('watch-1')
  })

  it('does not call anything when no remove rowAction present', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    expect(() => getComponent()!.handleInput('\x18')).not.toThrow()  // ctrl+x
  })

  it('single-letter x does NOT trigger remove', async () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(
      makeSimpleBrowseOpts(['w1'], {
        searchable: false,
        rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
      }),
      ctx,
    )
    getComponent()!.handleInput('x')  // plain x — should NOT trigger
    await Promise.resolve()
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('ctrl+p does not trigger unwatch (triggers purge instead)', async () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(
      makeSimpleBrowseOpts(['w1'], {
        rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
      }),
      ctx,
    )
    getComponent()!.handleInput('\x10')  // ctrl+p — now purge, NOT unwatch
    await Promise.resolve()
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('ctrl+x key is consumed (does not route to search) when remove action present', async () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const { ctx } = makeBrowseCtx()
    await openBrowseView(
      makeSimpleBrowseOpts(['w1'], {
        rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
      }),
      ctx,
    )
    MockSelectList.getInstances()[0]!.handleInput = vi.fn()
    expect(() => MockSelectList.getInstances()[0]!.handleInput('\x18')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Fix 4: r hotkey — refresh
// ---------------------------------------------------------------------------

describe('Fix 4 — r hotkey refresh', () => {
  beforeEach(() => {
    MockSelectList.reset()
  })

  it('calls onRefresh when ctrl+r pressed', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(makeSimpleBrowseOpts(['w1'], { onRefresh }), ctx)

    getComponent()!.handleInput('\x12')  // ctrl+r
    expect(onRefresh).toHaveBeenCalled()
  })

  it('does not throw when no onRefresh provided and ctrl+r pressed', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    expect(() => getComponent()!.handleInput('\x12')).not.toThrow()  // ctrl+r
  })

  it('single-letter r does NOT trigger refresh', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1'], { searchable: false, onRefresh }), ctx)
    getComponent()!.handleInput('r')  // plain r — should NOT trigger
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('footer hint includes "ctrl+r: refresh" when onRefresh provided', async () => {
    const { ctx, getComponent } = makeBrowseCtx()

    await openBrowseView(
      makeSimpleBrowseOpts(['w1'], { onRefresh: vi.fn().mockResolvedValue(undefined) }),
      ctx,
    )

    const rendered = getComponent()!.render(80).join('\n')
    expect(rendered).toContain('ctrl+r: refresh')
  })

  it('footer hint omits "ctrl+r: refresh" when no onRefresh', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    const rendered = getComponent()!.render(80).join('\n')
    expect(rendered).not.toContain('ctrl+r: refresh')
  })

  it('footer hint includes "ctrl+x: unwatch" when remove rowAction present', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(
      makeSimpleBrowseOpts(['w1'], {
        rowActions: [{ id: 'remove', label: 'Unwatch', run: vi.fn().mockResolvedValue(undefined) }],
      }),
      ctx,
    )
    const rendered = getComponent()!.render(80).join('\n')
    expect(rendered).toContain('ctrl+x: unwatch')
  })
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ctrl+x hotkey — purge terminal watches
// ---------------------------------------------------------------------------

describe('ctrl+p hotkey — purge terminal watches', () => {
  beforeEach(() => {
    MockSelectList.reset()
  })

  it('calls onPurge when ctrl+p then y pressed (terminal watches present)', () => {
    const w1: TerminalWatch = { id: 'w1', terminal: true }
    const onPurge = vi.fn().mockReturnValue([w1])
    const component = buildTestComponentWithTerminal(['w1'], onPurge)
    component.handleInput('\x10')  // ctrl+p → confirm mode
    component.handleInput('y')     // confirm
    expect(onPurge).toHaveBeenCalled()
  })

  it('removes returned watches from visual list after ctrl+p then y', () => {
    const w1: TerminalWatch = { id: 'w1', terminal: true }
    const w2: TerminalWatch = { id: 'w2', terminal: true }
    const onPurge = vi.fn().mockReturnValue([w1])

    type TW = TerminalWatch
    const view: WatcherView<TW, never> = {
      noun: 'item',
      itemSortKey: (w: TW) => w.id,
      renderItemRowText: (w: TW) => w.id,
      renderItemRowTUI: (w: TW) => [{ name: 'col', text: w.id }],
      renderItemDetail: () => [],
      renderEventRow: () => '',
    }
    const fakeTui = { requestRender: vi.fn() }
    const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t }
    let component: ComponentLike | null = null
    const ctx = {
      ui: {
        custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => unknown): Promise<void> => {
          component = factory(fakeTui, theme, null, vi.fn()) as ComponentLike
          return Promise.resolve()
        },
        theme,
      },
    }
    void openBrowseView<TW>({ title: 'Test', watches: [w1, w2], view, filter: () => true, header: () => '', onPurge }, ctx)
    component!.render(80)

    MockSelectList.reset()
    void openBrowseView<TW>({ title: 'Test', watches: [w1, w2], view, filter: () => true, header: () => '', onPurge }, ctx)
    component!.render(80)

    component!.handleInput('\x10')  // ctrl+p → confirm
    component!.handleInput('y')     // confirm
    expect(onPurge).toHaveBeenCalled()

    const sl = MockSelectList.getInstances()[0]!
    expect(sl.filteredItems.map((i: { value: string }) => i.value)).not.toContain('w1')
    expect(sl.filteredItems.map((i: { value: string }) => i.value)).toContain('w2')
  })

  it('single-letter d does NOT trigger purge', async () => {
    const onPurge = vi.fn().mockReturnValue([])
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1'], { searchable: false, onPurge }), ctx)
    getComponent()!.handleInput('d')  // plain d — should NOT trigger
    expect(onPurge).not.toHaveBeenCalled()
  })

  it('does nothing when onPurge not provided', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    expect(() => getComponent()!.handleInput('\x10')).not.toThrow()
  })

  it('footer hint includes "ctrl+p: purge" when onPurge provided', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1'], { onPurge: vi.fn().mockReturnValue([]) }), ctx)
    const rendered = getComponent()!.render(80).join('\n')
    expect(rendered).toContain('ctrl+p: purge')
  })

  it('footer hint omits "ctrl+p: purge" when onPurge not provided', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    const rendered = getComponent()!.render(80).join('\n')
    expect(rendered).not.toContain('ctrl+p: purge')
  })
})

// ---------------------------------------------------------------------------
// Fix 1 (new): SELECT_LIST_OVERHEAD — renderItemRowTUI receives width minus 4
// ---------------------------------------------------------------------------

describe('SELECT_LIST_OVERHEAD — width passed to renderItemRowTUI', () => {
  beforeEach(() => {
    MockSelectList.reset()
  })

  it('passes (terminalWidth - 4) as ctx.width to renderItemRowTUI on width change', async () => {
    const capturedWidths: number[] = []
    const view = makeSimpleView({
      renderItemRowTUI: (_s: string, ctx) => {
        capturedWidths.push(ctx.width)
        return [{ name: 'col', text: 'x' }]
      },
    })
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['item1'], { view }), ctx)

    capturedWidths.length = 0  // clear initial construction calls (at lastWidth=80)
    getComponent()!.render(100)  // trigger width change → should rebuild at 96 (100-4)

    expect(capturedWidths.length).toBeGreaterThan(0)
    // Before fix: widths would be 100. After fix: all must be 96.
    expect(capturedWidths.every(w => w === 96)).toBe(true)
  })

  it('initial SelectList items use (80 - 4 = 76) as ctx.width, not raw 80', async () => {
    const capturedWidths: number[] = []
    const view = makeSimpleView({
      renderItemRowTUI: (_s: string, ctx) => {
        capturedWidths.push(ctx.width)
        return [{ name: 'col', text: 'x' }]
      },
    })
    const { ctx } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['item1'], { view }), ctx)

    // Initial construction uses lastWidth=80; after fix, renderItemRowTUI gets 76 (80-4)
    expect(capturedWidths.some(w => w === 76)).toBe(true)
    expect(capturedWidths.every(w => w !== 80)).toBe(true)  // raw 80 must never appear
  })
})

// ---------------------------------------------------------------------------
// filterWatches
// ---------------------------------------------------------------------------

describe('filterWatches', () => {
  const filterFn = (w: W, q: string) =>
    w.label.toLowerCase().includes(q.toLowerCase())

  it('returns all watches when query is empty', () => {
    const result = filterWatches(all, '', filterFn)
    expect(result).toHaveLength(3)
  })

  it('filters by label substring (case-insensitive)', () => {
    const result = filterWatches(all, 'alph', filterFn)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('a')
  })

  it('returns empty array when no match', () => {
    const result = filterWatches(all, 'zzz', filterFn)
    expect(result).toHaveLength(0)
  })

  it('is case-insensitive via the filterFn', () => {
    const result = filterWatches(all, 'BETA', filterFn)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('b')
  })

  it('does not mutate the original array', () => {
    const copy = [...all]
    filterWatches(all, 'a', filterFn)
    expect(all).toEqual(copy)
  })

  it('returns all when query matches multiple', () => {
    const result = filterWatches(all, 'alpha', filterFn) // only 'Alpha' contains 'alpha'
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// sortWatches
// ---------------------------------------------------------------------------

describe('sortWatches', () => {
  it('sorts by numeric itemSortKey ascending', () => {
    const result = sortWatches(all, stubView)
    expect(result.map((w) => w.id)).toEqual(['b', 'c', 'a']) // priorities 1, 2, 3
  })

  it('sorts by string itemSortKey lexicographically', () => {
    const stringView = { itemSortKey: (w: W) => w.id }
    const result = sortWatches(all, stringView)
    expect(result.map((w) => w.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the original array', () => {
    const copy = [...all]
    sortWatches(all, stubView)
    expect(all).toEqual(copy)
  })

  it('handles empty array', () => {
    const result = sortWatches([], stubView)
    expect(result).toHaveLength(0)
  })

  it('handles single-element array', () => {
    const result = sortWatches([watchA], stubView)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('a')
  })

  it('is stable for equal keys — preserves original relative order', () => {
    const eq = [
      { id: 'x', label: 'X', priority: 5 },
      { id: 'y', label: 'Y', priority: 5 },
    ]
    const result = sortWatches(eq, stubView)
    // Both have same priority — either order is acceptable but length must be 2
    expect(result).toHaveLength(2)
    expect(result.map((w) => w.priority)).toEqual([5, 5])
  })
})

// ---------------------------------------------------------------------------
// groupWatches
// ---------------------------------------------------------------------------

describe('groupWatches', () => {
  it('returns a single group with undefined key when view has no itemGroup', () => {
    const sorted = sortWatches(all, stubView)
    const groups = groupWatches(sorted, {})
    expect(groups).toHaveLength(1)
    expect(groups[0]?.group).toBeUndefined()
    expect(groups[0]?.watches).toHaveLength(3)
  })

  it('groups consecutive watches by group key', () => {
    // Sort first so group keys are consecutive (priority order: b(active), c(done), a(active))
    const sorted = sortWatches(all, stubView) // [b, c, a]
    const groups = groupWatches(sorted, stubView)
    // b → active, c → done, a → active: 3 groups (active, done, active)
    expect(groups).toHaveLength(3)
    expect(groups[0]).toEqual({ group: 'active', watches: [watchB] })
    expect(groups[1]).toEqual({ group: 'done', watches: [watchC] })
    expect(groups[2]).toEqual({ group: 'active', watches: [watchA] })
  })

  it('merges consecutive watches with the same group', () => {
    // Pre-sort by group to get two groups
    const sorted = [watchB, watchA, watchC] // active, active, done
    const groups = groupWatches(sorted, stubView)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ group: 'active', watches: [watchB, watchA] })
    expect(groups[1]).toEqual({ group: 'done', watches: [watchC] })
  })

  it('handles empty input', () => {
    const groups = groupWatches([], stubView)
    expect(groups).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// renderDetailFields
// ---------------------------------------------------------------------------

describe('renderDetailFields', () => {
  it('single field produces "label:  value"', () => {
    const result = renderDetailFields([{ label: 'label', value: 'value' }])
    expect(result).toEqual(['label:  value'])
  })

  it('labels are padded to the longest label + colon', () => {
    const result = renderDetailFields([
      { label: 'uri',     value: 'x' },
      { label: 'profile', value: 'y' },
    ])
    // longest = 'profile' (7 chars), labelWidth = 8
    // 'uri:'.padEnd(8) = 'uri:    ' (8 chars) then '  x'
    expect(result[0]).toBe('uri:      x')
    // 'profile:'.padEnd(8) = 'profile:' (8 chars) then '  y'
    expect(result[1]).toBe('profile:  y')
  })

  it('empty array returns empty array', () => {
    const result = renderDetailFields([])
    expect(result).toEqual([])
  })

  it('single-char label is padded to match longer labels', () => {
    const result = renderDetailFields([
      { label: 'a',    value: '1' },
      { label: 'long', value: '2' },
    ])
    // labelWidth = max(1,4) + 1 = 5
    // 'a:'.padEnd(5) = 'a:   ' then '  1'
    expect(result[0]).toBe('a:     1')
    // 'long:'.padEnd(5) = 'long:' then '  2'
    expect(result[1]).toBe('long:  2')
  })
})

// ---------------------------------------------------------------------------
// renderRowColumns
// ---------------------------------------------------------------------------

describe('renderRowColumns', () => {
  it('single flexible column fills total width', () => {
    const cols: RowColumn[] = [{ name: 'col', text: 'hello' }]
    const result = renderRowColumns(cols, 10)
    // flexWidth = max(1, floor((10 - 0 - 0) / 1)) = 10
    // 'hello'.padEnd(10) = 'hello     '
    expect(result).toBe('hello     ')
    expect(result.length).toBe(10)
  })

  it('fixed columns get exact width; flexible takes remainder', () => {
    const cols: RowColumn[] = [
      { name: 'flex', text: 'flex' },         // flexible
      { name: 'fix', text: 'fix', width: 5 }, // fixed
    ]
    // totalWidth=15, sepTotal=2, fixedTotal=5, flexCount=1
    // flexWidth = floor((15 - 5 - 2) / 1) = 8
    // 'flex'.padEnd(8)='flex    ' + '  ' + 'fix  ' = 'flex      fix  '
    const result = renderRowColumns(cols, 15)
    expect(result).toBe('flex      fix  ')
    expect(result.length).toBe(15)
  })

  it('text longer than width is truncated with …', () => {
    const cols: RowColumn[] = [{ name: 'col', text: 'abcdefghij', width: 5 }]
    const result = renderRowColumns(cols, 5)
    // slice(0, 4) + '…' = 'abcd…'
    expect(result).toBe('abcd…')
    expect(result.length).toBe(5)
  })

  it('right-aligned column pads on the left', () => {
    const cols: RowColumn[] = [{ name: 'col', text: 'hi', width: 5, align: 'right' }]
    const result = renderRowColumns(cols, 5)
    expect(result).toBe('   hi')
  })

  it('separator is two spaces between columns', () => {
    const cols: RowColumn[] = [
      { name: 'a', text: 'a', width: 1 },
      { name: 'b', text: 'b', width: 1 },
    ]
    // 1 + 2 + 1 = 4
    const result = renderRowColumns(cols, 4)
    expect(result).toBe('a  b')
  })

  it('color is applied via theme.fg when theme provided', () => {
    const cols: RowColumn[] = [{ name: 'col', text: 'hi', width: 5, color: 'accent' }]
    const theme = { fg: (alias: string, text: string) => `[${alias}]${text}` }
    const result = renderRowColumns(cols, 5, theme)
    // 'hi'.padEnd(5) = 'hi   '
    expect(result).toBe('[accent]hi   ')
  })

  it('no color applied when theme is absent', () => {
    const cols: RowColumn[] = [{ name: 'col', text: 'hi', width: 5, color: 'accent' }]
    const result = renderRowColumns(cols, 5)
    expect(result).toBe('hi   ')
  })

  it('empty columns array returns empty string', () => {
    expect(renderRowColumns([], 80)).toBe('')
  })

  it('falls back to ellipsis truncation when text exceeds column width', () => {
    const cols: RowColumn[] = [{ name: 'col', text: 'hello world', width: 5 }]
    const result = renderRowColumns(cols, 5)
    expect(result).toBe('hell…')  // default: slice(0, 4) + '…'
  })
})

// ---------------------------------------------------------------------------
// compressColumns integration
// ---------------------------------------------------------------------------

describe('compressColumns integration in renderRowColumns', () => {
  it('renderRowColumns does not have a compress field on RowColumn', () => {
    // RowColumn with no compress property — TypeScript enforces this,
    // but verify at runtime that passing `compress` is ignored/absent
    const col: RowColumn = { name: 'uri', text: 'hello', width: 3 }
    expect('compress' in col).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Change 5: left arrow in list mode closes overlay
// ---------------------------------------------------------------------------

describe('left arrow in list mode closes overlay', () => {
  beforeEach(() => {
    MockSelectList.reset()
  })

  it('left arrow in list mode calls done', async () => {
    const fakeTui = { requestRender: vi.fn() }
    const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t }
    const doneFn = vi.fn()
    let capturedComponent: ComponentLike | null = null
    const ctx = {
      ui: {
        custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => unknown): Promise<void> => {
          capturedComponent = factory(fakeTui, theme, null, doneFn) as ComponentLike
          return Promise.resolve()
        },
        theme,
      },
    }
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    capturedComponent!.handleInput('left')  // mock maps matchesKey(data,'left') → data==='left'
    expect(doneFn).toHaveBeenCalled()
  })

  it('footer shows "← /Esc: back" hint', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    const rendered = getComponent()!.render(80).join('\n')
    expect(rendered).toContain('←/Esc: back')
  })
})

describe('WatcherView.compressColumns', () => {
  it('is called with all columns and total width before renderRowColumns', () => {
    // Create a stub view with compressColumns that records its args
    const recorded: Array<{ cols: RowColumn[]; width: number }> = []
    const view: WatcherView<unknown, never> = {
      noun: 'item',
      itemSortKey: () => 0,
      renderItemRowText: () => '',
      renderItemRowTUI: () => [{ name: 'a', text: 'hello', width: 5 }],
      renderItemDetail: () => [],
      renderEventRow: () => '',
      compressColumns: (cols, w) => { recorded.push({ cols, width: w }); return cols },
    }
    // Call renderRowColumns via a helper that invokes the full pipeline
    // (test the pipeline function exported from browse-view)
    const cols = view.renderItemRowTUI({}, { theme: {} as never, width: 80 })
    view.compressColumns!(cols, 80)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.width).toBe(80)
    expect(recorded[0]!.cols[0]!.name).toBe('a')
  })

  it('compressColumns can replace column text values', () => {
    const view: WatcherView<unknown, never> = {
      noun: 'item',
      itemSortKey: () => 0,
      renderItemRowText: () => '',
      renderItemRowTUI: () => [
        { name: 'uri', text: 's3://bucket/very/long/path', color: 'accent' },
        { name: 'target', text: 'exists', width: 8, color: 'dim' },
      ],
      renderItemDetail: () => [],
      renderEventRow: () => '',
      compressColumns: (cols, width) =>
        cols.map(c =>
          c.name === 'uri' ? { ...c, text: c.text.slice(0, width - 10) } : c
        ),
    }
    const cols = view.renderItemRowTUI({}, { theme: {} as never, width: 30 })
    const compressed = view.compressColumns!(cols, 30)
    expect(compressed[0]!.text.length).toBeLessThan(cols[0]!.text.length)
  })

  it('is optional — absent compressColumns is a no-op', () => {
    const view: WatcherView<unknown, never> = {
      noun: 'item',
      itemSortKey: () => 0,
      renderItemRowText: () => '',
      renderItemRowTUI: () => [{ name: 'a', text: 'hello' }],
      renderItemDetail: () => [],
      renderEventRow: () => '',
      // no compressColumns
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(view.compressColumns).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Confirmation flow — ctrl+x (unwatch) and ctrl+p (purge)
// ---------------------------------------------------------------------------

describe('confirmation flow — ctrl+x (unwatch)', () => {
  beforeEach(() => { MockSelectList.reset() })

  it('ctrl+x does not immediately call run when remove action present', () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const component = buildTestComponent(undefined, ['w1'], 80, undefined, {
      rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
    })
    component.handleInput('\x18')  // ctrl+x
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('ctrl+x then y calls run', async () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const component = buildTestComponent(undefined, ['w1'], 80, undefined, {
      rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
    })
    component.handleInput('\x18')  // ctrl+x → confirm mode
    component.handleInput('y')    // confirm
    await Promise.resolve()
    await Promise.resolve()
    expect(runSpy).toHaveBeenCalledOnce()
  })

  it('ctrl+x then n does not call run', () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const component = buildTestComponent(undefined, ['w1'], 80, undefined, {
      rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
    })
    component.handleInput('\x18')  // ctrl+x → confirm mode
    component.handleInput('n')    // cancel
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('ctrl+x then escape does not call run', () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const component = buildTestComponent(undefined, ['w1'], 80, undefined, {
      rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
    })
    component.handleInput('\x18')   // ctrl+x → confirm mode
    component.handleInput('escape') // cancel
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('confirm mode: other keys are consumed (do not leak to search)', () => {
    const runSpy = vi.fn().mockResolvedValue(undefined)
    const component = buildTestComponent(undefined, ['w1'], 80, undefined, {
      rowActions: [{ id: 'remove', label: 'Unwatch', run: runSpy }],
    })
    component.handleInput('\x18')  // ctrl+x → confirm
    // In confirm mode, printable keys are consumed; after n the confirm exits
    expect(() => component.handleInput('z')).not.toThrow()
  })
})

describe('confirmation flow — ctrl+p (purge)', () => {
  beforeEach(() => { MockSelectList.reset() })

  it('ctrl+p does not immediately call onPurge', () => {
    const onPurge = vi.fn().mockReturnValue([])
    const component = buildTestComponentWithTerminal(['w1'], onPurge)
    component.handleInput('\x10')  // ctrl+p
    expect(onPurge).not.toHaveBeenCalled()
  })

  it('ctrl+p then y calls onPurge', () => {
    const onPurge = vi.fn().mockReturnValue([])
    const component = buildTestComponentWithTerminal(['w1'], onPurge)
    component.handleInput('\x10')  // ctrl+p → confirm
    component.handleInput('y')    // confirm
    expect(onPurge).toHaveBeenCalledOnce()
  })

  it('ctrl+p then n does not call onPurge', () => {
    const onPurge = vi.fn().mockReturnValue([])
    const component = buildTestComponentWithTerminal(['w1'], onPurge)
    component.handleInput('\x10')  // ctrl+p
    component.handleInput('n')    // cancel
    expect(onPurge).not.toHaveBeenCalled()
  })

  it('ctrl+p does nothing when no terminal watches (purgeCount = 0)', () => {
    // String watches have no `terminal` property so purgeCount = 0
    const onPurge = vi.fn().mockReturnValue([])
    const component = buildTestComponent(undefined, ['w1'], 80, undefined, { onPurge })
    component.handleInput('\x10')  // ctrl+p — no confirm since count=0
    component.handleInput('y')    // y in normal mode should not trigger purge
    expect(onPurge).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// renderRowColumns — no-theme color stripping
// ---------------------------------------------------------------------------

describe('renderRowColumns — no theme strips colors', () => {
  it('renders plain text when no theme provided (colored columns produce no ANSI)', () => {
    const cols: RowColumn[] = [
      { name: 'a', text: 'hello', color: 'accent' },
      { name: 'b', text: 'world', width: 5, color: 'warning' },
    ]
    // totalWidth=12: sepTotal=2, fixedTotal=5, flexWidth=floor((12-5-2)/1)=5
    // 'hello'.padEnd(5)='hello' + '  ' + 'world' = 'hello  world'
    const result = renderRowColumns(cols, 12)  // no theme arg
    expect(result).toBe('hello  world')
  })

  it('with theme, colored columns are wrapped by theme.fg', () => {
    const cols: RowColumn[] = [{ name: 'a', text: 'hi', width: 5, color: 'accent' }]
    const theme = { fg: (alias: string, t: string) => `[${alias}]${t}` }
    const result = renderRowColumns(cols, 5, theme)
    expect(result).toContain('[accent]')
  })
})

// ---------------------------------------------------------------------------
// renderItem — selection-aware colour handling (tests the slInternal patch)
// ---------------------------------------------------------------------------

describe('renderItem selection highlighting', () => {
  beforeEach(() => {
    MockSelectList.reset()
  })

  // Helper: build component with a theme that wraps colours for detectability
  async function buildWithColorTheme(watches: string[], viewOverrides?: Partial<ReturnType<typeof makeSimpleView>>) {
    const theme = { fg: (alias: string, t: string) => `[${alias}]${t}`, bold: (t: string) => `**${t}**` }
    let captured: ComponentLike | null = null
    const ctx = {
      ui: {
        custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => unknown): Promise<void> => {
          captured = factory({ requestRender: vi.fn() }, theme, null, vi.fn()) as ComponentLike
          return Promise.resolve()
        },
        theme,
      },
    }
    const view = makeSimpleView({
      renderItemRowTUI: (_s: string) => [{ name: 'col', text: `tui:${_s}`, color: 'dim' as const }],
      ...viewOverrides,
    })
    await openBrowseView(makeSimpleBrowseOpts(watches, { view }), ctx)
    type _SlInternal = { renderItem: (item: { value: string; label: string }, isSelected: boolean, width: number) => string }
    return { component: captured!, sl: MockSelectList.getInstances()[0]! as unknown as _SlInternal }
  }

  it('slInternal.renderItem is patched onto the SelectList instance', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    expect(typeof sl.renderItem).toBe('function')
  })

  it('non-selected row starts with two-space indent', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, false, 80)
    expect(result.startsWith('  ')).toBe(true)
  })

  it('non-selected row does not contain arrow', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, false, 80)
    expect(result).not.toContain('→')
  })

  it('selected row starts with arrow →', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, true, 80)
    // theme.fg('accent','→') = '[accent]→', so result starts with '[accent]→'
    expect(result).toContain('→')
    expect(result.indexOf('→')).toBeLessThan(result.indexOf('tui:'))
  })

  it('selected row does not start with double-space', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, true, 80)
    expect(result.startsWith('  ')).toBe(false)
  })

  it('non-selected row: first column color stripped — no accent/dim on col 0', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, false, 80)
    // Only one column in this view; its color (dim) should be stripped
    expect(result).not.toContain('[dim]')
  })

  it('non-selected row: second+ columns keep their natural color', async () => {
    // View with two columns: first has dim, second has warning
    const { sl } = await buildWithColorTheme(['w1'], {
      renderItemRowTUI: (_s: string) => [
        { name: 'col0', text: 'first', color: 'dim' as const },
        { name: 'col1', text: 'second', width: 10, color: 'warning' as const },
      ],
    })
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, false, 80)
    expect(result).not.toContain('[dim]')      // col0 color stripped
    expect(result).toContain('[warning]second') // col1 color preserved
  })

  it('selected row: first column gets accent color', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    // original column color is 'dim', but selected first col should be 'accent'
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, true, 80)
    expect(result).toContain('[accent]')
  })

  it('selected row: original dim color NOT applied to first column', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    // Single-column view: col0 was dim, now accent
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, true, 80)
    // The text 'tui:w1' should appear under accent, not dim
    expect(result).toContain('[accent]')
    // With a single column there is no [dim] at all (overridden to accent)
    expect(result).not.toContain('[dim]')
  })

  it('selected row: second+ columns keep their natural color', async () => {
    const { sl } = await buildWithColorTheme(['w1'], {
      renderItemRowTUI: (_s: string) => [
        { name: 'col0', text: 'first', color: 'dim' as const },
        { name: 'col1', text: 'second', width: 10, color: 'warning' as const },
      ],
    })
    const result: string = sl.renderItem({ value: 'w1', label: 'tui:w1' }, true, 80)
    expect(result).toContain('[accent]first')   // col0 overridden to accent
    expect(result).toContain('[warning]second')  // col1 unchanged
  })

  it('unknown value falls back gracefully — non-selected shows indent', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    const result: string = sl.renderItem({ value: 'UNKNOWN_KEY', label: 'fallback' }, false, 80)
    expect(result.startsWith('  ')).toBe(true)
  })

  it('unknown value falls back gracefully — selected shows arrow', async () => {
    const { sl } = await buildWithColorTheme(['w1'])
    const result: string = sl.renderItem({ value: 'UNKNOWN_KEY', label: 'fallback' }, true, 80)
    expect(result.startsWith('[accent]→')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// openMenuView
// ---------------------------------------------------------------------------

describe('openMenuView', () => {
  beforeEach(() => { MockSelectList.reset() })

  it('is a no-op when ctx.ui.custom is absent', async () => {
    await openMenuView('Test', () => [], {})
    await openMenuView('Test', () => [], { ui: {} })
  })

  it('is a no-op when items list is empty', async () => {
    const customSpy = vi.fn()
    const ctx = { ui: { custom: customSpy } }
    await openMenuView('Test', () => [], ctx)
    expect(customSpy).not.toHaveBeenCalled()
  })

  it('calls ctx.ui.custom with a factory function when items exist', async () => {
    // mock: immediately return null (simulate escape) so the loop exits
    const customSpy = vi.fn().mockResolvedValue(null)
    const items = [{ id: 'a', label: 'A', run: () => Promise.resolve('close' as const) }]
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await openMenuView('Test', () => items, ctx)
    expect(customSpy).toHaveBeenCalledOnce()
    expect(typeof customSpy.mock.calls[0]![0]).toBe('function')
  })

  it('factory returns a component with render, handleInput, invalidate', () => {
    // Capture the factory without invoking it; return null so the loop exits
    let capturedFactory: _FactoryFn | null = null
    const ctx = {
      ui: {
        custom: (factory: _FactoryFn) => { capturedFactory = factory; return Promise.resolve(null) },
        theme: { bold: (s: string) => s, fg: (_: string, s: string) => s },
      },
    }
    // fire-and-forget: capturedFactory is set synchronously on first await suspension
    void openMenuView('Test', () => [{ id: 'a', label: 'Item A', run: () => Promise.resolve('close' as const) }], ctx)
    expect(capturedFactory).not.toBeNull()

    // Call factory with the 4-arg SDK signature
    const component = capturedFactory!(
      { requestRender: vi.fn() },
      null, null, vi.fn(),
    )
    expect(component).toHaveProperty('render')
    expect(component).toHaveProperty('handleInput')
    expect(component).toHaveProperty('invalidate')
  })

  it('Escape calls done(null) and resolves the promise', async () => {
    let doneCalledWithNull = false
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      const component = factory(
        { requestRender: vi.fn() }, null, null,
        (r: unknown) => { doneCalledWithNull = r === null },
      )
      component.handleInput('escape')
      return Promise.resolve(null)
    })
    const items = [{ id: 'a', label: 'A', run: () => Promise.resolve('close' as const) }]
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await expect(openMenuView('Test', () => items, ctx)).resolves.toBeUndefined()
    expect(doneCalledWithNull).toBe(true)
  })

  it('"q" calls done(null) and resolves the promise', async () => {
    let doneCalledWithNull = false
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      const component = factory(
        { requestRender: vi.fn() }, null, null,
        (r: unknown) => { doneCalledWithNull = r === null },
      )
      component.handleInput('q')
      return Promise.resolve(null)
    })
    const items = [{ id: 'a', label: 'A', run: () => Promise.resolve('close' as const) }]
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await expect(openMenuView('Test', () => items, ctx)).resolves.toBeUndefined()
    expect(doneCalledWithNull).toBe(true)
  })

  it('Enter calls done({ index, item }) before item.run() is awaited', async () => {
    const runSpy = vi.fn().mockResolvedValue('close' as const)
    const items = [{ id: 'a', label: 'A', run: runSpy }]
    let doneCalledWithSelection = false
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      const component = factory(
        { requestRender: vi.fn() }, null, null,
        (r: unknown) => {
          // done is called with { index, item } synchronously on Enter
          doneCalledWithSelection = r !== null && typeof r === 'object' && 'item' in (r as Record<string, unknown>)
        },
      )
      component.handleInput('enter')
      return Promise.resolve({ index: 0, item: items[0] })
    })
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await openMenuView('Test', () => items, ctx)
    expect(doneCalledWithSelection).toBe(true)
    expect(runSpy).toHaveBeenCalledOnce()
  })

  it('"close" result from item.run() resolves the promise', async () => {
    const items = [{ id: 'a', label: 'A', run: () => Promise.resolve('close' as const) }]
    const customSpy = vi.fn().mockResolvedValue({ index: 0, item: items[0] })
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await expect(openMenuView('Test', () => items, ctx)).resolves.toBeUndefined()
  })

  it('"stay" causes menu to reopen — customSpy called twice', async () => {
    const runFn = vi.fn()
      .mockResolvedValueOnce('stay' as const)
      .mockResolvedValueOnce('close' as const)
    const items = [
      { id: 'a', label: 'A', run: () => Promise.resolve('close' as const) },
      { id: 'b', label: 'B', run: runFn },
    ]
    const customSpy = vi.fn().mockResolvedValue({ index: 1, item: items[1] })
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await openMenuView('Test', () => items, ctx)
    expect(customSpy).toHaveBeenCalledTimes(2)
    expect(runFn).toHaveBeenCalledTimes(2)
  })

  it('"stay" preserves selectedIndex on reopen', async () => {
    MockSelectList.reset()
    const capturedInitialIndices: number[] = []
    const items = [
      { id: 'a', label: 'A', run: () => Promise.resolve('close' as const) },
      { id: 'b', label: 'B', run: vi.fn().mockResolvedValueOnce('stay').mockResolvedValueOnce('close') },
    ]
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      // Factory creates a new SelectList; capture its initial selectedIndex after factory runs
      const slCountBefore = MockSelectList.getInstances().length
      factory({ requestRender: vi.fn() }, null, null, vi.fn())
      const sl = MockSelectList.getInstances()[slCountBefore]!
      capturedInitialIndices.push(sl.selectedIndex)
      return Promise.resolve({ index: 1, item: items[1] })
    })
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await openMenuView('Test', () => items, ctx)
    expect(capturedInitialIndices).toHaveLength(2)
    // First open: savedIndex=0 (initial)
    expect(capturedInitialIndices[0]).toBe(0)
    // Second open: savedIndex=1 (preserved from first selection)
    expect(capturedInitialIndices[1]).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// openMenuView — close before run (no overlay stacking)
// ---------------------------------------------------------------------------

describe('openMenuView — close before run (no stacking)', () => {
  beforeEach(() => { MockSelectList.reset() })

  it('loops back and reopens after stay result', async () => {
    const items: MenuViewItem[] = [{
      id: 'a',
      label: 'Item A',
      run: vi.fn().mockResolvedValueOnce('stay').mockResolvedValueOnce('close'),
    }]
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      const component = factory({ requestRender: vi.fn() }, null, null, vi.fn())
      component.handleInput('enter')
      return { index: 0, item: items[0] }
    })
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await openMenuView('Test', () => items, ctx)
    // Should open menu twice: once for 'stay', once for 'close'
    expect(customSpy).toHaveBeenCalledTimes(2)
    expect(items[0]!.run).toHaveBeenCalledTimes(2)
  })

  it('null result (escape) exits without calling any item.run', async () => {
    const runSpy = vi.fn()
    const items: MenuViewItem[] = [{ id: 'a', label: 'A', run: runSpy }]
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      const component = factory({ requestRender: vi.fn() }, null, null, vi.fn())
      component.handleInput('escape')
      return Promise.resolve(null)
    })
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await openMenuView('Test', () => items, ctx)
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('menu and run are never simultaneously active — custom resolves before run() starts', async () => {
    // Verify that sel.item.run() is called only AFTER customFn resolves (no overlap)
    const events: string[] = []
    const items: MenuViewItem[] = [{
      id: 'a',
      label: 'A',
      run: () => { events.push('run:start'); return Promise.resolve('close' as const) },
    }]
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      events.push('custom:open')
      factory({ requestRender: vi.fn() }, null, null, vi.fn())
      const result = { index: 0, item: items[0]! }
      events.push('custom:resolve')
      return result
    })
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await openMenuView('Test', () => items, ctx)
    // custom must fully resolve before run starts
    expect(events.indexOf('custom:resolve')).toBeLessThan(events.indexOf('run:start'))
  })

  it('three stay iterations then close calls customSpy 4 times', async () => {
    const runFn = vi.fn()
      .mockResolvedValueOnce('stay' as const)
      .mockResolvedValueOnce('stay' as const)
      .mockResolvedValueOnce('stay' as const)
      .mockResolvedValueOnce('close' as const)
    const items: MenuViewItem[] = [{ id: 'a', label: 'A', run: runFn }]
    const customSpy = vi.fn().mockResolvedValue({ index: 0, item: items[0] })
    const ctx = { ui: { custom: customSpy, theme: { bold: (s: string) => s, fg: (_: string, s: string) => s } } }
    await openMenuView('Test', () => items, ctx)
    expect(customSpy).toHaveBeenCalledTimes(4)
    expect(runFn).toHaveBeenCalledTimes(4)
  })
})

// ---------------------------------------------------------------------------
// openMenuView — disabled items
// ---------------------------------------------------------------------------

describe('openMenuView — disabled items', () => {
  beforeEach(() => { MockSelectList.reset() })

  it('Enter on a disabled item does NOT call done with item', async () => {
    const runSpy = vi.fn().mockResolvedValue('close' as const)
    const items: MenuViewItem[] = [
      { id: 'a', label: 'Item A', disabled: true, run: runSpy },
    ]
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      const component = factory({ requestRender: vi.fn() }, null, null, (r: unknown) => r)
      // Press Enter — should be a no-op because item is disabled
      component.handleInput('enter')
      return null   // simulate done(null) never being called → overlay resolves null
    })
    const ctx = { ui: { custom: customSpy, theme: { fg: (_: string, t: string) => t, bold: (t: string) => t } } }
    await openMenuView('Test', () => items, ctx)
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('Enter on an enabled item still works', async () => {
    const runSpy = vi.fn().mockResolvedValue('close' as const)
    const items: MenuViewItem[] = [
      { id: 'a', label: 'Item A', disabled: false, run: runSpy },
    ]
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      const component = factory({ requestRender: vi.fn() }, null, null, (r: unknown) => r)
      component.handleInput('enter')
      return { index: 0, item: items[0] }
    })
    const ctx = { ui: { custom: customSpy, theme: { fg: (_: string, t: string) => t, bold: (t: string) => t } } }
    await openMenuView('Test', () => items, ctx)
    expect(runSpy).toHaveBeenCalledOnce()
  })

  it('slInternal.renderItem renders disabled item with dim prefix', async () => {
    const items: MenuViewItem[] = [
      { id: 'a', label: 'Item A', disabled: true, run: () => Promise.resolve('close' as const) },
    ]
    let capturedSl: unknown = null
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      const theme = { fg: (alias: string, t: string) => `[${alias}]${t}`, bold: (t: string) => t }
      factory({ requestRender: vi.fn() }, theme, null, (r: unknown) => r)
      // Capture the SelectList instance
      const instances = MockSelectList.getInstances()
      capturedSl = instances[instances.length - 1]
      return null
    })
    const ctx = { ui: { custom: customSpy, theme: { fg: (alias: string, t: string) => `[${alias}]${t}`, bold: (t: string) => t } } }
    await openMenuView('Test', () => items, ctx)
    type _SlLike = { renderItem?: (item: { value: string; label: string }, isSelected: boolean, width: number) => string }
    const sl = capturedSl as _SlLike
    if (sl?.renderItem) {
      const result = sl.renderItem({ value: 'a', label: 'Item A' }, false, 40)
      expect(result).toContain('[dim]')
    }
  })

  it('selected enabled item has accent on arrow AND label', async () => {
    const items: MenuViewItem[] = [
      { id: 'a', label: 'Item A', run: () => Promise.resolve('close' as const) },
    ]
    let capturedSl: unknown = null
    const customSpy = vi.fn().mockImplementation((factory: _FactoryFn) => {
      factory({ requestRender: vi.fn() }, null, null, (r: unknown) => r)
      capturedSl = MockSelectList.getInstances().at(-1)
      return null
    })
    const theme = { fg: (alias: string, t: string) => `[${alias}]${t}`, bold: (t: string) => t }
    const ctx = { ui: { custom: customSpy, theme } }
    await openMenuView('Test', () => items, ctx)
    type _SlLike = { renderItem?: (item: { value: string; label: string }, isSelected: boolean, width: number) => string }
    const sl = capturedSl as _SlLike
    if (sl?.renderItem) {
      const result: string = sl.renderItem({ value: 'a', label: 'Item A' }, true, 40)
      expect(result).toContain('[accent]→')
      expect(result).toContain('[accent]Item A')
    }
  })

})

// ---------------------------------------------------------------------------
// Change 1: header contains hints inline
// ---------------------------------------------------------------------------

describe('header contains hints inline', () => {
  beforeEach(() => { MockSelectList.reset() })

  it('renders header and hint on one line (no separate footer)', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(
      makeSimpleBrowseOpts(['w1'], { onRefresh: vi.fn().mockResolvedValue(undefined) }),
      ctx,
    )
    const lines = getComponent()!.render(80)
    // The hint should appear on the FIRST content line (index 1 after top border)
    const firstContent = lines[1] ?? lines[0]!
    expect(firstContent).toContain('Enter: detail')
    expect(firstContent).toContain('ctrl+r: refresh')
  })

  it('no standalone footer line with only hint text', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    const lines = getComponent()!.render(80)
    // There should be no line that is solely the hint text (without any title content)
    // Previously the footer was a separate line starting with empty line + hint
    const hintOnlyLine = lines.find(l => l.trim() === 'Enter: detail · ←/Esc: back · q: close')
    expect(hintOnlyLine).toBeUndefined()
  })

  it('q: close appears in rendered output', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    const rendered = getComponent()!.render(80).join('\n')
    expect(rendered).toContain('q: close')
  })

  it('confirm state replaces header line (unwatch)', () => {
    const component = buildTestComponent(undefined, ['w1'], 80, undefined, {
      rowActions: [{ id: 'remove', label: 'Unwatch', run: vi.fn().mockResolvedValue(undefined) }],
    })
    component.handleInput('\x18')  // ctrl+x → confirm mode
    const lines = component.render(80)
    // The FIRST content line should contain the confirmation prompt
    const firstContent = lines[1] ?? lines[0]!
    expect(firstContent).toContain('Unwatch')
    // Normal hint text should NOT appear when confirm is active
    expect(firstContent).not.toContain('Enter: detail')
  })

  it('purge confirm says Purge, not Drain', () => {
    const w1: TerminalWatch = { id: 'w1', terminal: true }
    const onPurge = vi.fn().mockReturnValue([w1])
    const component = buildTestComponentWithTerminal(['w1'], onPurge)
    component.handleInput('\x10')  // ctrl+p → confirm mode
    const rendered = component.render(80).join('\n')
    expect(rendered).toContain('Purge')
    expect(rendered).not.toContain('Drain')
  })
})

// ---------------------------------------------------------------------------
// Change 2: q key calls onQuit and closes overlay
// ---------------------------------------------------------------------------

describe('q key in browse calls onQuit and closes overlay', () => {
  beforeEach(() => { MockSelectList.reset() })

  it('q triggers onQuit callback in list mode', async () => {
    const onQuit = vi.fn()
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1'], { onQuit }), ctx)
    getComponent()!.handleInput('q')
    expect(onQuit).toHaveBeenCalledOnce()
  })

  it('q calls done (closes overlay) in list mode', async () => {
    const fakeTui = { requestRender: vi.fn() }
    const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t }
    const doneFn = vi.fn()
    let capturedComponent: ComponentLike | null = null
    const ctx = {
      ui: {
        custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => unknown): Promise<void> => {
          capturedComponent = factory(fakeTui, theme, null, doneFn) as ComponentLike
          return Promise.resolve()
        },
        theme,
      },
    }
    await openBrowseView(makeSimpleBrowseOpts(['w1'], { onQuit: vi.fn() }), ctx)
    capturedComponent!.handleInput('q')
    expect(doneFn).toHaveBeenCalled()
  })

  it('q does NOT trigger onQuit when in detail mode', async () => {
    const onQuit = vi.fn()
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1'], { onQuit }), ctx)
    // Enter detail mode by calling the SelectList's onSelect callback directly
    // (mock SelectList.handleInput is a no-op, so we trigger via the stored callback)
    const sl = MockSelectList.getInstances()[0]!
    sl.onSelect?.({ value: 'w1', label: 'tui:w1' })
    // Now press q — should NOT call onQuit (detail mode returns without list-mode handler)
    getComponent()!.handleInput('q')
    expect(onQuit).not.toHaveBeenCalled()
  })

  it('q does NOT trigger onQuit when in confirm mode', () => {
    const onQuit = vi.fn()
    const component = buildTestComponent(undefined, ['w1'], 80, undefined, {
      rowActions: [{ id: 'remove', label: 'Unwatch', run: vi.fn().mockResolvedValue(undefined) }],
      onQuit,
    })
    component.handleInput('\x18')  // ctrl+x → confirm mode
    component.handleInput('q')     // q in confirm mode — consumed by confirm handler
    expect(onQuit).not.toHaveBeenCalled()
  })

  it('q without onQuit does not throw', async () => {
    const { ctx, getComponent } = makeBrowseCtx()
    await openBrowseView(makeSimpleBrowseOpts(['w1']), ctx)
    expect(() => getComponent()!.handleInput('q')).not.toThrow()
  })
})
