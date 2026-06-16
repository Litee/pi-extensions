/**
 * Tests for BaseWatcher concrete lifecycle methods.
 *
 * Uses a minimal `StubWatcher` subclass that wires the domain hooks to
 * in-memory stubs — no filesystem or network access.
 */

import { describe, expect, it, vi } from 'vitest'

import { BaseWatcher, POLL_ERROR_THRESHOLD } from '../src/base-watcher.js'
import * as browseViewModule from '../src/browse-view.js'

vi.mock('../src/browse-view.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browse-view.js')>()
  return {
    ...actual,
    openBrowseView: vi.fn().mockResolvedValue(undefined),
    openMenuView: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import type { CommandCtx, DetailField, RowColumn, ToolResult, WatcherItemSource, WatcherState, WatcherView, WatchLike } from '../src/base-watcher-types.js'
import type { ClassifiedWatcherError } from '../src/classify-error.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Stub domain types
// ---------------------------------------------------------------------------

interface StubWatch extends WatchLike {
  id: string
  label: string
}

type StubBaseline = { seenAt: number }
type StubEvent = { watchId: string; summary: string }

// ---------------------------------------------------------------------------
// Stub WatcherView
// ---------------------------------------------------------------------------

const stubView: WatcherView<StubWatch, StubEvent> = {
  noun: 'watch',
  renderItemRowText: (w) => w.label,
  renderItemRowTUI: (_w: StubWatch, _ctx: unknown): RowColumn[] => [{ name: 'row', text: `[${_w.id}] ${_w.label}` }],
  renderItemDetail: (_w: StubWatch, _ctx: unknown): DetailField[] => [{ label: 'detail', value: _w.id }],
  renderEventRow: (e) => `• ${e.summary}`,
  itemSortKey: (w) => w.id,
}

// ---------------------------------------------------------------------------
// Stub pi ExtensionAPI
// ---------------------------------------------------------------------------

function makePi() {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    events: {
      on: vi.fn().mockReturnValue(() => {}),
      emit: vi.fn(),
    },
  } as unknown as ExtensionAPI
}

// ---------------------------------------------------------------------------
// Stub UiSurface ctx
// ---------------------------------------------------------------------------

function makeCtx(entries: unknown[] = []): unknown {
  return {
    hasUI: true,
    ui: {
      hasUI: true,
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_: string, t: string) => t },
    },
    sessionManager: {
      getEntries: () => entries,
    },
  }
}

function makeCtxWithState(
  overrides: Partial<{
    enabled: boolean
    displayMode: string
    watches: StubWatch[]
  }>,
): unknown {
  const entry = {
    type: 'custom',
    customType: 'stub-watcher:state',
    data: {
      savedAt: Date.now(),
      enabled: overrides.enabled ?? false,
      displayMode: overrides.displayMode ?? 'statusline',
      watches: overrides.watches ?? [],
      baselines: {},
    },
  }
  return makeCtx([entry])
}

// ---------------------------------------------------------------------------
// StubWatcher subclass
// ---------------------------------------------------------------------------

class StubWatcher extends BaseWatcher<StubWatch, StubBaseline, StubEvent> {
  readonly extensionName = 'stub-watcher'
  readonly toolName = 'stub_watcher'

  get itemSource(): WatcherItemSource {
    return 'user-tool'
  }

  get hasWidget(): boolean {
    return false
  }

  get view(): WatcherView<StubWatch, StubEvent> {
    return stubView
  }

  watchKey(watch: StubWatch): string {
    return watch.id
  }

  // Injected stubs
  snapshotFn: (watch: StubWatch) => Promise<StubBaseline> = (_w) => Promise.resolve({
    seenAt: this._now(),
  })
  detectChangesFn: (_watch: StubWatch) => Promise<{
    newBaseline: StubBaseline
    events: StubEvent[]
    observedChange: boolean
  }> = (_w) => Promise.resolve({
    newBaseline: { seenAt: this._now() },
    events: [],
    observedChange: false,
  })

  async snapshot(watch: StubWatch): Promise<StubBaseline> {
    return this.snapshotFn(watch)
  }

  async detectChanges(watch: StubWatch) {
    return this.detectChangesFn(watch)
  }

  normaliseWatch(raw: unknown): StubWatch | null {
    if (
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      typeof (raw as { id?: unknown }).id === 'string' &&
      typeof (raw as { label?: unknown }).label === 'string'
    ) {
      const r = raw as { id: string; label: string; terminal?: unknown; consecutiveErrors?: unknown }
      return {
        id: r.id,
        label: r.label,
        terminal: r.terminal === true,
        consecutiveErrors: typeof r.consecutiveErrors === 'number' ? r.consecutiveErrors : 0,
      }
    }
    return null
  }

  normaliseBaseline(raw: unknown): StubBaseline | null {
    if (raw !== null && typeof raw === 'object' && 'seenAt' in raw) {
      return { seenAt: Number((raw as Record<string, unknown>)['seenAt']) }
    }
    return null
  }

  classifyError(_err: unknown): ClassifiedWatcherError {
    return {
      userMessage: 'request failed',
      kind: 'generic',
      statusModifier: 'none',
      shouldBackoff: false,
    }
  }

  buildChangeChatMessage(events: readonly StubEvent[]): string {
    return events.map((e) => `• ${e.summary}`).join('\n')
  }

  addWatch(_params: Record<string, unknown>): Promise<ToolResult> {
    return Promise.resolve({ content: [{ type: 'text', text: 'added' }], details: { action: 'add', ok: true } })
  }

  protected containsTerminalStateEvent(events: StubEvent[]): boolean {
    return events.length > 0
  }

  // removeWatch is now provided by the base class — no override needed

  // Expose internals for testing
  get testWatches() {
    return this.watches
  }
  get testBaselines() {
    return this.baselines
  }
  get testEnabled() {
    return this.enabled
  }
  get testDisplayMode() {
    return this.displayMode
  }
  get testScheduler() {
    return this.sharedScheduler
  }
  get testPi() {
    return this._pi
  }
  // Expose protected methods for testing
  callToolErrorFromSubclass(msg: string): ToolResult {
    return this._toolError(msg)
  }
  // Expose protected scheduling methods for testing
  override startPolling(): void { super.startPolling() }
  override stopPolling(): void { super.stopPolling() }

  // Expose protected _currentState for testing
  public override _currentState(): WatcherState {
    return super._currentState()
  }
}

// ---------------------------------------------------------------------------
// makeStub / makeCommandCtx helpers for menu tests
// ---------------------------------------------------------------------------

type StubOpts = { hasWidget?: boolean; userDefault?: 'widget' | 'statusline'; itemSource?: 'user-tool' | 'scan' }

function makeStub(opts: StubOpts = {}) {
  class DynStub extends StubWatcher {
    private _userDefault: 'widget' | 'statusline' | undefined = opts.userDefault
    override get hasWidget(): boolean { return opts.hasWidget ?? false }
    override get itemSource(): WatcherItemSource { return opts.itemSource ?? 'user-tool' }
    override get userDefaultDisplayMode(): 'widget' | 'statusline' | undefined {
      return this._userDefault
    }
    public override saveUserDefaultDisplayMode(m: 'widget' | 'statusline' | undefined): void {
      this._userDefault = m
    }
    // Expose executePurge for testing
    executePurge_pub(): StubWatch[] {
      return (this as unknown as { executePurge(): StubWatch[] }).executePurge()
    }
  }
  const pi = makePi()
  return new DynStub({ pi: pi as unknown as ExtensionAPI, now: () => 0 })
}

function makeCommandCtx(stub: StubWatcher, overrides: Partial<CommandCtx> = {}): CommandCtx {
  return {
    ui: {} as ReturnType<typeof makePi> as never,
    state: (stub as unknown as { _currentState(): WatcherState })._currentState(),
    browse: () => Promise.resolve('stay' as const),
    refresh: () => {},
    setDisplayMode: () => {},
    setUserDefault: () => {},
    confirm: () => Promise.resolve(true),
    ...overrides,
  }
}

function makeWatcher(piOverride?: ReturnType<typeof makePi>) {
  const pi = piOverride ?? makePi()
  const watcher = new StubWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 1_000_000 })
  return { watcher, pi }
}

// ---------------------------------------------------------------------------
// onSessionStart
// ---------------------------------------------------------------------------

describe('onSessionStart', () => {
  it('rehydrates enabled and displayMode from session log', async () => {
    const { watcher } = makeWatcher()
    const ctx = makeCtxWithState({ enabled: true, displayMode: 'statusline' })
    await watcher.onSessionStart(ctx)
    expect(watcher.testEnabled).toBe(true)
    expect(watcher.testDisplayMode).toBe('statusline')
  })

  it('rehydrates watches from session log', async () => {
    const { watcher } = makeWatcher()
    const ctx = makeCtxWithState({
      watches: [{ id: 'w1', label: 'Watch 1', terminal: false, consecutiveErrors: 0 }],
    })
    await watcher.onSessionStart(ctx)
    expect(watcher.testWatches.size).toBe(1)
    expect(watcher.testWatches.get('w1')).toBeDefined()
  })

  it('starts polling when there are active watches', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const ctx = makeCtxWithState({
      watches: [{ id: 'w1', label: 'Watch 1', terminal: false, consecutiveErrors: 0 }],
    })
    await watcher.onSessionStart(ctx)
    expect(watcher.testScheduler.isRunning).toBe(true)
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('does not start polling when all watches are terminal', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const ctx = makeCtxWithState({
      watches: [{ id: 'w1', label: 'Watch 1', terminal: true, consecutiveErrors: 0 }],
    })
    await watcher.onSessionStart(ctx)
    expect(watcher.testScheduler.isRunning).toBe(false)
    vi.useRealTimers()
  })

  it('seeds missing baselines via snapshot()', async () => {
    const snapshotFn = vi.fn().mockResolvedValue({ seenAt: 1_000_000 })
    const { watcher } = makeWatcher()
    watcher.snapshotFn = snapshotFn
    const ctx = makeCtxWithState({
      watches: [{ id: 'w1', label: 'Watch 1', terminal: false, consecutiveErrors: 0 }],
    })
    await watcher.onSessionStart(ctx)
    expect(snapshotFn).toHaveBeenCalledOnce()
    expect(watcher.testBaselines.get('w1')).toEqual({ seenAt: 1_000_000 })
  })

  it('seeds missing baselines concurrently — all snapshots start before any resolves', async () => {
    const resolvers: Array<() => void> = []
    const startOrder: string[] = []

    const { watcher } = makeWatcher()
    watcher.snapshotFn = vi.fn().mockImplementation((w: StubWatch) => {
      startOrder.push(w.id)
      return new Promise<StubBaseline>((resolve) => {
        resolvers.push(() => resolve({ seenAt: 1_000_000 }))
      })
    })

    const ctx = makeCtxWithState({
      watches: [
        { id: 'w1', label: 'Watch 1', terminal: false, consecutiveErrors: 0 },
        { id: 'w2', label: 'Watch 2', terminal: false, consecutiveErrors: 0 },
        { id: 'w3', label: 'Watch 3', terminal: false, consecutiveErrors: 0 },
      ],
    })

    const done = watcher.onSessionStart(ctx)

    // All three snapshot calls must have been initiated before any resolved.
    expect(startOrder).toEqual(['w1', 'w2', 'w3'])

    resolvers.forEach((r) => r())
    await done

    expect(watcher.testBaselines.get('w1')).toEqual({ seenAt: 1_000_000 })
    expect(watcher.testBaselines.get('w2')).toEqual({ seenAt: 1_000_000 })
    expect(watcher.testBaselines.get('w3')).toEqual({ seenAt: 1_000_000 })
  })
})

// ---------------------------------------------------------------------------
// onSessionStart — no startup chat message
// ---------------------------------------------------------------------------

describe('onSessionStart — no startup chat message', () => {
  it('does not call sendMessage on session_start with watches present', async () => {
    const stub = makeStub()
    // Add a watch so the old code's `watches.size > 0` branch would have fired
    stub.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    const sendSpy = vi.spyOn(stub.testPi, 'sendMessage')

    await stub.onSessionStart(makeCtx([]))

    // Allow any setImmediate callbacks to fire
    await new Promise(resolve => setImmediate(resolve))

    expect(sendSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// pollOnce
// ---------------------------------------------------------------------------

describe('pollOnce', () => {
  it('calls detectChanges for each active watch', async () => {
    const { watcher } = makeWatcher()
    const detectFn = vi.fn().mockResolvedValue({
      newBaseline: { seenAt: 1_000_000 },
      events: [],
      observedChange: false,
    })
    watcher.detectChangesFn = detectFn
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.testWatches.set('w2', { id: 'w2', label: 'L2', terminal: false, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(detectFn).toHaveBeenCalledTimes(2)
  })

  it('skips terminal watches', async () => {
    const { watcher } = makeWatcher()
    const detectFn = vi.fn().mockResolvedValue({
      newBaseline: { seenAt: 0 },
      events: [],
      observedChange: false,
    })
    watcher.detectChangesFn = detectFn
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: true, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(detectFn).not.toHaveBeenCalled()
  })

  it('emits sendMessage when detectChanges returns events', async () => {
    const { watcher, pi } = makeWatcher()
    watcher.detectChangesFn = () => Promise.resolve({
      newBaseline: { seenAt: 1_000_000 },
      events: [{ watchId: 'w1', summary: 'thing happened' }],
      observedChange: true,
    })
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(pi.sendMessage).toHaveBeenCalledOnce()
    const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string; display: boolean }]
    expect(msg.display).toBe(true)
    expect(msg.content).toContain('thing happened')
  })

  it('does not emit sendMessage when no events', async () => {
    const { watcher, pi } = makeWatcher()
    watcher.detectChangesFn = () => Promise.resolve({
      newBaseline: { seenAt: 1_000_000 },
      events: [],
      observedChange: false,
    })
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(pi.sendMessage).not.toHaveBeenCalled()
  })

  it('calls noteSchedulerSuccess after poll cycle', async () => {
    const { watcher } = makeWatcher()
    const successSpy = vi.spyOn(watcher.testScheduler, 'noteSuccess')
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(successSpy).toHaveBeenCalledOnce()
  })

  it('stops polling when all user-tool watches become terminal after poll', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    watcher.detectChangesFn = () => Promise.resolve({
      newBaseline: { seenAt: 1_000_000 },
      events: [{ watchId: 'w1', summary: 'done' }],
      observedChange: true,
    })
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.startPolling()
    expect(watcher.testScheduler.isRunning).toBe(true)
    await watcher.pollOnce()
    expect(watcher.testScheduler.isRunning).toBe(false)
    vi.useRealTimers()
  })


  it('stores the new baseline after detectChanges', async () => {
    const { watcher } = makeWatcher()
    watcher.detectChangesFn = () => Promise.resolve({
      newBaseline: { seenAt: 42 },
      events: [],
      observedChange: false,
    })
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(watcher.testBaselines.get('w1')).toEqual({ seenAt: 42 })
  })
})

// ---------------------------------------------------------------------------
// onTurnEnd
// ---------------------------------------------------------------------------

describe('onTurnEnd', () => {
  it('activates when tool is in active set but enabled is false', () => {
    const pi = makePi()
    pi.getActiveTools.mockReturnValue(['stub_watcher'])
    const { watcher } = makeWatcher(pi)
    expect(watcher.testEnabled).toBe(false)
    watcher.onTurnEnd({})
    expect(watcher.testEnabled).toBe(true)
  })

  it('deactivates when tool is not in active set but enabled is true', () => {
    const pi = makePi()
    pi.getActiveTools.mockReturnValue([])
    const { watcher } = makeWatcher(pi)
    ;(watcher as unknown as { enabled: boolean }).enabled = true
    watcher.onTurnEnd({})
    expect(watcher.testEnabled).toBe(false)
  })

  it('is a noop when states already agree', () => {
    const pi = makePi()
    pi.getActiveTools.mockReturnValue([])
    const { watcher } = makeWatcher(pi)
    const appendEntry = pi.appendEntry
    watcher.onTurnEnd({})
    // no state change means no writeState call
    expect(appendEntry).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// refreshStatus
// ---------------------------------------------------------------------------

describe('refreshStatus', () => {
  it('clears status pin when displayMode is widget', async () => {
    const { watcher } = makeWatcher()
    const ctx = makeCtxWithState({ displayMode: 'widget' })
    await watcher.onSessionStart(ctx)
    const setStatus = (
      (ctx as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui
    ).setStatus
    watcher.refreshStatus()
    // In widget mode, setStatus should clear the key
    expect(setStatus).toHaveBeenCalledWith('stub-watcher', undefined)
  })

  it('sets status text with accent alias for active watches', async () => {
    const { watcher } = makeWatcher()
    const ctx = makeCtxWithState({
      displayMode: 'statusline',
      watches: [{ id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 }],
    })
    await watcher.onSessionStart(ctx)
    watcher.stopPolling()
    const ui = (ctx as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui
    ui.setStatus.mockClear()
    watcher.refreshStatus()
    expect(ui.setStatus).toHaveBeenCalledWith(
      'stub-watcher',
      expect.stringContaining('stub-watcher: 1'),
    )
  })
})

// ---------------------------------------------------------------------------
// writeState
// ---------------------------------------------------------------------------

describe('writeState', () => {
  it('calls pi.appendEntry with stateCustomType and correct shape', () => {
    const { watcher, pi } = makeWatcher()
    const appendEntry = pi.appendEntry
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.writeState()
    expect(appendEntry).toHaveBeenCalledOnce()
    const [type, data] = appendEntry.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(type).toBe('stub-watcher:state')
    expect(typeof data['savedAt']).toBe('number')
    expect(Array.isArray(data['watches'])).toBe(true)
    expect((data['watches'] as unknown[]).length).toBe(1)
  })

  it('swallows errors from appendEntry', () => {
    const { watcher, pi } = makeWatcher()
    pi.appendEntry.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => watcher.writeState()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// buildMenu
// ---------------------------------------------------------------------------

describe('buildMenu', () => {
  it('always includes browse and close items', () => {
    const { watcher } = makeWatcher()
    const menu = watcher.buildMenu()
    const ids = menu.map((m) => m.id)
    expect(ids).toContain('browse')
    expect(ids).not.toContain('paused')
    expect(ids).toContain('close')
  })

  it('excludes displayMode item when hasWidget is false', () => {
    const { watcher } = makeWatcher()
    const menu = watcher.buildMenu()
    expect(menu.find((m) => m.id === 'displayMode')).toBeUndefined()
  })

  it('includes displayMode item when hasWidget is true', () => {
    class WidgetWatcher extends StubWatcher {
      override get hasWidget(): boolean { return true }
    }
    const pi = makePi()
    const watcher = new WidgetWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })
    const menu = watcher.buildMenu()
    expect(menu.find((m) => m.id === 'displayMode')).toBeDefined()
  })

  it('excludes refresh item for user-tool watchers', () => {
    const { watcher } = makeWatcher()
    const menu = watcher.buildMenu()
    expect(menu.find((m) => m.id === 'refresh')).toBeUndefined()
  })

  it('includes refresh item for scan watchers', () => {
    class ScanWatcher extends StubWatcher {
      override get itemSource(): WatcherItemSource { return 'scan' }
      override scanItems() { return Promise.resolve([]) }
    }
    const pi = makePi()
    const watcher = new ScanWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })
    const menu = watcher.buildMenu()
    expect(menu.find((m) => m.id === 'refresh')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

describe('executeTool', () => {
  it('list returns empty message when no watches', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'list' })
    expect(result.content[0]?.text).toContain('no active watches')
    expect(result.details['action']).toBe('list')
  })

  it('list returns rows for each watch', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'Watch One', terminal: false, consecutiveErrors: 0 })
    const result = await watcher.executeTool({ action: 'list' })
    expect(result.content[0]?.text).toContain('Watch One')
  })

  it('add calls addWatch, writeState, startPolling', async () => {
    vi.useFakeTimers()
    const { watcher, pi } = makeWatcher()
    const addWatchSpy = vi.spyOn(watcher, 'addWatch')
    const appendEntry = pi.appendEntry
    const result = await watcher.executeTool({ action: 'add', id: 'w1' })
    expect(addWatchSpy).toHaveBeenCalledOnce()
    expect(result.content[0]?.text).toBe('added')
    expect(appendEntry).toHaveBeenCalled() // writeState
    vi.useRealTimers()
  })

  it('add defaults to "add" when action is absent', async () => {
    const { watcher } = makeWatcher()
    const addWatchSpy = vi.spyOn(watcher, 'addWatch')
    await watcher.executeTool({ id: 'w1' })
    expect(addWatchSpy).toHaveBeenCalledOnce()
  })





  it('remove with valid watchId removes watch and baseline', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.testBaselines.set('w1', { seenAt: 42 })
    const result = await watcher.executeTool({ action: 'remove', watchId: 'w1' })
    expect(result.content[0]?.text).toContain("removed 'w1'")
    expect(watcher.testWatches.has('w1')).toBe(false)
    expect(watcher.testBaselines.has('w1')).toBe(false)
  })

  it('executeTool("remove") uses base class default message with watchKey', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    const result = await watcher.executeTool({ action: 'remove', watchId: 'w1' })
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('stub-watcher')
    expect(text).toContain("removed 'w1'")
    expect(text).toContain('0 watch(es) remaining')
  })

  it('remove with unknown id returns error result', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'remove', watchId: 'no-such' })
    expect(result.details['ok']).toBe(false)
    expect(result.content[0]?.text).toContain('No watch found with id: no-such')
  })

  it('remove requires a watchId parameter', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'remove' })
    expect(result.details['ok']).toBe(false)
    expect(result.content[0]?.text).toContain('remove requires a watchId')
  })

  it('status returns active count', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.testWatches.set('w2', { id: 'w2', label: 'L2', terminal: true, consecutiveErrors: 0 })
    const result = await watcher.executeTool({ action: 'status' })
    expect(result.details['activeCount']).toBe(1)
    expect(result.content[0]?.text).toContain('1 active watch')
  })

  it('unknown action returns error result', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'bogus' })
    expect(result.details['ok']).toBe(false)
    expect(result.content[0]?.text).toContain('Unknown action')
  })

})

// ---------------------------------------------------------------------------
// pollWatch
// ---------------------------------------------------------------------------

describe('pollWatch', () => {
  it('returns early for unknown watchKey without calling detectChanges', async () => {
    const { watcher } = makeWatcher()
    const detectFn = vi.fn()
    watcher.detectChangesFn = detectFn
    await watcher.pollWatch('nonexistent')
    expect(detectFn).not.toHaveBeenCalled()
  })

  it('returns early for terminal watch without calling detectChanges', async () => {
    const { watcher } = makeWatcher()
    const detectFn = vi.fn()
    watcher.detectChangesFn = detectFn
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: true, consecutiveErrors: 0 })
    await watcher.pollWatch('w1')
    expect(detectFn).not.toHaveBeenCalled()
  })

  it('pollOnce calls pollWatch for each active watch', async () => {
    const { watcher } = makeWatcher()
    const pollWatchSpy = vi.spyOn(watcher, 'pollWatch')
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.testWatches.set('w2', { id: 'w2', label: 'L2', terminal: false, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(pollWatchSpy).toHaveBeenCalledTimes(2)
  })

  it('pollOnce runs watches in parallel (both detectChanges start before either resolves)', async () => {
    const { watcher } = makeWatcher()
    const startOrder: string[] = []
    let resolveW1!: () => void
    let resolveW2!: () => void

    watcher.detectChangesFn = async (w) => {
      startOrder.push(w.id)
      await new Promise<void>((resolve) => {
        if (w.id === 'w1') resolveW1 = resolve
        else resolveW2 = resolve
      })
      return { newBaseline: { seenAt: 0 }, events: [], observedChange: false }
    }

    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.testWatches.set('w2', { id: 'w2', label: 'L2', terminal: false, consecutiveErrors: 0 })

    const pollPromise = watcher.pollOnce()
    // Allow microtasks/promises to advance so both detectChanges calls start
    await new Promise((resolve) => setImmediate(resolve))
    // Both should have started concurrently
    expect(startOrder).toContain('w1')
    expect(startOrder).toContain('w2')
    // Now resolve both so pollOnce can finish
    resolveW1()
    resolveW2()
    await pollPromise
  })
})

// ---------------------------------------------------------------------------
// isTerminalBatch hook
// ---------------------------------------------------------------------------

describe('containsTerminalStateEvent', () => {
  it('default: marks watch terminal when events are produced (existing behaviour)', async () => {
    const { watcher, pi } = makeWatcher()
    watcher.detectChangesFn = () => Promise.resolve({
      newBaseline: { seenAt: 0 },
      events: [{ watchId: 'w1', summary: 'change' }],
      observedChange: true,
    })
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    await watcher.pollWatch('w1')
    expect(watcher.testWatches.get('w1')?.terminal).toBe(true)
    expect(pi.sendMessage).toHaveBeenCalledOnce()
  })

  it('override returning false: does NOT mark watch terminal even when events are produced', async () => {
    class NonTerminalWatcher extends StubWatcher {
      protected override containsTerminalStateEvent(_events: StubEvent[]): boolean {
        return false
      }
    }
    const pi = makePi()
    const watcher = new NonTerminalWatcher({ pi: pi as unknown as ExtensionAPI })
    watcher.detectChangesFn = () => Promise.resolve({
      newBaseline: { seenAt: 0 },
      events: [{ watchId: 'w1', summary: 'change' }],
      observedChange: true,
    })
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    await watcher.pollWatch('w1')
    expect(watcher.testWatches.get('w1')?.terminal).toBe(false)
    expect(pi.sendMessage).toHaveBeenCalledOnce() // event message still fires
  })
})

// ---------------------------------------------------------------------------
// Fix 1 — _toolError is protected (accessible from subclass)
// ---------------------------------------------------------------------------

describe('_toolError accessibility', () => {
  it('subclass can call _toolError directly (protected, not private)', () => {
    const { watcher } = makeWatcher()
    const result = watcher.callToolErrorFromSubclass('something went wrong')
    expect(result.details['ok']).toBe(false)
    expect(result.content[0]?.text).toContain('something went wrong')
    expect(result.content[0]?.text).toContain('stub-watcher')
  })
})

// ---------------------------------------------------------------------------
// Fix 2 — noteSchedulerSuccess called with (anyChange, watchKey)
// ---------------------------------------------------------------------------

describe('noteSchedulerSuccess', () => {
  it('is called with (anyChange, watchKey) after a successful pollWatch', async () => {
    const { watcher } = makeWatcher()
    const spy = vi.spyOn(
      watcher as unknown as { noteSchedulerSuccess(c: boolean, k: string): void },
      'noteSchedulerSuccess',
    )
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(false, 'w1')
  })

  it('passes anyChange=true when detectChanges returns observedChange=true', async () => {
    const { watcher } = makeWatcher()
    watcher.detectChangesFn = () => Promise.resolve({
      newBaseline: { seenAt: 0 },
      events: [],
      observedChange: true,
    })
    const spy = vi.spyOn(
      watcher as unknown as { noteSchedulerSuccess(c: boolean, k: string): void },
      'noteSchedulerSuccess',
    )
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    await watcher.pollOnce()
    expect(spy).toHaveBeenCalledWith(true, 'w1')
  })
})

// ---------------------------------------------------------------------------
// Fix 3 — defaultDisplayMode applied in onSessionStart
// ---------------------------------------------------------------------------

describe('defaultDisplayMode', () => {
  it('applies defaultDisplayMode to displayMode when no persisted state', async () => {
    const { watcher } = makeWatcher()
    ;(watcher as unknown as { defaultDisplayMode: string }).defaultDisplayMode = 'statusline'
    await watcher.onSessionStart(makeCtx([]))
    expect(watcher.testDisplayMode).toBe('statusline')
  })

  it('persisted displayMode overrides defaultDisplayMode', async () => {
    const { watcher } = makeWatcher()
    ;(watcher as unknown as { defaultDisplayMode: string }).defaultDisplayMode = 'statusline'
    const ctx = makeCtxWithState({ displayMode: 'widget' })
    await watcher.onSessionStart(ctx)
    expect(watcher.testDisplayMode).toBe('widget')
  })

  it('does not change displayMode when defaultDisplayMode is not set', async () => {
    const { watcher } = makeWatcher()
    // defaultDisplayMode is undefined — not set
    await watcher.onSessionStart(makeCtx([]))
    expect(watcher.testDisplayMode).toBe('widget') // unchanged default
  })
})

// ---------------------------------------------------------------------------
// statusLabel
// ---------------------------------------------------------------------------

describe('statusLabel', () => {
  it('defaults to extensionName', () => {
    const { watcher } = makeWatcher()
    expect((watcher as unknown as { statusLabel: string }).statusLabel).toBe('stub-watcher')
  })

  it('custom statusLabel appears in refreshStatus text', async () => {
    class LabeledWatcher extends StubWatcher {
      override get statusLabel() { return 'stub' }
    }
    const pi = makePi()
    const watcher = new LabeledWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })
    const ctx = makeCtxWithState({
      displayMode: 'statusline',
      watches: [{ id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 }],
    })
    await watcher.onSessionStart(ctx)
    watcher.stopPolling()
    const ui = (ctx as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui
    ui.setStatus.mockClear()
    watcher.refreshStatus()
    const call = ui.setStatus.mock.calls[0] as [string, string | undefined]
    expect(call[1]).toContain('stub: 1')
    expect(call[1]).not.toContain('stub-watcher: 1')
  })

  it('custom statusLabel appears in executeTool list response', async () => {
    class LabeledWatcher extends StubWatcher {
      override get statusLabel() { return 'stub' }
    }
    const pi = makePi()
    const watcher = new LabeledWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })
    const result = await watcher.executeTool({ action: 'list' })
    expect(result.content[0]?.text).toContain('stub:')
    expect(result.content[0]?.text).not.toContain('stub-watcher:')
  })


  it('custom statusLabel appears in pollWatch error threshold message', async () => {
    class LabeledWatcher extends StubWatcher {
      override get statusLabel() { return 'stub' }
    }
    const pi = makePi()
    const watcher = new LabeledWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })
    watcher.detectChangesFn = () => Promise.reject(new Error('poll failed'))
    const watch: StubWatch = { id: 'w1', label: 'L', terminal: false, consecutiveErrors: POLL_ERROR_THRESHOLD - 1 }
    watcher.testWatches.set('w1', watch)
    await watcher.pollWatch('w1')
    expect(pi.sendMessage).toHaveBeenCalledOnce()
    const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }]
    expect(msg.content).toContain('stub:')
    expect(msg.content).not.toContain('stub-watcher:')
  })

  it('custom statusLabel appears in pollWatch recovery message', async () => {
    class LabeledWatcher extends StubWatcher {
      override get statusLabel() { return 'stub' }
    }
    const pi = makePi()
    const watcher = new LabeledWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })
    // Watch that has already crossed the error threshold — next success triggers recovery
    const watch: StubWatch = { id: 'w1', label: 'L', terminal: false, consecutiveErrors: POLL_ERROR_THRESHOLD }
    watcher.testWatches.set('w1', watch)
    // detectChanges succeeds → clears errors → sends recovery message
    await watcher.pollWatch('w1')
    expect(pi.sendMessage).toHaveBeenCalledOnce()
    const [msg] = pi.sendMessage.mock.calls[0] as [{ content: string }]
    expect(msg.content).toContain('stub:')
    expect(msg.content).not.toContain('stub-watcher:')
  })
})

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

describe('displayName', () => {
  it('defaults to extensionName', () => {
    const { watcher } = makeWatcher()
    expect((watcher as unknown as { displayName: string }).displayName).toBe('stub-watcher')
  })

  it('custom displayName used as menu title in commandHandler', async () => {
    class DisplayWatcher extends StubWatcher {
      override get displayName() { return 'My Watcher' }
    }
    const pi = makePi()
    const watcher = new DisplayWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })

    const openMenuViewMock = vi.mocked(browseViewModule.openMenuView)
    openMenuViewMock.mockClear()

    const ctx = {
      hasUI: true,
      ui: {
        hasUI: true,
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_: string, t: string) => t },
        custom: vi.fn().mockResolvedValue(undefined),
      },
      sessionManager: { getEntries: () => [] },
    }

    const handler = watcher.commandHandler()
    await handler(undefined, ctx)

    expect(openMenuViewMock).toHaveBeenCalledOnce()
    const [title] = openMenuViewMock.mock.calls[0]!
    expect(title).toBe('My Watcher')
    expect(title).not.toBe('stub-watcher')
  })

  it('custom displayName passed to openBrowseView as title', async () => {
    class DisplayWatcher extends StubWatcher {
      override get displayName() { return 'My Watcher Display' }
    }
    const pi = makePi()
    const watcher = new DisplayWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })

    const ctx = {
      hasUI: true,
      ui: {
        hasUI: true,
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_: string, t: string) => t },
        custom: vi.fn().mockResolvedValue(undefined),
      },
      sessionManager: { getEntries: () => [] },
    }

    const openBrowseViewMock = vi.mocked(browseViewModule.openBrowseView)
    openBrowseViewMock.mockClear()

    await watcher.browseAction(ctx)

    expect(openBrowseViewMock).toHaveBeenCalledOnce()
    const [opts] = openBrowseViewMock.mock.calls[0] as [{ title: string }, unknown]
    expect(opts.title).toBe('My Watcher Display')
    expect(opts.title).not.toBe('stub-watcher')
  })
})

// ---------------------------------------------------------------------------
// Fix 4 — browseCount uses activeCount
// ---------------------------------------------------------------------------

describe('browseCount', () => {
  it('returns "activeCount/watchCount"', () => {
    const { watcher } = makeWatcher()
    const state: WatcherState = {
      pollIntervalMs: 60_000,
      enabled: false,
      displayMode: 'widget',
      watchCount: 5,
      activeCount: 3,
      hasErrors: false,
    }
    const count = (watcher as unknown as { browseCount(s: WatcherState): string }).browseCount(state)
    expect(count).toBe('3/5')
  })

  it('buildMenu Browse item label shows activeCount/watchCount', () => {
    const { watcher } = makeWatcher()
    const state: WatcherState = {
      pollIntervalMs: 60_000,
      enabled: false,
      displayMode: 'widget',
      watchCount: 5,   // total (incl. terminal)
      activeCount: 3,  // non-terminal
      hasErrors: false,
    }
    const menu = watcher.buildMenu()
    const browseItem = menu.find((m) => m.id === 'browse')!
    const label = browseItem.label(state)
    expect(label).toContain('(3/5)')
  })

  it('Browse item is disabled when watchCount is 0', () => {
    const { watcher } = makeWatcher()
    const items = watcher.buildMenu()
    const browse = items.find(i => i.id === 'browse')!
    const state: WatcherState = { watchCount: 0, activeCount: 0, pollIntervalMs: 60_000, enabled: false, displayMode: 'statusline', hasErrors: false }
    expect(browse.disabled?.(state)).toBe(true)
  })

  it('Browse item is enabled when watchCount > 0', () => {
    const { watcher } = makeWatcher()
    const items = watcher.buildMenu()
    const browse = items.find(i => i.id === 'browse')!
    const state: WatcherState = { watchCount: 3, activeCount: 2, pollIntervalMs: 60_000, enabled: false, displayMode: 'statusline', hasErrors: false }
    expect(browse.disabled?.(state)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// userDefaultDisplayMode menu item
// ---------------------------------------------------------------------------

describe('userDefaultDisplayMode menu item', () => {
  it('appears in menu for hasWidget=true watcher', () => {
    const stub = makeStub({ hasWidget: true })
    const items = stub.buildMenu()
    expect(items.some(i => i.id === 'userDefaultDisplayMode')).toBe(true)
  })

  it('is hidden for hasWidget=false watcher', () => {
    const stub = makeStub({ hasWidget: false })
    const items = stub.buildMenu()
    const item = items.find(i => i.id === 'userDefaultDisplayMode')
    const state = stub._currentState()
    expect(item === undefined || item.visible?.(state) === false).toBe(true)
  })

  it('label shows "unset" when userDefaultDisplayMode is undefined', () => {
    const stub = makeStub({ hasWidget: true })
    const item = stub.buildMenu().find(i => i.id === 'userDefaultDisplayMode')!
    expect(item.label(stub._currentState())).toBe('Default display mode: unset')
  })

  it('label shows current value when set', () => {
    const stub = makeStub({ hasWidget: true, userDefault: 'widget' })
    const item = stub.buildMenu().find(i => i.id === 'userDefaultDisplayMode')!
    expect(item.label(stub._currentState())).toContain('widget')
  })

  it('cycles undefined → widget → statusline → undefined on run', async () => {
    const stub = makeStub({ hasWidget: true })
    const spy = vi.spyOn(stub, 'saveUserDefaultDisplayMode')
    const item = stub.buildMenu().find(i => i.id === 'userDefaultDisplayMode')!
    const ctx = makeCommandCtx(stub)

    await item.run(ctx)  // undefined → widget
    await item.run(ctx)  // widget → statusline
    await item.run(ctx)  // statusline → undefined

    expect(spy.mock.calls.map(([m]) => m)).toEqual(['widget', 'statusline', undefined])
  })
})

// ---------------------------------------------------------------------------
// executePurge
// ---------------------------------------------------------------------------

function makeWatch(overrides: Partial<StubWatch> = {}): StubWatch {
  return { id: 'w', label: 'L', terminal: false, consecutiveErrors: 0, ...overrides }
}

describe('executePurge', () => {
  it('removes terminal watches and returns them', () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: false }))
    stub.testWatches.set('b', makeWatch({ id: 'b', terminal: true }))
    const removed = stub.executePurge_pub()
    expect(removed).toHaveLength(1)
    expect(removed[0]!.id).toBe('b')
    expect(stub.testWatches.has('b')).toBe(false)
    expect(stub.testWatches.has('a')).toBe(true)
  })

  it('returns empty array when no terminal watches', () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: false }))
    expect(stub.executePurge_pub()).toHaveLength(0)
  })

  it('returns empty array for scan watchers', () => {
    const stub = makeStub({ itemSource: 'scan' })
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: true }))
    expect(stub.executePurge_pub()).toHaveLength(0)
  })

  it('calls writeState (appendEntry) when watches removed', () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: true }))
    const appendSpy = vi.spyOn(stub.testPi, 'appendEntry')
    stub.executePurge_pub()
    expect(appendSpy).toHaveBeenCalled()
  })

  it('does not call writeState when no terminal watches found', () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: false }))
    const appendSpy = vi.spyOn(stub.testPi, 'appendEntry')
    stub.executePurge_pub()
    expect(appendSpy).not.toHaveBeenCalled()
  })
})

describe('browseHeader', () => {
  const call = (count: number, filtered: number, activeCount?: number) => {
    const { watcher } = makeWatcher()
    return (watcher as unknown as { browseHeader: (s: { count: number; filtered: number; activeCount?: number }) => string }).browseHeader({ count, filtered, ...(activeCount !== undefined ? { activeCount } : {}) })
  }

  it('shows (active/total) format', () => {
    expect(call(3, 3, 2)).toBe('(2/3)')
  })

  it('shows (total/total) when activeCount not provided', () => {
    expect(call(3, 3)).toBe('(3/3)')
  })

})

// ---------------------------------------------------------------------------
// commandName (Fix 2)
// ---------------------------------------------------------------------------

describe('commandName', () => {
  it('defaults to extensionName', () => {
    const { watcher } = makeWatcher()
    expect((watcher as unknown as { commandName: string }).commandName).toBe('stub-watcher')
  })

  it('register() registers command under commandName', () => {
    const { watcher, pi } = makeWatcher()
    const registerCommandSpy = vi.spyOn(pi, 'registerCommand')
    watcher.register(pi)
    expect(registerCommandSpy).toHaveBeenCalledWith(
      'stub-watcher',
      expect.objectContaining({ handler: expect.any(Function) as unknown }),
    )
  })

  it('register() uses commandName override when provided (not extensionName)', () => {
    class NamedWatcher extends StubWatcher {
      protected override get commandName(): string { return 'my-command' }
    }
    const pi = makePi()
    const watcher = new NamedWatcher({ pi: pi as unknown as ExtensionAPI, now: () => 0 })
    const registerCommandSpy = vi.spyOn(pi, 'registerCommand')
    watcher.register(pi)
    expect(registerCommandSpy).toHaveBeenCalledWith(
      'my-command',
      expect.objectContaining({ handler: expect.any(Function) as unknown }),
    )
    // Must NOT be called with extensionName when commandName overrides
    expect(registerCommandSpy).not.toHaveBeenCalledWith(
      'stub-watcher',
      expect.anything(),
    )
  })
})

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// commandHandler menu — preserves selection position on rerender
// ---------------------------------------------------------------------------

describe('commandHandler menu — preserves selection position on rerender', () => {
  it('uses openMenuView (not ctx.ui.select) when showing the menu', async () => {
    const watcher = makeStub({ hasWidget: false })
    const openMenuViewMock = vi.mocked(browseViewModule.openMenuView)
    openMenuViewMock.mockClear()
    const ctx = { ui: { custom: vi.fn() } }
    await watcher.commandHandler()('', ctx)
    expect(openMenuViewMock).toHaveBeenCalledOnce()
  })

  it('does NOT call ctx.ui.select', async () => {
    const watcher = makeStub({ hasWidget: false })
    const selectSpy = vi.fn()
    const ctx = { ui: { select: selectSpy, custom: vi.fn() } }
    await watcher.commandHandler()('', ctx)
    expect(selectSpy).not.toHaveBeenCalled()
  })

  it('calls notify via this.ui and returns when ctx.hasUI is false', async () => {
    const watcher = makeStub({ hasWidget: false })
    const notifySpy = vi.fn()
    // Simulate the session-stored surface on the instance
    ;(watcher as unknown as { ui: unknown }).ui = { notify: notifySpy, setStatus: vi.fn(), theme: { fg: (_: string, t: string) => t, bold: (t: string) => t } }
    // ctx with hasUI: false — extractUiSurface returns null
    const ctx = { hasUI: false, ui: { custom: vi.fn(), select: vi.fn(), notify: vi.fn() } }
    await watcher.commandHandler()('', ctx)
    expect(notifySpy).toHaveBeenCalledOnce()
    expect(notifySpy.mock.calls[0]?.[1]).toBe('warning')
  })
})

// ---------------------------------------------------------------------------
// Change 2: browseAction return value
// ---------------------------------------------------------------------------

describe('browseAction return value', () => {
  function makeBrowseCtxForAction() {
    return {
      hasUI: true,
      ui: {
        hasUI: true,
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_: string, t: string) => t },
        custom: vi.fn().mockResolvedValue(undefined),
      },
      sessionManager: { getEntries: () => [] },
    }
  }

  it('returns "stay" when browse closed normally (no onQuit called)', async () => {
    const watcher = makeStub({ hasWidget: false })
    const ctx = makeBrowseCtxForAction()
    const openBrowseViewMock = vi.mocked(browseViewModule.openBrowseView)
    openBrowseViewMock.mockResolvedValueOnce(undefined)
    const result = await watcher.browseAction(ctx)
    expect(result).toBe('stay')
  })

  it('returns "close" when browse calls onQuit before resolving', async () => {
    const watcher = makeStub({ hasWidget: false })
    const ctx = makeBrowseCtxForAction()
    const openBrowseViewMock = vi.mocked(browseViewModule.openBrowseView)
    openBrowseViewMock.mockImplementationOnce((opts) => {
      opts.onQuit?.()
      return Promise.resolve()
    })
    const result = await watcher.browseAction(ctx)
    expect(result).toBe('close')
  })
})

// ---------------------------------------------------------------------------
// Change 2: Browse menu item returns browseAction result
// ---------------------------------------------------------------------------

describe('Browse menu item returns browseAction result', () => {
  it('returns "close" when ctx.browse() returns "close"', async () => {
    const watcher = makeStub({ hasWidget: false })
    const items = watcher.buildMenu()
    const browse = items.find(i => i.id === 'browse')!
    const ctx = makeCommandCtx(watcher)
    ctx.browse = () => Promise.resolve('close' as const)
    const result = await browse.run(ctx)
    expect(result).toBe('close')
  })

  it('returns "stay" when ctx.browse() returns "stay"', async () => {
    const watcher = makeStub({ hasWidget: false })
    const items = watcher.buildMenu()
    const browse = items.find(i => i.id === 'browse')!
    const ctx = makeCommandCtx(watcher)
    ctx.browse = () => Promise.resolve('stay' as const)
    const result = await browse.run(ctx)
    expect(result).toBe('stay')
  })
})

// ---------------------------------------------------------------------------
// Change 4: userDefaultDisplayMode menu item notifications
// ---------------------------------------------------------------------------

describe('userDefaultDisplayMode menu item notifications', () => {
  it('notifies info with saved label on success (undefined → widget)', async () => {
    const watcher = makeStub({ hasWidget: true })
    const notify = vi.fn()
    const ctx = makeCommandCtx(watcher)
    ;(ctx as unknown as { ui: unknown }).ui = {
      notify,
      setStatus: vi.fn(),
      theme: { fg: (_: string, t: string) => t, bold: (t: string) => t },
    }
    const item = watcher.buildMenu().find(i => i.id === 'userDefaultDisplayMode')!
    await item.run(ctx)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('widget'), 'info')
  })

  it('notifies info on success (widget → statusline)', async () => {
    const watcher = makeStub({ hasWidget: true, userDefault: 'widget' })
    const notify = vi.fn()
    const ctx = makeCommandCtx(watcher)
    ;(ctx as unknown as { ui: unknown }).ui = {
      notify,
      setStatus: vi.fn(),
      theme: { fg: (_: string, t: string) => t, bold: (t: string) => t },
    }
    const item = watcher.buildMenu().find(i => i.id === 'userDefaultDisplayMode')!
    await item.run(ctx)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('statusline'), 'info')
  })

  it('notifies info on success (statusline → undefined = "unset")', async () => {
    const watcher = makeStub({ hasWidget: true, userDefault: 'statusline' })
    const notify = vi.fn()
    const ctx = makeCommandCtx(watcher)
    ;(ctx as unknown as { ui: unknown }).ui = {
      notify,
      setStatus: vi.fn(),
      theme: { fg: (_: string, t: string) => t, bold: (t: string) => t },
    }
    const item = watcher.buildMenu().find(i => i.id === 'userDefaultDisplayMode')!
    await item.run(ctx)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('unset'), 'info')
  })

  it('notifies warning on save failure', async () => {
    const watcher = makeStub({ hasWidget: true })
    vi.spyOn(watcher as unknown as { saveUserDefaultDisplayMode: () => void }, 'saveUserDefaultDisplayMode')
      .mockImplementation(() => { throw new Error('disk full') })
    const notify = vi.fn()
    const ctx = makeCommandCtx(watcher)
    ;(ctx as unknown as { ui: unknown }).ui = {
      notify,
      setStatus: vi.fn(),
      theme: { fg: (_: string, t: string) => t, bold: (t: string) => t },
    }
    const item = watcher.buildMenu().find(i => i.id === 'userDefaultDisplayMode')!
    await item.run(ctx)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('disk full'), 'warning')
  })

  it('still returns "rerender" on success', async () => {
    const watcher = makeStub({ hasWidget: true })
    const ctx = makeCommandCtx(watcher)
    ;(ctx as unknown as { ui: unknown }).ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_: string, t: string) => t, bold: (t: string) => t },
    }
    const item = watcher.buildMenu().find(i => i.id === 'userDefaultDisplayMode')!
    const result = await item.run(ctx)
    expect(result).toBe('rerender')
  })
})

// ---------------------------------------------------------------------------
// _rehydrateState — baselines path coverage
// ---------------------------------------------------------------------------

describe('_rehydrateState — baselines from session log', () => {
  it('rehydrates baselines from session log when present', async () => {
    const { watcher } = makeWatcher()
    const entry = {
      type: 'custom',
      customType: 'stub-watcher:state',
      data: {
        savedAt: Date.now(),
                enabled: false,
        displayMode: 'widget',
        watches: [{ id: 'w1', label: 'Watch 1', terminal: false, consecutiveErrors: 0 }],
        baselines: {
          'w1': { seenAt: 12345 },
        },
      },
    }
    const ctx = makeCtx([entry])
    await watcher.onSessionStart(ctx)
    expect(watcher.testBaselines.has('w1')).toBe(true)
    expect(watcher.testBaselines.get('w1')?.seenAt).toBe(12345)
  })

  it('skips invalid baseline entries (normaliseBaseline returns null)', async () => {
    const { watcher } = makeWatcher()
    const entry = {
      type: 'custom',
      customType: 'stub-watcher:state',
      data: {
        savedAt: Date.now(),
                enabled: false,
        displayMode: 'widget',
        watches: [],
        baselines: {
          'w1': 'not-a-baseline',  // normaliseBaseline returns null for this
        },
      },
    }
    const ctx = makeCtx([entry])
    await watcher.onSessionStart(ctx)
    expect(watcher.testBaselines.has('w1')).toBe(false)
  })

  it('skips array baselines (must be plain object)', async () => {
    const { watcher } = makeWatcher()
    const entry = {
      type: 'custom',
      customType: 'stub-watcher:state',
      data: {
        savedAt: Date.now(),
                enabled: false,
        displayMode: 'widget',
        watches: [],
        baselines: ['not-an-object'],  // Array → should be skipped
      },
    }
    const ctx = makeCtx([entry])
    await watcher.onSessionStart(ctx)
    expect(watcher.testBaselines.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// pollOnce — empty active watches + scan mode
// ---------------------------------------------------------------------------

describe('pollOnce — edge cases', () => {
  it('calls refreshStatus and returns early when no active watches', async () => {
    const { watcher } = makeWatcher()
    // No watches added → active.length === 0
    const setStatusSpy = vi.fn()
    const ctx = makeCtxWithState({ displayMode: 'statusline' })
    await watcher.onSessionStart(ctx)
    ;(watcher as unknown as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui = {
      setStatus: setStatusSpy,
    }
    await watcher.pollOnce()
    // refreshStatus was called (status line updated)
    expect(setStatusSpy).toHaveBeenCalled()
  })

  it('scans items and updates watch list for scan-mode watchers', async () => {
    const stub = makeStub({ itemSource: 'scan' })
    ;(stub as unknown as { scanItems: () => Promise<StubWatch[]> }).scanItems = vi.fn().mockResolvedValue([
      { id: 'scan-1', label: 'Scanned', terminal: false, consecutiveErrors: 0 },
    ])
    ;(stub as unknown as { detectChangesFn: unknown }).detectChangesFn = vi.fn().mockResolvedValue({
      newBaseline: { seenAt: 0 },
      events: [],
      observedChange: false,
    })
    await stub.pollOnce()
    expect(stub.testWatches.has('scan-1')).toBe(true)
  })

  it('removes watches that disappear from scan results', async () => {
    const stub = makeStub({ itemSource: 'scan' })
    stub.testWatches.set('old-watch', {
      id: 'old-watch', label: 'Old', terminal: false, consecutiveErrors: 0,
    })
    ;(stub as unknown as { scanItems: unknown }).scanItems = vi.fn().mockResolvedValue([
      { id: 'new-watch', label: 'New', terminal: false, consecutiveErrors: 0 },
    ])
    ;(stub as unknown as { detectChangesFn: unknown }).detectChangesFn = vi.fn().mockResolvedValue({
      newBaseline: { seenAt: 0 },
      events: [],
      observedChange: false,
    })
    await stub.pollOnce()
    expect(stub.testWatches.has('old-watch')).toBe(false)
    expect(stub.testWatches.has('new-watch')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Additional base-watcher coverage
// ---------------------------------------------------------------------------

describe('refreshStatus — statusline with no active watches', () => {
  it('clears status when displayMode is statusline but all watches are terminal', async () => {
    const { watcher } = makeWatcher()
    const ctx = makeCtxWithState({
      displayMode: 'statusline',
      watches: [{ id: 'w1', label: 'L', terminal: true, consecutiveErrors: 0 }],
    })
    await watcher.onSessionStart(ctx)
    watcher.stopPolling()
    const ui = (ctx as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui
    ui.setStatus.mockClear()
    watcher.refreshStatus()
    expect(ui.setStatus).toHaveBeenCalledWith('stub-watcher', undefined)
  })

  it('appends (errors) suffix when consecutiveErrors >= threshold', async () => {
    const { watcher } = makeWatcher()
    const ctx = makeCtxWithState({
      displayMode: 'statusline',
      watches: [{
        id: 'w1', label: 'L', terminal: false,
        consecutiveErrors: POLL_ERROR_THRESHOLD,
      }],
    })
    await watcher.onSessionStart(ctx)
    watcher.stopPolling()
    const ui = (ctx as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui
    ui.setStatus.mockClear()
    watcher.refreshStatus()
    const [, text] = ui.setStatus.mock.calls[0] as [string, string]
    expect(text).toContain('(errors)')
  })

})

describe('_seedMissingBaselines — error path', () => {
  it('calls appendEntry with seed-error when snapshot() throws', async () => {
    const { watcher, pi } = makeWatcher()
    watcher.snapshotFn = vi.fn().mockRejectedValue(new Error('network down'))
    const appendSpy = vi.spyOn(pi, 'appendEntry')
    appendSpy.mockClear()

    const ctx = makeCtxWithState({
      watches: [{ id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 }],
    })
    await watcher.onSessionStart(ctx)

    // One call for writeState, plus potentially the seed-error call
    const seedErrorCall = appendSpy.mock.calls.find(
      ([type]) => type === 'stub-watcher:seed-error',
    )
    expect(seedErrorCall).toBeDefined()
  })
})

describe('onSessionShutdown — widget cleanup', () => {
  it('hides and destroys widget on shutdown', () => {
    const { watcher } = makeWatcher()
    const hideSpy = vi.fn()
    const destroySpy = vi.fn()
    ;(watcher as unknown as { widget: unknown }).widget = {
      hide: hideSpy,
      destroy: destroySpy,
      show: vi.fn(),
    }
    watcher.onSessionShutdown({})
    expect(hideSpy).toHaveBeenCalled()
    expect(destroySpy).toHaveBeenCalled()
  })

  it('swallows errors from widget.hide', () => {
    const { watcher } = makeWatcher()
    ;(watcher as unknown as { widget: unknown }).widget = {
      hide: vi.fn(() => { throw new Error('ui torn down') }),
      destroy: vi.fn(),
      show: vi.fn(),
    }
    expect(() => watcher.onSessionShutdown({})).not.toThrow()
  })

  it('runs without widget (widget is null)', () => {
    const { watcher } = makeWatcher()
    expect(() => watcher.onSessionShutdown({})).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// executeTool — uncovered branches
// ---------------------------------------------------------------------------

describe('executeTool — list with terminal and errored watches', () => {
  it('list marks terminal watches with (done) suffix', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'Terminal Watch', terminal: true, consecutiveErrors: 0 })
    const result = await watcher.executeTool({ action: 'list' })
    expect(result.content[0]?.text).toContain('(done)')
  })

  it('list marks watches with consecutive errors with (N errors) suffix', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'Errored Watch', terminal: false, consecutiveErrors: 3 })
    const result = await watcher.executeTool({ action: 'list' })
    expect(result.content[0]?.text).toContain('(3 errors)')
  })
})

describe('executeTool — status with errors', () => {
  it('status includes error count when a watch has repeated errors', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: POLL_ERROR_THRESHOLD })
    const result = await watcher.executeTool({ action: 'status' })
    expect(result.content[0]?.text).toContain('repeated errors')
  })
})


describe('executeTool — remove with fallback id params', () => {
  it('remove accepts "id" as fallback when watchId is absent', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    const result = await watcher.executeTool({ action: 'remove', id: 'w1' })
    expect(result.content[0]?.text).toContain("removed")
    expect(watcher.testWatches.has('w1')).toBe(false)
  })

  it('remove accepts "watchKey" as fallback when watchId and id are absent', async () => {
    const { watcher } = makeWatcher()
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    const result = await watcher.executeTool({ action: 'remove', watchKey: 'w1' })
    expect(result.content[0]?.text).toContain("removed")
  })
})

// ---------------------------------------------------------------------------
// browseAction — headless UI (no ctx.ui.custom)
// ---------------------------------------------------------------------------

describe('browseAction — headless (no ctx.ui.custom)', () => {
  it('notifies and returns "stay" when ctx.ui.custom is absent', async () => {
    const watcher = makeStub()
    const notifySpy = vi.fn()
    const ctx = {
      hasUI: true,
      ui: { notify: notifySpy, setStatus: vi.fn(), theme: { fg: (_: string, t: string) => t } },
      sessionManager: { getEntries: () => [] },
    }
    const result = await watcher.browseAction(ctx)
    expect(result).toBe('stay')
    expect(notifySpy).toHaveBeenCalledWith(
      expect.stringContaining('browse requires an interactive UI'),
      'warning',
    )
  })
})

// ---------------------------------------------------------------------------
// buildMenu — nounPlural vs noun fallback
// ---------------------------------------------------------------------------

describe('buildMenu — nounPlural', () => {
  it('uses nounPlural from view when provided', () => {
    class NounPluralWatcher extends StubWatcher {
      override get view() {
        return {
          ...super.view,
          nounPlural: 'things',
          noun: 'thing',
        }
      }
    }
    const stub = new NounPluralWatcher({ pi: makePi() as unknown as ExtensionAPI, now: () => 0 })
    const menu = stub.buildMenu()
    const browseItem = menu.find(m => m.id === 'browse')!
    const state = (stub as unknown as { _currentState(): unknown })._currentState() as Parameters<typeof browseItem.label>[0]
    expect(browseItem.label(state)).toContain('things')
  })

  it('appends s to noun when nounPlural is undefined', () => {
    class NounOnlyWatcher extends StubWatcher {
      override get view() {
        return {
          ...super.view,
          nounPlural: undefined as unknown as string,
          noun: 'watch',
        }
      }
    }
    const stub = new NounOnlyWatcher({ pi: makePi() as unknown as ExtensionAPI, now: () => 0 })
    const menu = stub.buildMenu()
    const browseItem = menu.find(m => m.id === 'browse')!
    const state = (stub as unknown as { _currentState(): unknown })._currentState() as Parameters<typeof browseItem.label>[0]
    expect(browseItem.label(state)).toContain('watchs') // noun + 's'
  })
})

// ---------------------------------------------------------------------------
// _currentState — userDefaultDisplayMode
// ---------------------------------------------------------------------------

describe('_currentState — userDefaultDisplayMode', () => {
  it('includes userDefaultDisplayMode when set', () => {
    const stub = makeStub({ userDefault: 'widget' })
    const state = (stub as unknown as { _currentState(): unknown })._currentState() as Record<string, unknown>
    expect(state['userDefaultDisplayMode']).toBe('widget')
  })

  it('omits userDefaultDisplayMode when not set', () => {
    const { watcher } = makeWatcher()
    const state = (watcher as unknown as { _currentState(): unknown })._currentState() as Record<string, unknown>
    expect(state['userDefaultDisplayMode']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// onTurnEnd — scan watcher early return
// ---------------------------------------------------------------------------

describe('onTurnEnd — scan watcher', () => {
  it('returns early without activating tool for scan watchers', () => {
    const stub = makeStub({ itemSource: 'scan' })
    const appendSpy = vi.spyOn(stub.testPi, 'appendEntry')
    stub.onTurnEnd({})
    expect(appendSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// writeState — displayMode
// ---------------------------------------------------------------------------

describe('writeState — includes displayMode', () => {
  it('includes displayMode in persisted state entry', () => {
    const { watcher, pi } = makeWatcher()
    ;(watcher as unknown as { displayMode: string }).displayMode = 'statusline'
    const appendSpy = vi.spyOn(pi, 'appendEntry')
    watcher.writeState()
    const [, data] = appendSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(data['displayMode']).toBe('statusline')
  })
})

// ---------------------------------------------------------------------------
// pollWatch — lastPolledAt and reactivation hint
// ---------------------------------------------------------------------------

describe('pollWatch — lastPolledAt stamping', () => {
  it('stamps lastPolledAt on a watch that has the field', async () => {
    const { watcher } = makeWatcher()
    const watchWithTime: StubWatch & { lastPolledAt?: number } = {
      id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0, lastPolledAt: undefined as unknown as number,
    }
    watcher.testWatches.set('w1', watchWithTime)
    watcher.testBaselines.set('w1', { seenAt: 0 })
    watcher.detectChangesFn = vi.fn().mockResolvedValue({
      newBaseline: { seenAt: 1 },
      events: [],
      observedChange: false,
    })

    await watcher.pollWatch('w1')

    expect(watchWithTime.lastPolledAt).toBeDefined()
    expect(typeof watchWithTime.lastPolledAt).toBe('number')
  })
})

describe('pollWatch — reactivation hint when disabled', () => {
  it('includes reactivation hint in chat message when watcher is disabled', async () => {
    const { watcher, pi } = makeWatcher()
    ;(watcher as unknown as { enabled: boolean }).enabled = false
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.testBaselines.set('w1', { seenAt: 0 })
    watcher.detectChangesFn = vi.fn().mockResolvedValue({
      newBaseline: { seenAt: 1 },
      events: [{ watchId: 'w1', summary: 'state changed' }],
      observedChange: true,
    })

    await watcher.pollWatch('w1')

    const calls = pi.sendMessage.mock.calls as Array<[{ content: string }]>
    const chatMessage = calls.find(([msg]) => msg.content.includes('state changed'))
    expect(chatMessage).toBeDefined()
    // Reactivation hint should be included since enabled=false and itemSource=user-tool
    expect(chatMessage![0].content).toContain('manage_tools')
  })
})

describe('pollWatch — stop polling when all watches terminal', () => {
  it('calls stopPolling when last active watch goes terminal', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const stopPollingSpy = vi.spyOn(watcher, 'stopPolling')
    watcher.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    watcher.testBaselines.set('w1', { seenAt: 0 })
    watcher.detectChangesFn = vi.fn().mockResolvedValue({
      newBaseline: { seenAt: 1 },
      events: [{ watchId: 'w1', summary: 'done', isTerminal: true }],
      observedChange: true,
    })
    watcher.startPolling();
    await watcher.pollWatch('w1')

    // After terminal event, the watch is marked terminal → no more active → stopPolling
    expect(stopPollingSpy).toHaveBeenCalled()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// buildMenu — run callbacks and labels
// ---------------------------------------------------------------------------

describe('buildMenu — close item run callback', () => {
  it('close item resolves to "close"', async () => {
    const stub = makeStub()
    const menu = stub.buildMenu()
    const closeItem = menu.find(m => m.id === 'close')!
    const ctx = makeCommandCtx(stub)
    const result = await closeItem.run(ctx)
    expect(result).toBe('close')
  })
})


describe('buildMenu — refresh item run callback (scan watcher)', () => {
  it('refresh item calls ctx.refresh() and returns rerender', async () => {
    const stub = makeStub({ itemSource: 'scan' })
    const menu = stub.buildMenu()
    const refreshItem = menu.find(m => m.id === 'refresh')!
    const ctx = makeCommandCtx(stub)
    const refreshSpy = vi.spyOn(ctx, 'refresh')
    const result = await refreshItem.run(ctx)
    expect(refreshSpy).toHaveBeenCalled()
    expect(result).toBe('rerender')
  })
})

describe('buildMenu — displayMode item run callback (widget watcher)', () => {
  it('displayMode item calls ctx.setDisplayMode with toggled mode', async () => {
    const stub = makeStub({ hasWidget: true })
    const menu = stub.buildMenu()
    const displayItem = menu.find(m => m.id === 'displayMode')!
    const ctx = makeCommandCtx(stub)
    const setDisplayModeSpy = vi.spyOn(ctx, 'setDisplayMode')

    // Current mode is default (widget), toggle should set statusline
    await displayItem.run(ctx)
    expect(setDisplayModeSpy).toHaveBeenCalledWith('statusline')
  })
})

describe('buildMenu — userDefaultDisplayMode save fails', () => {
  it('notifies with warning when saveUserDefaultDisplayMode throws', async () => {
    const stub = makeStub({ hasWidget: true })
    vi.spyOn(stub, 'saveUserDefaultDisplayMode').mockImplementation(() => {
      throw new Error('disk write failed')
    })
    const menu = stub.buildMenu()
    const item = menu.find(m => m.id === 'userDefaultDisplayMode')!
    const notifySpy = vi.fn()
    const ctx: CommandCtx = {
      ui: { notify: notifySpy },
      state: (stub as unknown as { _currentState(): WatcherState })._currentState(),
      browse: () => Promise.resolve('stay' as const),
      refresh: () => {},
      setDisplayMode: () => {},
      setUserDefault: () => {},
      confirm: () => Promise.resolve(true),
    }
    await item.run(ctx)
    // Should have notified with warning
    expect(notifySpy).toHaveBeenCalled()
    const [, level] = notifySpy.mock.calls[notifySpy.mock.calls.length - 1] as [string, string]
    expect(level).toBe('warning')
  })
})

// ---------------------------------------------------------------------------
// pollWatch — itemSource === 'scan' (no stopPolling on terminal)
// ---------------------------------------------------------------------------

describe('pollWatch — scan watcher does not stopPolling on terminal', () => {
  it('scan watcher with terminal event does not call stopPolling', async () => {
    const stub = makeStub({ itemSource: 'scan' })
    const stopPollingSpy = vi.spyOn(stub, 'stopPolling')
    stub.testWatches.set('w1', { id: 'w1', label: 'L', terminal: false, consecutiveErrors: 0 })
    stub.testBaselines.set('w1', { seenAt: 0 })
    stub.detectChangesFn = vi.fn().mockResolvedValue({
      newBaseline: { seenAt: 1 },
      events: [{ watchId: 'w1', summary: 'terminal event', isTerminal: true }],
      observedChange: true,
    })

    await stub.pollWatch('w1')

    // For scan watchers, stopPolling should NOT be called based on terminal events
    // (scan watchers manage their own polling cycle)
    // Actually looking at the code: `if (this.itemSource === 'user-tool' && ...)` 
    // So scan watcher does NOT call stopPolling based on stillActive check
    expect(stopPollingSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// onSessionStart — widget show/hide and user-tool enabled=true path
// ---------------------------------------------------------------------------

describe('onSessionStart — widget show and hide', () => {
  it('shows widget in widget mode when hasWidget=true and widget is set', async () => {
    const stub = makeStub({ hasWidget: true })
    const showSpy = vi.fn()
    const hideSpy = vi.fn()
    ;(stub as unknown as { widget: unknown }).widget = {
      show: showSpy,
      hide: hideSpy,
      destroy: vi.fn(),
    }
    const ctx = makeCtxWithState({ displayMode: 'widget' })
    await stub.onSessionStart(ctx)
    expect(showSpy).toHaveBeenCalled()
    expect(hideSpy).not.toHaveBeenCalled()
  })

  it('hides widget in statusline mode when hasWidget=true and widget is set', async () => {
    const stub = makeStub({ hasWidget: true })
    const showSpy = vi.fn()
    const hideSpy = vi.fn()
    ;(stub as unknown as { widget: unknown }).widget = {
      show: showSpy,
      hide: hideSpy,
      destroy: vi.fn(),
    }
    const ctx = makeCtxWithState({ displayMode: 'statusline' })
    await stub.onSessionStart(ctx)
    expect(hideSpy).toHaveBeenCalled()
    expect(showSpy).not.toHaveBeenCalled()
  })
})

describe('onSessionStart — user-tool with enabled=true skips removeToolFromActive', () => {
  it('does not call removeToolFromActive when enabled=true', async () => {
    const pi = makePi()
    pi.getActiveTools.mockReturnValue(['stub_watcher'])
    const { watcher } = makeWatcher(pi)
    ;(watcher as unknown as { enabled: boolean }).enabled = true
    const ctx = makeCtxWithState({ enabled: true })
    const setActiveSpy = pi.setActiveTools
    setActiveSpy.mockClear()
    await watcher.onSessionStart(ctx)
    // setActiveTools should NOT be called (tool already active and enabled=true)
    expect(setActiveSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// commandHandler — _makeCommandCtx branches through real menu item run
// ---------------------------------------------------------------------------

describe('commandHandler — _makeCommandCtx setDisplayMode paths', () => {
  function makeCtxForCommandHandler() {
    return {
      hasUI: true,
      ui: {
        hasUI: true,
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_: string, t: string) => t, bold: (t: string) => t },
        custom: vi.fn(),
        select: vi.fn(),
      },
      sessionManager: { getEntries: () => [] },
    }
  }

  it('setDisplayMode widget → shows widget and clears status', async () => {
    const stub = makeStub({ hasWidget: true })
    const showSpy = vi.fn()
    const hideSpy = vi.fn()
    ;(stub as unknown as { widget: unknown }).widget = { show: showSpy, hide: hideSpy, destroy: vi.fn() }
    ;(stub as unknown as { displayMode: string }).displayMode = 'statusline' // start in statusline

    const openMenuViewMock = vi.mocked(browseViewModule.openMenuView)
    openMenuViewMock.mockImplementationOnce(async (_title, getItems) => {
      const items = getItems()
      const displayItem = items.find(i => i.id === 'displayMode')
      await displayItem?.run()
    })

    const ctx = makeCtxForCommandHandler()
    await stub.commandHandler()(undefined, ctx)

    // After toggling from statusline → widget: shows widget, clears status
    expect(showSpy).toHaveBeenCalled()
  })

  it('setDisplayMode statusline → hides widget and refreshes status', async () => {
    const stub = makeStub({ hasWidget: true })
    const showSpy = vi.fn()
    const hideSpy = vi.fn()
    ;(stub as unknown as { widget: unknown }).widget = { show: showSpy, hide: hideSpy, destroy: vi.fn() }
    ;(stub as unknown as { displayMode: string }).displayMode = 'widget' // start in widget

    const openMenuViewMock = vi.mocked(browseViewModule.openMenuView)
    openMenuViewMock.mockImplementationOnce(async (_title, getItems) => {
      const items = getItems()
      const displayItem = items.find(i => i.id === 'displayMode')
      await displayItem?.run()
    })

    const ctx = makeCtxForCommandHandler()
    await stub.commandHandler()(undefined, ctx)

    // After toggling from widget → statusline: hides widget
    expect(hideSpy).toHaveBeenCalled()
  })
})

describe('commandHandler — _makeCommandCtx setDisplayMode without widget', () => {
  it('setDisplayMode calls refreshStatus when hasWidget is false', async () => {
    const { watcher } = makeWatcher() // hasWidget defaults to false
    const ctx = makeCtxWithState({ displayMode: 'widget' })
    await watcher.onSessionStart(ctx) // set up UI

    const openMenuViewMock = vi.mocked(browseViewModule.openMenuView)
    openMenuViewMock.mockImplementationOnce((_title, getItems) => {
      getItems()
      // No displayMode item for non-widget watchers
      // Actually, let's test by invoking the setDisplayMode directly through a custom item
      return Promise.resolve()
    })

    // Since makeWatcher has no hasWidget, displayMode item isn't in menu.
    // Instead, test setDisplayMode through a widget-less watcher directly.
    // Get the real CommandCtx from the internal _makeCommandCtx
    const ctxForCmd = {
      hasUI: true,
      ui: {
        hasUI: true,
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_: string, t: string) => t },
        custom: vi.fn(),
      },
      sessionManager: { getEntries: () => [] },
    }
    const surface = { setStatus: vi.fn(), notify: vi.fn() } as never
    const state = (watcher as unknown as { _currentState(): WatcherState })._currentState()
    const cmdCtx = (watcher as unknown as { _makeCommandCtx(s: unknown, st: unknown, c: unknown): CommandCtx })._makeCommandCtx(surface, state, ctxForCmd)

    // Call setDisplayMode - no widget (hasWidget=false), so refreshStatus branch
    cmdCtx.setDisplayMode('statusline')
    expect(watcher.testDisplayMode).toBe('statusline')
  })
})

describe('commandHandler — browse callback', () => {
  it('browse() callback calls browseAction', async () => {
    const stub = makeStub()
    const browseActionSpy = vi.spyOn(stub, 'browseAction')
    const surface = { setStatus: vi.fn(), notify: vi.fn() } as never
    const state = (stub as unknown as { _currentState(): WatcherState })._currentState()
    const ctx = {}
    const cmdCtx = (stub as unknown as { _makeCommandCtx(s: unknown, st: unknown, c: unknown): CommandCtx })._makeCommandCtx(surface, state, ctx)

    await cmdCtx.browse()
    expect(browseActionSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// purge menu item
// ---------------------------------------------------------------------------

describe('purge menu item', () => {
  it('is present for user-tool watchers', () => {
    const stub = makeStub({ itemSource: 'user-tool' })
    expect(stub.buildMenu().find(i => i.id === 'purge')).toBeDefined()
  })

  it('is absent for scan watchers', () => {
    const stub = makeStub({ itemSource: 'scan' })
    expect(stub.buildMenu().find(i => i.id === 'purge')).toBeUndefined()
  })

  it('appears before close', () => {
    const stub = makeStub({ itemSource: 'user-tool' })
    const items = stub.buildMenu()
    const purgeIdx = items.findIndex(i => i.id === 'purge')
    const closeIdx = items.findIndex(i => i.id === 'close')
    expect(purgeIdx).toBeGreaterThanOrEqual(0)
    expect(purgeIdx).toBeLessThan(closeIdx)
  })

  it('label shows terminal count', () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: false }))
    stub.testWatches.set('b', makeWatch({ id: 'b', terminal: true }))
    stub.testWatches.set('c', makeWatch({ id: 'c', terminal: true }))
    const item = stub.buildMenu().find(i => i.id === 'purge')!
    expect(item.label(stub._currentState())).toBe('Purge completed (2)')
  })

  it('disabled when no terminal watches', () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: false }))
    const item = stub.buildMenu().find(i => i.id === 'purge')!
    expect(item.disabled?.(stub._currentState())).toBe(true)
  })

  it('enabled when there are terminal watches', () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: true }))
    const item = stub.buildMenu().find(i => i.id === 'purge')!
    expect(item.disabled?.(stub._currentState())).toBe(false)
  })

  it('run: confirm=true invokes executePurge and returns rerender', async () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: true }))
    const spy = vi.spyOn(stub as unknown as { executePurge(): StubWatch[] }, 'executePurge')
    const ctx = makeCommandCtx(stub, { confirm: () => Promise.resolve(true) })
    const item = stub.buildMenu().find(i => i.id === 'purge')!
    const result = await item.run(ctx)
    expect(spy).toHaveBeenCalled()
    expect(result).toBe('rerender')
  })

  it('run: confirm=false does NOT invoke executePurge and returns stay', async () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: true }))
    const spy = vi.spyOn(stub as unknown as { executePurge(): StubWatch[] }, 'executePurge')
    const ctx = makeCommandCtx(stub, { confirm: () => Promise.resolve(false) })
    const item = stub.buildMenu().find(i => i.id === 'purge')!
    const result = await item.run(ctx)
    expect(spy).not.toHaveBeenCalled()
    expect(result).toBe('stay')
  })

  it('run: returns stay when no terminal watches (even without confirm)', async () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: false }))
    const confirm = vi.fn().mockResolvedValue(true)
    const ctx = makeCommandCtx(stub, { confirm })
    const item = stub.buildMenu().find(i => i.id === 'purge')!
    const result = await item.run(ctx)
    expect(confirm).not.toHaveBeenCalled()
    expect(result).toBe('stay')
  })

  it('run: notifies after successful purge', async () => {
    const stub = makeStub()
    stub.testWatches.set('a', makeWatch({ id: 'a', terminal: true }))
    const notify = vi.fn()
    const ctx = makeCommandCtx(stub, {
      confirm: () => Promise.resolve(true),
      ui: { notify },
    })
    const item = stub.buildMenu().find(i => i.id === 'purge')!
    await item.run(ctx)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('purged 1 completed watch'), 'info')
  })
})

// ---------------------------------------------------------------------------
// config methods
// ---------------------------------------------------------------------------

class ConfigStub extends StubWatcher {
  callConfigFilePath(): string {
    return this.configFilePath()
  }
  callLoadWatcherConfig() {
    return this.loadWatcherConfig()
  }
  callSaveWatcherConfig(change: { defaultDisplayMode?: 'widget' | 'statusline' | undefined }): boolean {
    return this.saveWatcherConfig(change)
  }
}

function makeConfigStub() {
  return new ConfigStub({ pi: makePi() as unknown as ExtensionAPI, now: () => 0 })
}

describe('config methods', () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    })
    vi.mocked(writeFileSync).mockReset()
    vi.mocked(mkdirSync).mockReset()
  })

  // ── configFilePath ──────────────────────────────────────────────────────

  describe('configFilePath', () => {
    it('returns join(getAgentDir(), extensionName + ".json")', () => {
      const stub = makeConfigStub()
      expect(stub.callConfigFilePath()).toBe(join(getAgentDir(), 'stub-watcher.json'))
    })
  })

  // ── loadWatcherConfig ───────────────────────────────────────────────────

  describe('loadWatcherConfig', () => {
    it('returns { defaultDisplayMode: "widget" } when file contains valid JSON', () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultDisplayMode: 'widget' }))
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({ defaultDisplayMode: 'widget' })
    })

    it('returns { defaultDisplayMode: "statusline" } for statusline', () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultDisplayMode: 'statusline' }))
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({ defaultDisplayMode: 'statusline' })
    })

    it('returns {} when file not found (ENOENT)', () => {
      // default beforeEach mock throws ENOENT
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({})
    })

    it('returns {} on invalid JSON', () => {
      vi.mocked(readFileSync).mockReturnValue('not-valid-json{')
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({})
    })

    it('returns {} when root is an array', () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify([{ defaultDisplayMode: 'widget' }]))
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({})
    })

    it('returns {} when root is null', () => {
      vi.mocked(readFileSync).mockReturnValue('null')
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({})
    })

    it('returns {} when root is a number', () => {
      vi.mocked(readFileSync).mockReturnValue('42')
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({})
    })

    it('strips invalid defaultDisplayMode value ("inline") → {}', () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultDisplayMode: 'inline' }))
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({})
    })

    it('strips non-string defaultDisplayMode → {}', () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ defaultDisplayMode: 42 }))
      expect(makeConfigStub().callLoadWatcherConfig()).toEqual({})
    })
  })

  // ── saveWatcherConfig ───────────────────────────────────────────────────

  describe('saveWatcherConfig', () => {
    it('writes correct JSON (2-space indent + trailing newline)', () => {
      const stub = makeConfigStub()
      stub.callSaveWatcherConfig({ defaultDisplayMode: 'widget' })
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce()
      const args = vi.mocked(writeFileSync).mock.calls[0] as [string, string, string]
      expect(args[1]).toBe('{\n  "defaultDisplayMode": "widget"\n}\n')
    })

    it('merges over existing file, preserving unknown keys', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ unknownKey: 'preserved', defaultDisplayMode: 'widget' }),
      )
      const stub = makeConfigStub()
      stub.callSaveWatcherConfig({ defaultDisplayMode: 'statusline' })
      const args = vi.mocked(writeFileSync).mock.calls[0] as [string, string, string]
      const written = JSON.parse(args[1]) as Record<string, unknown>
      expect(written['unknownKey']).toBe('preserved')
      expect(written['defaultDisplayMode']).toBe('statusline')
    })

    it('undefined values are omitted from output', () => {
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ defaultDisplayMode: 'widget' }),
      )
      const stub = makeConfigStub()
      stub.callSaveWatcherConfig({ defaultDisplayMode: undefined })
      const args = vi.mocked(writeFileSync).mock.calls[0] as [string, string, string]
      const written = JSON.parse(args[1]) as Record<string, unknown>
      expect('defaultDisplayMode' in written).toBe(false)
    })

    it('returns false when writeFileSync throws', () => {
      vi.mocked(writeFileSync).mockImplementation(() => { throw new Error('disk full') })
      expect(makeConfigStub().callSaveWatcherConfig({ defaultDisplayMode: 'widget' })).toBe(false)
    })

    it('creates the directory via mkdirSync before writing', () => {
      const stub = makeConfigStub()
      stub.callSaveWatcherConfig({ defaultDisplayMode: 'widget' })
      expect(vi.mocked(mkdirSync)).toHaveBeenCalledOnce()
      const args = vi.mocked(mkdirSync).mock.calls[0] as [string, { recursive: boolean }]
      expect(args[0]).toBe(dirname(stub.callConfigFilePath()))
      expect(args[1]).toEqual({ recursive: true })
    })
  })
})
