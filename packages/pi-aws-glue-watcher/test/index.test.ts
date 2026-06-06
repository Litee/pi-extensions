import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { initTheme } from '@earendil-works/pi-coding-agent'
import type { JobRunResponse, WorkflowRunResponse } from '../src/glue-client.js'
import type { GlueClient } from '../src/glue-client.js'
import { createExtensionWithClient } from '../src/index.js'

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(() => true),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePi(opts: {
  handlers?: { sessionStart?: (e: unknown, c: unknown) => Promise<void> | void }
} = {}) {
  const handlers = opts.handlers ?? {}
  return {
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    registerTool: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (e: unknown, c: unknown) => Promise<void> | void) => {
      if (event === 'session_start') handlers.sessionStart = handler
    }),
    events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
    _handlers: handlers,
  }
}

function makeClient(): GlueClient {
  return {
    getJobRun: vi.fn().mockResolvedValue({
      JobRun: { JobRunState: 'RUNNING', ErrorMessage: '' },
    } satisfies JobRunResponse),
    getWorkflowRun: vi.fn().mockResolvedValue({
      Run: {
        Status: 'RUNNING',
        Statistics: { TotalActions: 2, SucceededActions: 0, FailedActions: 0, RunningActions: 2 },
        Graph: { Nodes: [] },
      },
    } satisfies WorkflowRunResponse),
    getLatestJobRunId: vi.fn().mockResolvedValue('jr_latest123'),
    getLatestWorkflowRunId: vi.fn().mockResolvedValue('wr_latest456'),
    stopJobRun: vi.fn().mockResolvedValue(undefined),
    stopWorkflowRun: vi.fn().mockResolvedValue(undefined),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Session resume: widget + polling restored from persisted watches
// ---------------------------------------------------------------------------

describe('session resume: widget + polling restored from persisted watches', () => {
  function makeCtxWithWidget(setWidget: ReturnType<typeof vi.fn>) {
    return {
      hasUI: true,
      ui: { hasUI: true, setWidget, setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
      sessionManager: { getEntries: () => [] },
    }
  }

  function persistedWithWatches(enabled: boolean) {
    return [
      {
        type: 'custom',
        customType: 'pi-aws-glue-watcher:state',
        data: {
          savedAt: 1,
          enabled,
          displayMode: 'widget',
          watches: [
            {
              watchId: 'w1',
              type: 'job',
              name: 'etl',
              runId: 'jr_123',
              profile: 'p',
              baseline: { state: 'RUNNING', errorMessage: '' },
              addedAt: 0,
              terminal: false,
              consecutiveErrors: 0,
            },
          ],
          baselines: {},
        },
      },
    ]
  }

  it('restores widget when enabled=true is persisted', async () => {
    const pi = makePi()
    const setWidget = vi.fn()
    createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient())
    await pi._handlers.sessionStart!({}, {
      ...makeCtxWithWidget(setWidget),
      sessionManager: { getEntries: () => persistedWithWatches(true) },
    })
    const widgetCalls = setWidget.mock.calls.filter(
      (c) => c[0] === 'glue-watcher' && c[1] !== undefined,
    )
    expect(widgetCalls.length).toBeGreaterThan(0)
  })

  it('restores widget when enabled=false but active non-terminal watches exist (crash-recovery path)', async () => {
    const pi = makePi()
    const setWidget = vi.fn()
    createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient())
    await pi._handlers.sessionStart!({}, {
      ...makeCtxWithWidget(setWidget),
      sessionManager: { getEntries: () => persistedWithWatches(false) },
    })
    const widgetCalls = setWidget.mock.calls.filter(
      (c) => c[0] === 'glue-watcher' && c[1] !== undefined,
    )
    expect(widgetCalls.length).toBeGreaterThan(0)
  })

  it('does NOT restore widget when there are no active watches', async () => {
    const pi = makePi()
    const setWidget = vi.fn()
    createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient())
    await pi._handlers.sessionStart!({}, makeCtxWithWidget(setWidget))
    const widgetCalls = setWidget.mock.calls.filter(
      (c) => c[0] === 'glue-watcher' && c[1] !== undefined,
    )
    expect(widgetCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Startup chat message: triggerTurn + label
// ---------------------------------------------------------------------------

describe('startup chat message: triggerTurn + label', () => {
  beforeEach(() => {
    initTheme(undefined)
  })

  it('does NOT send a startup chat message when resuming with active watches', async () => {
    const pi = makePi()
    const client = makeClient()
    createExtensionWithClient(pi as unknown as ExtensionAPI, client)
    const persistedData = {
      savedAt: 1,
      enabled: true,
      displayMode: 'widget' as const,
      watches: [
        {
          watchId: 'w1',
          type: 'job' as const,
          name: 'etl',
          runId: 'jr_123',
          profile: 'p',
          region: undefined,
          baseline: { state: 'RUNNING', errorMessage: '' },
          addedAt: 0,
          lastPolledAt: undefined,
          terminal: false,
          consecutiveErrors: 0,
        },
      ],
      baselines: {},
    }
    await pi._handlers.sessionStart!({}, {
      hasUI: true,
      ui: { hasUI: true },
      sessionManager: {
        getEntries: () => [
          { type: 'custom', customType: 'pi-aws-glue-watcher:state', data: persistedData },
        ],
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    const startupCall = pi.sendMessage.mock.calls.find(
      (c) => (c[0] as { customType?: string }).customType === 'pi-aws-glue-watcher',
    )
    expect(startupCall).toBeUndefined()
  })

  it('renderer: collapsed (default) shows primary lines + expand hint, no sub-fields', () => {
    const pi = makePi()
    createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient())
    // The override renderer is the last registered call
    const calls = pi.registerMessageRenderer.mock.calls
    const [, renderer] = calls[calls.length - 1] as [
      string,
      (m: unknown, o: unknown, t: unknown) => { render?: (w: number) => string[] },
    ]
    const fakeTheme = {
      bold: (s: string) => s,
      fg: (_c: string, s: string) => s,
      bg: (_c: string, s: string) => s,
    }
    const watches = {
      w1: {
        watchId: 'w1',
        type: 'job' as const,
        name: 'etl',
        runId: 'jr_123',
        profile: 'p',
        region: undefined,
        baseline: { state: 'RUNNING', errorMessage: '' },
        addedAt: 0,
        lastPolledAt: undefined,
        terminal: false,
        consecutiveErrors: 0,
      },
    }
    const msg = {
      content: [
        {
          type: 'text',
          text: '[10:00] active \u2014 watching 1 run:\n1. etl \u2014 state=RUNNING\n  \u2026 ctrl+o to expand',
        },
      ],
      details: { watches, date: new Date().toISOString() },
    }
    const box = renderer(msg, { expanded: false }, fakeTheme)
    const lines = box.render!(120)
    const joined = lines.join('\n')
    expect(joined).toContain('\u2026 ctrl+o to expand')
    expect(joined).not.toContain('\u00b7 run:')
    expect(joined).not.toContain('\u00b7 type:')
  })

  it('renderer: expanded shows sub-fields and no expand hint', () => {
    const pi = makePi()
    createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient())
    const calls = pi.registerMessageRenderer.mock.calls
    const [, renderer] = calls[calls.length - 1] as [
      string,
      (m: unknown, o: unknown, t: unknown) => { render?: (w: number) => string[] },
    ]
    const fakeTheme = {
      bold: (s: string) => s,
      fg: (_c: string, s: string) => s,
      bg: (_c: string, s: string) => s,
    }
    const watches = {
      w1: {
        watchId: 'w1',
        type: 'job' as const,
        name: 'etl',
        runId: 'jr_123',
        profile: 'p',
        region: undefined,
        baseline: { state: 'RUNNING', errorMessage: '' },
        addedAt: 0,
        lastPolledAt: undefined,
        terminal: false,
        consecutiveErrors: 0,
      },
    }
    const msg = {
      content: [
        {
          type: 'text',
          text: '[10:00] active \u2014 watching 1 run:\n1. etl \u2014 state=RUNNING\n  \u2026 ctrl+o to expand',
        },
      ],
      details: { watches, date: new Date().toISOString() },
    }
    const box = renderer(msg, { expanded: true }, fakeTheme)
    const lines = box.render!(120)
    const joined = lines.join('\n')
    expect(joined).toContain('\u00b7 run: jr_123')
    expect(joined).toContain('\u00b7 type: job')
    expect(joined).not.toContain('\u2026 ctrl+o to expand')
  })

  it('registers a message renderer with customType "pi-aws-glue-watcher"', () => {
    const pi = makePi()
    createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient())
    expect(pi.registerMessageRenderer).toHaveBeenCalled()
    const calls = pi.registerMessageRenderer.mock.calls as [string, unknown][]
    const entry = calls.find((c) => c[0] === 'pi-aws-glue-watcher')
    expect(entry).toBeDefined()
  })

  it('registers /glue-watcher command with menu-style description', () => {
    const pi = makePi()
    createExtensionWithClient(pi as unknown as ExtensionAPI, makeClient())
    expect(pi.registerCommand).toHaveBeenCalled()
    const calls = pi.registerCommand.mock.calls as unknown as [string, { description: string }][]
    const entry = calls.find((c) => c[0] === 'glue-watcher')
    expect(entry).toBeDefined()
    const description = entry![1].description
    expect(description).toMatch(/menu/i)
    expect(description).not.toMatch(/\bstatus\b/)
    expect(description).not.toMatch(/\bbrowse\b/)
    expect(description).not.toMatch(/\bsettings\b/)
    expect(description).not.toMatch(/\benable\b/)
    expect(description).not.toMatch(/\bdisable\b/)
  })
})
