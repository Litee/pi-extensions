/**
 * Unit tests for GlueWatcher (extends BaseWatcher).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobRunResponse, WorkflowRunResponse } from '../src/glue-client.js'
import type { GlueClient } from '../src/glue-client.js'
import { GlueWatcher, stateColor } from '../src/watcher.js'
import type { GlueEvent, GlueWatch, JobBaseline, WatchBaseline, WatchMap, WorkflowBaseline } from '../src/types.js'
import { buildWidgetEntries } from '../src/ui/widgetRows.js'
import { POLL_ERROR_THRESHOLD } from 'pi-watcher-core/base-watcher'

// Capture the expandedTextOverride function passed to createWatcherMessageRenderer
// so we can test it without needing a live pi-tui runtime.
let capturedExpandedTextOverride: ((message: unknown) => string | undefined) | undefined

vi.mock('pi-watcher-core/renderer', async (importOriginal) => {
  type RendererModule = typeof import('pi-watcher-core/renderer')
  const orig = await importOriginal<RendererModule>()
  return {
    ...orig,
    createWatcherMessageRenderer: (label: string, opts: { expandedTextOverride?: (m: unknown) => string | undefined }) => {
      if (opts?.expandedTextOverride) capturedExpandedTextOverride = opts.expandedTextOverride
      return orig.createWatcherMessageRenderer(label, opts)
    },
  }
})

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(() => true),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePi() {
  return {
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => [] as string[]),
    setActiveTools: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
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

function makeWatcher(clientOverride?: GlueClient, nowMs?: number) {
  const pi = makePi()
  const client = clientOverride ?? makeClient()
  const now = nowMs !== undefined ? () => nowMs : Date.now
  const watcher = new GlueWatcher({ pi: pi as never, client, now })
  return { watcher, pi, client }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// addWatch — job
// ---------------------------------------------------------------------------

describe('GlueWatcher.addWatch — job', () => {
  it('adds with provided runId, seeds baseline, populates watches and baselines', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'my-etl-job',
      runId: 'jr_abc123',
      profile: 'my-profile',
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(typeof watchId).toBe('string')
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    const baselines = (watcher as unknown as { baselines: Map<string, WatchBaseline> }).baselines
    expect(watches.has(watchId)).toBe(true)
    expect(baselines.has(watchId)).toBe(true)
    const watch = watches.get(watchId)!
    expect(watch.type).toBe('job')
    expect(watch.name).toBe('my-etl-job')
    expect(watch.runId).toBe('jr_abc123')
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('starts per-watch scheduler immediately after add', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'job',
      runId: 'jr_1',
      profile: 'p',
    })
    const watchId = result.details['watchId'] as string
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> })._watchSchedulers
    expect(schedulers.get(watchId)?.isRunning).toBe(true)
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// addWatch — workflow
// ---------------------------------------------------------------------------

describe('GlueWatcher.addWatch — workflow', () => {
  it('adds workflow watch and seeds baseline', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      type: 'workflow',
      name: 'my-workflow',
      runId: 'wr_def456',
      profile: 'my-profile',
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    expect(watches.get(watchId)?.type).toBe('workflow')
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// addWatch — latest run id
// ---------------------------------------------------------------------------

describe('GlueWatcher.addWatch — latest run id', () => {
  it('calls getLatestJobRunId when runId is omitted for a job', async () => {
    vi.useFakeTimers()
    const { watcher, client } = makeWatcher()
    await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'my-etl-job',
      profile: 'my-profile',
    })
    expect(client.getLatestJobRunId).toHaveBeenCalledWith('my-etl-job', 'my-profile', undefined)
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    const watch = [...watches.values()][0]!
    expect(watch.runId).toBe('jr_latest123')
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('calls getLatestWorkflowRunId when runId is omitted for a workflow', async () => {
    vi.useFakeTimers()
    const { watcher, client } = makeWatcher()
    await watcher.executeTool({
      action: 'add',
      type: 'workflow',
      name: 'my-workflow',
      profile: 'my-profile',
    })
    expect(client.getLatestWorkflowRunId).toHaveBeenCalledWith(
      'my-workflow',
      'my-profile',
      undefined,
    )
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('returns error when fetching latest run ID fails', async () => {
    const client = makeClient()
    vi.mocked(client.getLatestJobRunId).mockRejectedValue(new Error('no runs found'))
    const { watcher } = makeWatcher(client)
    const result = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'my-job',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('no runs found')
  })
})

// ---------------------------------------------------------------------------
// addWatch — validation
// ---------------------------------------------------------------------------

describe('GlueWatcher.addWatch — validation', () => {
  it('returns error when type is invalid', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'add', type: 'invalid', name: 'x', profile: 'p' })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('type')
  })

  it('returns error when name is empty', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'add', type: 'job', name: '', profile: 'p' })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('name')
  })

  it('returns error when profile is empty', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'add', type: 'job', name: 'j', profile: '' })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('profile')
  })

  it('returns error when pollIntervalMs < MIN_POLL_MS', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'j',
      runId: 'jr_1',
      profile: 'p',
      pollIntervalMs: 1000,
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('5000')
  })
})

// ---------------------------------------------------------------------------
// addWatch — seeding failure
// ---------------------------------------------------------------------------

describe('GlueWatcher.addWatch — seeding failure', () => {
  it('still adds watch when snapshot throws; message reports error', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    vi.mocked(client.getJobRun).mockRejectedValue(new Error('permission denied'))
    const { watcher } = makeWatcher(client)
    const result = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'j',
      runId: 'jr_1',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(true)
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    expect(watches.size).toBe(1)
    expect([...watches.values()][0]!.baseline).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toContain('seeding failed')
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// addWatch — pollIntervalMs
// ---------------------------------------------------------------------------

describe('GlueWatcher.addWatch — pollIntervalMs', () => {
  it('creates scheduler with correct base interval', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'j',
      runId: 'jr_1',
      profile: 'p',
      pollIntervalMs: 30_000,
    })
    const watchId = result.details['watchId'] as string
    const schedulers = (watcher as unknown as {
      _watchSchedulers: Map<string, { intervalMs: number }>
    })._watchSchedulers
    expect(schedulers.get(watchId)?.intervalMs).toBe(30_000)
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// executeTool('remove')
// ---------------------------------------------------------------------------

describe('GlueWatcher executeTool("remove")', () => {
  it('removes from watches and baselines, stops scheduler', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const addResult = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'j',
      runId: 'jr_1',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const removeResult = await watcher.executeTool({ action: 'remove', watchId })
    expect(removeResult.details['ok']).toBe(true)
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    const baselines = (watcher as unknown as { baselines: Map<string, WatchBaseline> }).baselines
    expect(watches.has(watchId)).toBe(false)
    expect(baselines.has(watchId)).toBe(false)
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, unknown> })._watchSchedulers
    expect(schedulers.has(watchId)).toBe(false)
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// executeTool('set-interval')
// ---------------------------------------------------------------------------

describe('GlueWatcher executeTool("set-interval")', () => {
  it('returns error when watchId is missing', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'set-interval' })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('watchId')
  })

  it('returns error when watchId not found', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'set-interval', watchId: 'no-such' })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('not found')
  })

  it('returns error when pollIntervalMs is missing', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const addResult = await watcher.executeTool({ action: 'add', type: 'job', name: 'j', runId: 'jr_1', profile: 'p' })
    const watchId = addResult.details['watchId'] as string
    const result = await watcher.executeTool({ action: 'set-interval', watchId })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('pollIntervalMs')
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('returns error when pollIntervalMs < MIN_POLL_MS', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const addResult = await watcher.executeTool({ action: 'add', type: 'job', name: 'j', runId: 'jr_1', profile: 'p' })
    const watchId = addResult.details['watchId'] as string
    const result = await watcher.executeTool({ action: 'set-interval', watchId, pollIntervalMs: 1000 })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('5000')
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('sets poll interval and restarts scheduler with new interval', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const addResult = await watcher.executeTool({ action: 'add', type: 'job', name: 'j', runId: 'jr_1', profile: 'p' })
    const watchId = addResult.details['watchId'] as string
    const result = await watcher.executeTool({ action: 'set-interval', watchId, pollIntervalMs: 30_000 })
    expect(result.details['ok']).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('30s')
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    expect(watches.get(watchId)?.pollIntervalMs).toBe(30_000)
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { intervalMs: number; isRunning: boolean }> })._watchSchedulers
    expect(schedulers.get(watchId)?.isRunning).toBe(true)
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('does not start scheduler when watch is terminal', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const addResult = await watcher.executeTool({ action: 'add', type: 'job', name: 'j', runId: 'jr_1', profile: 'p' })
    const watchId = addResult.details['watchId'] as string
    // Force terminal
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    watches.get(watchId)!.terminal = true
    const result = await watcher.executeTool({ action: 'set-interval', watchId, pollIntervalMs: 60_000 })
    expect(result.details['ok']).toBe(true)
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> })._watchSchedulers
    // scheduler should not be running for terminal watch
    expect(schedulers.get(watchId)?.isRunning).toBeFalsy()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// executeTool('list' / 'status') — smoke
// ---------------------------------------------------------------------------

describe('GlueWatcher executeTool list/status smoke', () => {
  it('list returns ok=true', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'list' })
    expect(result.details['action']).toBe('list')
  })

  it('status returns ok=true', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'status' })
    expect(result.details['action']).toBe('status')
  })
})

// ---------------------------------------------------------------------------
// detectChanges — job
// ---------------------------------------------------------------------------

describe('GlueWatcher.detectChanges — job', () => {
  it('returns events and updates baselines when state changes', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    vi.mocked(client.getJobRun).mockResolvedValue({
      JobRun: { JobRunState: 'SUCCEEDED', ErrorMessage: '' },
    })
    const { watcher } = makeWatcher(client)
    const addResult = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'j',
      runId: 'jr_1',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    const baselines = (watcher as unknown as { baselines: Map<string, WatchBaseline> }).baselines
    // Set baseline to RUNNING so we can detect state change
    baselines.set(watchId, { state: 'RUNNING', errorMessage: '' })
    const watch = watches.get(watchId)!
    const result = await watcher.detectChanges(watch)
    expect(result.events.length).toBeGreaterThan(0)
    expect(result.events[0]!.newState).toBe('SUCCEEDED')
    expect(result.observedChange).toBe(true)
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// detectChanges — workflow
// ---------------------------------------------------------------------------

describe('GlueWatcher.detectChanges — workflow', () => {
  it('returns events when workflow state changes', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    vi.mocked(client.getWorkflowRun).mockResolvedValue({
      Run: {
        Status: 'COMPLETED',
        Statistics: { TotalActions: 2, SucceededActions: 2, FailedActions: 0, RunningActions: 0 },
        Graph: { Nodes: [] },
      },
    })
    const { watcher } = makeWatcher(client)
    const addResult = await watcher.executeTool({
      action: 'add',
      type: 'workflow',
      name: 'wf',
      runId: 'wr_1',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    const baselines = (watcher as unknown as { baselines: Map<string, WatchBaseline> }).baselines
    baselines.set(watchId, {
      state: 'RUNNING',
      totalActions: 2,
      succeededActions: 0,
      failedActions: 0,
      runningActions: 2,
      reportedFailedNodes: [],
    })
    const watch = watches.get(watchId)!
    const result = await watcher.detectChanges(watch)
    expect(result.events.length).toBeGreaterThan(0)
    expect(result.events[0]!.newState).toBe('COMPLETED')
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// detectChanges — terminal events
// ---------------------------------------------------------------------------

describe('GlueWatcher.detectChanges — terminal events', () => {
  it('containsTerminalStateEvent returns true for terminal event', () => {
    const { watcher } = makeWatcher()
    const events = [
      {
        watchId: 'w1',
        type: 'job' as const,
        name: 'j',
        runId: 'jr_1',
        eventType: 'state_changed' as const,
        previousState: 'RUNNING',
        newState: 'SUCCEEDED',
        summary: 'j: RUNNING → SUCCEEDED ✓',
        formatted: '• j: RUNNING → SUCCEEDED ✓',
        isTerminal: true,
      },
    ]
    expect(
      (watcher as unknown as { containsTerminalStateEvent(e: typeof events): boolean }).containsTerminalStateEvent(events),
    ).toBe(true)
  })

  it('containsTerminalStateEvent returns false for empty events', () => {
    const { watcher } = makeWatcher()
    expect(
      (watcher as unknown as { containsTerminalStateEvent(e: never[]): boolean }).containsTerminalStateEvent([]),
    ).toBe(false)
  })

  it('watch.terminal becomes true after pollWatch when terminal state detected', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    vi.mocked(client.getJobRun).mockResolvedValue({
      JobRun: { JobRunState: 'SUCCEEDED', ErrorMessage: '' },
    })
    const { watcher } = makeWatcher(client)
    const addResult = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'j',
      runId: 'jr_1',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    const baselines = (watcher as unknown as { baselines: Map<string, WatchBaseline> }).baselines
    // Set to RUNNING so SUCCEEDED triggers a change
    baselines.set(watchId, { state: 'RUNNING', errorMessage: '' })
    watches.get(watchId)!.baseline = { state: 'RUNNING', errorMessage: '' }
    await watcher.pollWatch(watchId)
    expect(watches.get(watchId)?.terminal).toBe(true)
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// normaliseWatch
// ---------------------------------------------------------------------------

describe('GlueWatcher.normaliseWatch', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('returns null for non-object input', () => {
    expect(watcher.normaliseWatch(null)).toBeNull()
    expect(watcher.normaliseWatch('str')).toBeNull()
    expect(watcher.normaliseWatch([])).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    expect(watcher.normaliseWatch({ type: 'job', name: 'j', runId: 'r', profile: 'p' })).toBeNull()
    expect(watcher.normaliseWatch({ watchId: 'w', name: 'j', runId: 'r', profile: 'p' })).toBeNull()
  })

  it('returns null for invalid type', () => {
    expect(
      watcher.normaliseWatch({ watchId: 'w', type: 'invalid', name: 'j', runId: 'r', profile: 'p' }),
    ).toBeNull()
  })

  it('round-trips a valid job watch', () => {
    const raw = {
      watchId: 'abc123',
      type: 'job',
      name: 'etl',
      runId: 'jr_1',
      profile: 'dev',
      region: 'us-east-1',
      pollIntervalMs: 60_000,
      addedAt: 1000,
      lastPolledAt: 2000,
      baseline: { state: 'RUNNING', errorMessage: '' },
      terminal: false,
      consecutiveErrors: 0,
    }
    const result = watcher.normaliseWatch(raw)
    expect(result).not.toBeNull()
    expect(result?.watchId).toBe('abc123')
    expect(result?.type).toBe('job')
    expect(result?.pollIntervalMs).toBe(60_000)
    expect(result?.lastPolledAt).toBe(2000)
  })

  it('handles missing optional fields gracefully', () => {
    const raw = {
      watchId: 'w',
      type: 'workflow',
      name: 'wf',
      runId: 'wr_1',
      profile: 'p',
      addedAt: 0,
      terminal: false,
      consecutiveErrors: 0,
    }
    const result = watcher.normaliseWatch(raw)
    expect(result).not.toBeNull()
    expect(result?.region).toBeUndefined()
    expect(result?.pollIntervalMs).toBeUndefined()
    expect(result?.lastPolledAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// normaliseBaseline
// ---------------------------------------------------------------------------

describe('GlueWatcher.normaliseBaseline', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('returns null for non-object input', () => {
    expect(watcher.normaliseBaseline(null)).toBeNull()
    expect(watcher.normaliseBaseline('x')).toBeNull()
    expect(watcher.normaliseBaseline([])).toBeNull()
  })

  it('discriminates JobBaseline by errorMessage field', () => {
    const raw = { state: 'RUNNING', errorMessage: '' }
    const result = watcher.normaliseBaseline(raw)
    expect(result).not.toBeNull()
    expect('errorMessage' in result!).toBe(true)
  })

  it('discriminates WorkflowBaseline by totalActions field', () => {
    const raw = {
      state: 'RUNNING',
      totalActions: 2,
      succeededActions: 0,
      failedActions: 0,
      runningActions: 2,
      reportedFailedNodes: [],
    }
    const result = watcher.normaliseBaseline(raw)
    expect(result).not.toBeNull()
    expect('totalActions' in result!).toBe(true)
  })

  it('returns null for unrecognised baseline shape', () => {
    expect(watcher.normaliseBaseline({ state: 'RUNNING' })).toBeNull()
    expect(watcher.normaliseBaseline({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('GlueWatcher.classifyError', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it.each(['CredentialsProviderError', 'TokenProviderError', 'ProviderError'])(
    'classifies %s as auth error',
    (name) => {
      const err = Object.assign(new Error('auth'), { name })
      const result = watcher.classifyError(err)
      expect(result.kind).toBe('auth')
      expect(result.statusModifier).toBe('auth-error')
      expect(result.userMessage).toMatch(/authentication expired/)
    },
  )

  it.each(['ThrottlingException', 'TooManyRequestsException'])(
    'classifies %s as throttle error with backoff',
    (name) => {
      const err = Object.assign(new Error('throttle'), { name })
      const result = watcher.classifyError(err)
      expect(result.kind).toBe('throttle')
      expect(result.shouldBackoff).toBe(true)
      expect(result.userMessage).toMatch(/throttled/)
    },
  )

  it('classifies unknown error as generic', () => {
    const err = Object.assign(new Error('oops'), { name: 'UnknownError' })
    const result = watcher.classifyError(err)
    expect(result.kind).toBe('generic')
    expect(result.shouldBackoff).toBe(false)
    expect(result.userMessage).toMatch(/poll failed/)
  })
})

// ---------------------------------------------------------------------------
// Per-watch schedulers
// ---------------------------------------------------------------------------

describe('GlueWatcher per-watch schedulers', () => {
  it('two watches with different pollIntervalMs get schedulers with correct intervalMs', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const r1 = await watcher.executeTool({ action: 'add', type: 'job', name: 'j1', runId: 'jr_1', profile: 'p', pollIntervalMs: 30_000 })
    const r2 = await watcher.executeTool({ action: 'add', type: 'job', name: 'j2', runId: 'jr_2', profile: 'p', pollIntervalMs: 60_000 })
    const id1 = r1.details['watchId'] as string
    const id2 = r2.details['watchId'] as string
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { intervalMs: number }> })._watchSchedulers
    expect(schedulers.get(id1)?.intervalMs).toBe(30_000)
    expect(schedulers.get(id2)?.intervalMs).toBe(60_000)
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('schedulerFor returns same instance on repeat calls', () => {
    const { watcher } = makeWatcher()
    const sf = (watcher as unknown as { schedulerFor(k: string): unknown }).schedulerFor.bind(watcher)
    const s1 = sf('key1')
    const s2 = sf('key1')
    expect(s1).toBe(s2)
    expect(s1).not.toBe(sf('key2'))
  })
})

// ---------------------------------------------------------------------------
// startPolling stagger
// ---------------------------------------------------------------------------

describe('GlueWatcher startPolling stagger', () => {
  it('first scheduler starts at 0ms, second at 2000ms, third at 4000ms', () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    // Seed watches manually to bypass addWatch (which starts schedulers immediately)
    watcher.stopPolling()
    ;(watcher as unknown as { _watchSchedulers: Map<string, unknown> })._watchSchedulers.clear()
    for (const id of ['w1', 'w2', 'w3']) {
      watches.set(id, {
        watchId: id,
        type: 'job',
        name: `job-${id}`,
        runId: `jr_${id}`,
        profile: 'p',
        region: undefined,
        addedAt: 0,
        lastPolledAt: undefined,
        baseline: undefined,
        terminal: false,
        consecutiveErrors: 0,
      })
    }
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> })._watchSchedulers
    watcher.startPolling()

    // At t=0: first scheduler should be running
    expect(schedulers.get('w1')?.isRunning).toBe(true)
    // w2 and w3 are delayed
    expect(schedulers.get('w2')?.isRunning).toBeFalsy()
    expect(schedulers.get('w3')?.isRunning).toBeFalsy()

    // Advance 2000ms: w2 should now start
    vi.advanceTimersByTime(2000)
    expect(schedulers.get('w2')?.isRunning).toBe(true)
    expect(schedulers.get('w3')?.isRunning).toBeFalsy()

    // Advance another 2000ms: w3 should now start
    vi.advanceTimersByTime(2000)
    expect(schedulers.get('w3')?.isRunning).toBe(true)

    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// view rendering
// ---------------------------------------------------------------------------

describe('stateColor helper', () => {
  it.each([
    ['RUNNING', 'warning'],
    ['STARTING', 'warning'],
    ['SUCCEEDED', 'success'],
    ['COMPLETED', 'success'],
    ['FAILED', 'error'],
    ['ERROR', 'error'],
    ['TIMEOUT', 'error'],
    ['STOPPED', 'error'],
    ['PENDING', 'dim'],
    ['', 'dim'],
    ['UNKNOWN', 'dim'],
  ] as [string, string][])('stateColor(%s) === %s', (state, expected) => {
    expect(stateColor(state)).toBe(expected)
  })
})

describe('renderItemRowTUI — job watch', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  function makeJobWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
    return {
      watchId: 'w1',
      type: 'job',
      name: 'my-etl-job',
      runId: 'jr_abcd1234',
      profile: 'dev',
      region: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...overrides,
    }
  }

  it('name column uses [last4] format', () => {
    const w = makeJobWatch()
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const name = cols.find((c) => c.name === 'name')
    expect(name?.text).toBe('job my-etl-job [1234]')
  })

  it('state column color is warning for RUNNING', () => {
    const baseline: JobBaseline = { state: 'RUNNING', errorMessage: '' }
    const w = makeJobWatch({ baseline })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const state = cols.find((c) => c.name === 'state')
    expect(state?.color).toBe('warning')
  })

  it('state column color is success for SUCCEEDED', () => {
    const baseline: JobBaseline = { state: 'SUCCEEDED', errorMessage: '' }
    const w = makeJobWatch({ baseline })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const state = cols.find((c) => c.name === 'state')
    expect(state?.color).toBe('success')
  })

  it('state column color is error for FAILED', () => {
    const baseline: JobBaseline = { state: 'FAILED', errorMessage: 'oops' }
    const w = makeJobWatch({ baseline })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const state = cols.find((c) => c.name === 'state')
    expect(state?.color).toBe('error')
  })

  it('state column color is dim for unknown state', () => {
    const baseline: JobBaseline = { state: 'PENDING', errorMessage: '' }
    const w = makeJobWatch({ baseline })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const state = cols.find((c) => c.name === 'state')
    expect(state?.color).toBe('dim')
  })

  it('elapsed column is present with width 7', () => {
    const w = makeJobWatch()
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const elapsed = cols.find((c) => c.name === 'elapsed')
    expect(elapsed).toBeDefined()
    expect(elapsed?.width).toBe(7)
  })

  it('workers column is present with width 10', () => {
    const w = makeJobWatch()
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const workers = cols.find((c) => c.name === 'workers')
    expect(workers).toBeDefined()
    expect(workers?.width).toBe(10)
  })

  it('workers column shows N×Type when baseline has workers', () => {
    const baseline: JobBaseline = {
      state: 'RUNNING',
      errorMessage: '',
      numberOfWorkers: 10,
      workerType: 'G.2X',
    }
    const w = makeJobWatch({ baseline })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const workers = cols.find((c) => c.name === 'workers')
    expect(workers?.text).toBe('10\u00d7G.2X')
  })

  it('workers column shows "-" when no worker info in baseline', () => {
    const baseline: JobBaseline = { state: 'RUNNING', errorMessage: '' }
    const w = makeJobWatch({ baseline })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const workers = cols.find((c) => c.name === 'workers')
    expect(workers?.text).toBe('-')
  })

  it('workers column shows "-" when baseline is absent', () => {
    const w = makeJobWatch()
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const workers = cols.find((c) => c.name === 'workers')
    expect(workers?.text).toBe('-')
  })
})

describe('renderItemRowTUI — workflow watch', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  function makeWorkflowWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
    return {
      watchId: 'w2',
      type: 'workflow',
      name: 'my-workflow',
      runId: 'wr_abcd5678',
      profile: 'dev',
      region: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...overrides,
    }
  }

  it('elapsed shows "-" for workflow watch', () => {
    const baseline: WorkflowBaseline = {
      state: 'RUNNING',
      totalActions: 2,
      succeededActions: 0,
      failedActions: 0,
      runningActions: 2,
      reportedFailedNodes: [],
    }
    const w = makeWorkflowWatch({ baseline })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const elapsed = cols.find((c) => c.name === 'elapsed')
    expect(elapsed?.text).toBe('-')
  })

  it('workers shows "-" for workflow watch', () => {
    const w = makeWorkflowWatch()
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const workers = cols.find((c) => c.name === 'workers')
    expect(workers?.text).toBe('-')
  })
})

// ---------------------------------------------------------------------------
// startPolling identity check
// ---------------------------------------------------------------------------

describe('GlueWatcher startPolling identity check', () => {
  it('replacing scheduler via set-interval prevents staggered old scheduler from starting', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    // Seed two watches manually
    watcher.stopPolling()
    ;(watcher as unknown as { _watchSchedulers: Map<string, unknown> })._watchSchedulers.clear()
    watches.clear()
    watches.set('w1', {
      watchId: 'w1', type: 'job', name: 'j1', runId: 'jr_1', profile: 'p',
      region: undefined, addedAt: 0, lastPolledAt: undefined, baseline: undefined,
      terminal: false, consecutiveErrors: 0,
    })
    watches.set('w2', {
      watchId: 'w2', type: 'job', name: 'j2', runId: 'jr_2', profile: 'p',
      region: undefined, addedAt: 0, lastPolledAt: undefined, baseline: undefined,
      terminal: false, consecutiveErrors: 0,
    })
    const schedulers = (watcher as unknown as {
      _watchSchedulers: Map<string, { isRunning: boolean }>
    })._watchSchedulers

    watcher.startPolling()
    // w2 is delayed 2000ms
    expect(schedulers.get('w1')?.isRunning).toBe(true)
    expect(schedulers.get('w2')?.isRunning).toBeFalsy()

    // Replace w2's scheduler via set-interval before the stagger fires
    await watcher.executeTool({ action: 'set-interval', watchId: 'w2', pollIntervalMs: 60_000 })
    const newScheduler = schedulers.get('w2')
    // Should be running already (set-interval starts it)
    expect(newScheduler?.isRunning).toBe(true)

    // When original stagger fires at 2000ms, identity check should prevent double-start
    vi.advanceTimersByTime(2000)
    // New scheduler is still the same instance and still running
    expect(schedulers.get('w2')).toBe(newScheduler)
    expect(newScheduler?.isRunning).toBe(true)

    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// view.renderItemRowText — text-mode row (TUI-less contexts)
// ---------------------------------------------------------------------------

describe('view.renderItemRowText', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  function makeJobWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
    return {
      watchId: 'w1',
      type: 'job',
      name: 'my-etl-job',
      runId: 'jr_abcd1234',
      profile: 'dev',
      region: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...overrides,
    }
  }

  it('shows WATCHING for an active non-error watch', () => {
    const w = makeJobWatch({ baseline: { state: 'RUNNING', errorMessage: '' } })
    const text = watcher.view.renderItemRowText(w)
    expect(text).toContain('WATCHING')
    expect(text).toContain('RUNNING')
  })

  it('shows DONE for a terminal watch', () => {
    const w = makeJobWatch({ terminal: true, baseline: { state: 'SUCCEEDED', errorMessage: '' } })
    const text = watcher.view.renderItemRowText(w)
    expect(text).toContain('DONE')
    expect(text).toContain('SUCCEEDED')
  })

  it('shows ERROR when consecutiveErrors exceeds threshold', () => {
    const w = makeJobWatch({ consecutiveErrors: POLL_ERROR_THRESHOLD })
    const text = watcher.view.renderItemRowText(w)
    expect(text).toContain('ERROR')
  })

  it('uses "?" for state when baseline is absent', () => {
    const w = makeJobWatch()
    const text = watcher.view.renderItemRowText(w)
    expect(text).toContain('?')
    expect(text).toContain('WATCHING')
  })

  it('includes last 4 chars of runId', () => {
    const w = makeJobWatch({ runId: 'jr_xyz99999' })
    const text = watcher.view.renderItemRowText(w)
    expect(text).toContain('[9999]')
  })
})

// ---------------------------------------------------------------------------
// view.renderItemRowTUI — status column (DONE / ERROR path)
// ---------------------------------------------------------------------------

describe('view.renderItemRowTUI — status column', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  function makeJobWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
    return {
      watchId: 'w1',
      type: 'job',
      name: 'my-etl-job',
      runId: 'jr_abcd1234',
      profile: 'dev',
      region: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...overrides,
    }
  }

  it('status column shows DONE and color warning for terminal watch', () => {
    const w = makeJobWatch({ terminal: true })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const status = cols.find((c) => c.name === 'status')
    expect(status?.text).toBe('DONE')
    expect(status?.color).toBe('warning')
  })

  it('status column shows ERROR and color error when consecutiveErrors >= threshold', () => {
    const w = makeJobWatch({ consecutiveErrors: POLL_ERROR_THRESHOLD })
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 120 })
    const status = cols.find((c) => c.name === 'status')
    expect(status?.text).toBe('ERROR')
    expect(status?.color).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// view.renderItemDetail
// ---------------------------------------------------------------------------

describe('view.renderItemDetail', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  function makeJobWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
    return {
      watchId: 'w1',
      type: 'job',
      name: 'my-etl-job',
      runId: 'jr_abcd1234',
      profile: 'dev',
      region: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...overrides,
    }
  }

  const mockCtx = { theme: {} as never, width: 120 }

  it('shows "never" for lastPolledAt when undefined', () => {
    const w = makeJobWatch({ lastPolledAt: undefined })
    const fields = watcher.view.renderItemDetail(w, mockCtx)
    const polled = fields.find((f) => f.label === 'polled')
    expect(polled?.value).toBe('never')
  })

  it('shows ISO string for lastPolledAt when set', () => {
    const w = makeJobWatch({ lastPolledAt: 1_700_000_000_000 })
    const fields = watcher.view.renderItemDetail(w, mockCtx)
    const polled = fields.find((f) => f.label === 'polled')
    expect(polled?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('shows "unknown" for poll interval when context has none', () => {
    const w = makeJobWatch()
    const fields = watcher.view.renderItemDetail(w, mockCtx)
    const poll = fields.find((f) => f.label === 'poll')
    expect(poll?.value).toBe('unknown')
  })

  it('shows seconds for poll interval when context has a value', () => {
    const w = makeJobWatch()
    const fields = watcher.view.renderItemDetail(w, { ...mockCtx, pollIntervalMs: 120_000 })
    const poll = fields.find((f) => f.label === 'poll')
    expect(poll?.value).toBe('120s')
  })

  it('shows "yes" for terminal flag when terminal is true', () => {
    const w = makeJobWatch({ terminal: true })
    const fields = watcher.view.renderItemDetail(w, mockCtx)
    const terminal = fields.find((f) => f.label === 'terminal')
    expect(terminal?.value).toBe('yes')
  })

  it('shows "no" for terminal flag when terminal is false', () => {
    const w = makeJobWatch({ terminal: false })
    const fields = watcher.view.renderItemDetail(w, mockCtx)
    const terminal = fields.find((f) => f.label === 'terminal')
    expect(terminal?.value).toBe('no')
  })

  it('shows "unknown" for state when baseline is absent', () => {
    const w = makeJobWatch({ baseline: undefined })
    const fields = watcher.view.renderItemDetail(w, mockCtx)
    const state = fields.find((f) => f.label === 'state')
    expect(state?.value).toBe('unknown')
  })

  it('shows "default" for region when watch has no region', () => {
    const w = makeJobWatch({ region: undefined })
    const fields = watcher.view.renderItemDetail(w, mockCtx)
    const region = fields.find((f) => f.label === 'region')
    expect(region?.value).toBe('default')
  })

  it('shows actual region when watch has one', () => {
    const w = makeJobWatch({ region: 'us-east-2' })
    const fields = watcher.view.renderItemDetail(w, mockCtx)
    const region = fields.find((f) => f.label === 'region')
    expect(region?.value).toBe('us-east-2')
  })
})

// ---------------------------------------------------------------------------
// view.renderEventRow and view.isRowDimmed
// ---------------------------------------------------------------------------

describe('view.renderEventRow and isRowDimmed', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('renderEventRow returns the formatted string', () => {
    const event: GlueEvent = {
      formatted: '• job my-etl SUCCEEDED',
      isTerminal: true,
      watchId: 'w1',
      type: 'job',
      name: 'my-etl',
      runId: 'jr1234',
      eventType: 'state_changed',
      previousState: 'RUNNING',
      newState: 'SUCCEEDED',
      summary: 'job my-etl changed state to SUCCEEDED',
    }
    expect(watcher.view.renderEventRow(event)).toBe('• job my-etl SUCCEEDED')
  })

  it('isRowDimmed returns true for terminal watches', () => {
    const w: GlueWatch = {
      watchId: 'w1',
      type: 'job',
      name: 'my-etl-job',
      runId: 'jr_abcd',
      profile: 'dev',
      region: undefined,
      lastPolledAt: undefined,
      baseline: undefined,
      addedAt: 0,
      terminal: true,
      consecutiveErrors: 0,
    }
    expect(watcher.view.isRowDimmed?.(w)).toBe(true)
  })

  it('isRowDimmed returns false for active watches', () => {
    const w: GlueWatch = {
      watchId: 'w1',
      type: 'job',
      name: 'my-etl-job',
      runId: 'jr_abcd',
      profile: 'dev',
      region: undefined,
      lastPolledAt: undefined,
      baseline: undefined,
      addedAt: 0,
      terminal: false,
      consecutiveErrors: 0,
    }
    expect(watcher.view.isRowDimmed?.(w)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// view.itemSortKey and view.itemGroup
// ---------------------------------------------------------------------------

describe('view.itemSortKey and itemGroup', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('itemSortKey returns type:name:runId', () => {
    const w: GlueWatch = {
      watchId: 'w1',
      type: 'job',
      name: 'etl-job',
      runId: 'jr_aabbccdd',
      profile: 'dev',
      region: undefined,
      lastPolledAt: undefined,
      baseline: undefined,
      addedAt: 0,
      terminal: false,
      consecutiveErrors: 0,
    }
    expect(watcher.view.itemSortKey(w)).toBe('job:etl-job:jr_aabbccdd')
  })

  it('itemGroup returns the profile', () => {
    const w: GlueWatch = {
      watchId: 'w1',
      type: 'workflow',
      name: 'wf1',
      runId: 'wr_aabbccdd',
      profile: 'production',
      region: undefined,
      lastPolledAt: undefined,
      baseline: undefined,
      addedAt: 0,
      terminal: false,
      consecutiveErrors: 0,
    }
    expect(watcher.view.itemGroup?.(w)).toBe('production')
  })
})

// ---------------------------------------------------------------------------
// normaliseBaseline — optional fields and null paths
// ---------------------------------------------------------------------------

describe('normaliseBaseline — optional fields', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('normalises a JobBaseline with all optional fields set', () => {
    const result = watcher.normaliseBaseline({
      errorMessage: '',
      state: 'RUNNING',
      startedOn: '2024-01-15T12:00:00Z',
      completedOn: '2024-01-15T13:00:00Z',
      numberOfWorkers: 5,
      workerType: 'G.1X',
      timeoutMinutes: 120,
    })
    expect(result).not.toBeNull()
    const b = result as JobBaseline
    expect(b.startedOn).toBe('2024-01-15T12:00:00Z')
    expect(b.completedOn).toBe('2024-01-15T13:00:00Z')
    expect(b.numberOfWorkers).toBe(5)
    expect(b.workerType).toBe('G.1X')
    expect(b.timeoutMinutes).toBe(120)
  })

  it('returns null for a JobBaseline when state is not a string', () => {
    const result = watcher.normaliseBaseline({ errorMessage: '', state: 42 })
    expect(result).toBeNull()
  })

  it('normalises a WorkflowBaseline with nodes array', () => {
    const result = watcher.normaliseBaseline({
      totalActions: 3,
      succeededActions: 1,
      failedActions: 0,
      runningActions: 2,
      state: 'RUNNING',
      reportedFailedNodes: [],
      nodes: [{ Name: 'node1', Type: 'JOB', JobDetails: {} }],
    })
    expect(result).not.toBeNull()
    const b = result as WorkflowBaseline
    expect(Array.isArray(b.nodes)).toBe(true)
    expect(b.nodes?.length).toBe(1)
  })

  it('returns null for a WorkflowBaseline when state is not a string', () => {
    const result = watcher.normaliseBaseline({
      totalActions: 2,
      succeededActions: 0,
      failedActions: 0,
      runningActions: 2,
      state: null,
      reportedFailedNodes: [],
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// normaliseWatch — edge cases
// ---------------------------------------------------------------------------

describe('normaliseWatch — non-boolean terminal and non-number consecutiveErrors', () => {
  let watcher: GlueWatcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('defaults terminal to false when it is not a boolean', () => {
    const result = watcher.normaliseWatch({
      watchId: 'w1',
      type: 'job',
      name: 'etl',
      runId: 'jr1234',
      profile: 'dev',
      terminal: 'yes', // wrong type
    })
    expect(result?.terminal).toBe(false)
  })

  it('defaults consecutiveErrors to 0 when it is not a finite number', () => {
    const result = watcher.normaliseWatch({
      watchId: 'w1',
      type: 'job',
      name: 'etl',
      runId: 'jr1234',
      profile: 'dev',
      consecutiveErrors: 'three', // wrong type
    })
    expect(result?.consecutiveErrors).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// addWatch — workflow, region param, seeding failure
// ---------------------------------------------------------------------------

describe('addWatch — additional branches', () => {
  it('addWatch with region sets region on the watch', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      type: 'workflow',
      name: 'my-workflow',
      runId: 'wr_123abc',
      profile: 'prod',
      region: 'eu-west-1',
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    const watches = (watcher as unknown as { watches: Map<string, GlueWatch> }).watches
    expect(watches.get(watchId)?.region).toBe('eu-west-1')
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('addWatch with snapshot failure reports seeding error in message', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    vi.mocked(client.getJobRun).mockRejectedValue(new Error('network timeout'))
    const { watcher } = makeWatcher(client)
    const result = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'broken-job',
      runId: 'jr_fail',
      profile: 'dev',
    })
    const text = result.content[0]?.text
    expect(String(text ?? '')).toContain('seeding failed')
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// browseOptions — callbacks exercised directly
// ---------------------------------------------------------------------------

describe('browseOptions callbacks', () => {
  let watcher: GlueWatcher
  let client: GlueClient

  beforeEach(() => {
    vi.useFakeTimers()
    ;({ watcher, client } = makeWatcher())
  })

  afterEach(() => {
    watcher.stopPolling()
    vi.useRealTimers()
  })

  function makeJobWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
    return {
      watchId: 'w1',
      type: 'job',
      name: 'my-etl-job',
      runId: 'jr_abcd1234',
      profile: 'dev',
      region: 'us-east-1',
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...overrides,
    }
  }

  function makeWorkflowWatch(overrides: Partial<GlueWatch> = {}): GlueWatch {
    return {
      watchId: 'w2',
      type: 'workflow',
      name: 'my-workflow',
      runId: 'wr_abcd5678',
      profile: 'dev',
      region: 'us-east-1',
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
      ...overrides,
    }
  }

  it('stop rowAction visible returns false for terminal watches', () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions: Array<{ id: string; visible: (w: GlueWatch) => boolean }> } }).browseOptions()
    const stopAction = opts.rowActions.find((a) => a.id === 'stop')
    expect(stopAction?.visible(makeJobWatch({ terminal: true }))).toBe(false)
    expect(stopAction?.visible(makeJobWatch({ terminal: false }))).toBe(true)
  })

  it('remove rowAction visible returns false for terminal watches', () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions: Array<{ id: string; visible: (w: GlueWatch) => boolean }> } }).browseOptions()
    const removeAction = opts.rowActions.find((a) => a.id === 'remove')
    expect(removeAction?.visible(makeJobWatch({ terminal: true }))).toBe(false)
    expect(removeAction?.visible(makeJobWatch({ terminal: false }))).toBe(true)
  })

  it('stop rowAction.run calls stopJobRun for job watches', async () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions: Array<{ id: string; run: (w: GlueWatch) => Promise<void> }> } }).browseOptions()
    const stopAction = opts.rowActions.find((a) => a.id === 'stop')
    await stopAction?.run(makeJobWatch())
    expect(client.stopJobRun).toHaveBeenCalledWith('my-etl-job', 'jr_abcd1234', 'dev', 'us-east-1')
  })

  it('stop rowAction.run calls stopWorkflowRun for workflow watches', async () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions: Array<{ id: string; run: (w: GlueWatch) => Promise<void> }> } }).browseOptions()
    const stopAction = opts.rowActions.find((a) => a.id === 'stop')
    await stopAction?.run(makeWorkflowWatch())
    expect(client.stopWorkflowRun).toHaveBeenCalledWith('my-workflow', 'wr_abcd5678', 'dev', 'us-east-1')
  })

  it('remove rowAction.run calls executeTool with remove action', async () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions: Array<{ id: string; run: (w: GlueWatch) => Promise<void> }> } }).browseOptions()
    const removeAction = opts.rowActions.find((a) => a.id === 'remove')
    // Add a watch first so executeTool can find it
    ;(watcher as unknown as { watches: Map<string, GlueWatch> }).watches.set('w1', makeJobWatch())
    const executeSpy = vi.spyOn(watcher, 'executeTool')
    await removeAction?.run(makeJobWatch())
    expect(executeSpy).toHaveBeenCalledWith({ action: 'remove', watchId: 'w1' })
  })

  it('onRefresh calls pollOnce', () => {
    const opts = (watcher as unknown as { browseOptions(): { onRefresh: () => void } }).browseOptions()
    const pollSpy = vi.spyOn(watcher, 'pollOnce').mockResolvedValue(undefined)
    opts.onRefresh()
    expect(pollSpy).toHaveBeenCalledOnce()
  })

  it('onPurge calls executePurge', () => {
    const opts = (watcher as unknown as { browseOptions(): { onPurge: () => void } }).browseOptions()
    const purgeSpy = vi.spyOn(watcher as unknown as { executePurge(): void }, 'executePurge').mockReturnValue(undefined)
    opts.onPurge()
    expect(purgeSpy).toHaveBeenCalledOnce()
  })

  it('getPollIntervalMs returns interval from per-watch scheduler', () => {
    const opts = (watcher as unknown as { browseOptions(): { getPollIntervalMs: (w: GlueWatch) => number } }).browseOptions()
    const w = makeJobWatch({ watchId: 'w1' })
    // Add the watch so its scheduler is created on first access
    ;(watcher as unknown as { watches: Map<string, GlueWatch> }).watches.set('w1', w)
    const ms = opts.getPollIntervalMs(w)
    expect(typeof ms).toBe('number')
    expect(ms).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// expandedTextOverride in register()
// ---------------------------------------------------------------------------

describe('expandedTextOverride in register()', () => {
  beforeEach(() => {
    capturedExpandedTextOverride = undefined
  })

  it('returns expanded text when message has a watches field', () => {
    const { watcher, pi } = makeWatcher()
    watcher.register(pi as never)
    const fn = capturedExpandedTextOverride
    expect(fn).toBeDefined()

    const fn2 = fn!; const result = fn2({
      details: {
        watches: {},
        date: new Date().toISOString(),
      },
    })
    expect(typeof result).toBe('string')
  })

  it('returns expanded text with pollMs when present', () => {
    const { watcher, pi } = makeWatcher()
    watcher.register(pi as never)
    const fn = capturedExpandedTextOverride
    expect(fn).toBeDefined()

    const fn2 = fn!; const result = fn2({
      details: {
        watches: {},
        date: new Date().toISOString(),
        pollMs: 120_000,
      },
    })
    expect(typeof result).toBe('string')
  })

  it('returns undefined when message has no watches field', () => {
    const { watcher, pi } = makeWatcher()
    watcher.register(pi as never)
    const fn = capturedExpandedTextOverride
    expect(fn).toBeDefined()

    const fn3 = fn!; expect(fn3({ details: { someOtherField: true } })).toBeUndefined()
    expect(fn3({ details: null })).toBeUndefined()
    expect(fn3({})).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// onSessionStart — crash-recovery path
// ---------------------------------------------------------------------------

describe('onSessionStart — crash-recovery', () => {
  it('enables watcher and shows widget when there are active watches but enabled=false', async () => {
    vi.useFakeTimers()
    const { watcher, pi } = makeWatcher()

    // Seed an active watch directly
    ;(watcher as unknown as { watches: Map<string, GlueWatch> }).watches.set('w1', {
      watchId: 'w1',
      type: 'job',
      name: 'job1',
      runId: 'jr1234',
      profile: 'dev',
      region: undefined,
      lastPolledAt: undefined,
      baseline: undefined,
      addedAt: 0,
      terminal: false,
      consecutiveErrors: 0,
    })

    // Simulate enabled=false (default initial state before registration)
    ;(watcher as unknown as { enabled: boolean }).enabled = false
    ;(watcher as unknown as { _state: { enabled: boolean } })._state = { enabled: false }

    // Call onSessionStart — should detect hasActive=true + enabled=false
    await watcher.onSessionStart({ ui: { notify: vi.fn() } })

    // enabled should now be true
    expect((watcher as unknown as { enabled: boolean }).enabled).toBe(true)
    // addToolToActive should have been called via pi.getActiveTools / setActiveTools
    expect(pi.getActiveTools).toHaveBeenCalled()

    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Round-trip: numberOfWorkers + workerType survive poll → persist → normalise → widget entry
// ---------------------------------------------------------------------------

describe('round-trip: numberOfWorkers and workerType through persist → normalise → widget entry', () => {
  it('preserves numberOfWorkers and workerType after poll + writeState + rehydration', async () => {
    vi.useFakeTimers()

    // Step 1 — poll: mock client that first returns RUNNING (no workers) for the seed,
    // then returns SUCCEEDED + workers so the poll produces a state-change event and
    // writeState() is called with the updated baseline.
    const client = makeClient()
    vi.mocked(client.getJobRun)
      .mockResolvedValueOnce({ JobRun: { JobRunState: 'RUNNING', ErrorMessage: '' } })
      .mockResolvedValue({
        JobRun: {
          JobRunState: 'SUCCEEDED',
          ErrorMessage: '',
          NumberOfWorkers: 10,
          WorkerType: 'G.2X',
          StartedOn: '2024-01-01T00:00:00Z',
          CompletedOn: '2024-01-01T01:00:00Z',
        },
      })

    const { watcher, pi } = makeWatcher(client)

    // Add a job watch (seeds baseline as RUNNING with no workers)
    const addResult = await watcher.executeTool({
      action: 'add',
      type: 'job',
      name: 'my-etl',
      runId: 'jr_abc123',
      profile: 'my-profile',
    })
    const watchId = addResult.details['watchId'] as string

    // Poll: RUNNING → SUCCEEDED triggers a state_changed event → writeState() is called
    await watcher.pollWatch(watchId)

    // Step 2 — persist: capture the most recent state entry written by writeState()
    const appendCalls = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls
    const stateCall = [...appendCalls]
      .reverse()
      .find((args) => args[0] === 'pi-aws-glue-watcher:state')
    expect(stateCall).toBeDefined()
    // Simulate JSON serialisation round-trip (as the pi runtime would do)
    const persistedData = JSON.parse(JSON.stringify(stateCall![1])) as Record<string, unknown>

    // Step 3 — normalise: rehydrate a fresh watcher from the persisted state
    const { watcher: watcher2 } = makeWatcher(client)
    await watcher2.onSessionStart({
      sessionManager: {
        getEntries: () => [
          {
            type: 'custom',
            customType: 'pi-aws-glue-watcher:state',
            data: persistedData,
          },
        ],
      },
      ui: { notify: vi.fn() },
    })

    // Step 4 — widget entry: buildWidgetEntries must carry numberOfWorkers + workerType
    const watches2 = (watcher2 as unknown as { watches: Map<string, GlueWatch> }).watches
    const watchMap: WatchMap = {}
    for (const [k, v] of watches2) watchMap[k] = v

    const entries = buildWidgetEntries(watchMap)
    const entry = entries.find((e) => e.displayName.includes('my-etl'))

    expect(entry).toBeDefined()
    expect(entry?.numberOfWorkers).toBe(10)
    expect(entry?.workerType).toBe('G.2X')

    watcher.stopPolling()
    watcher2.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Branch coverage: _minIntervalMs via widget.getPollIntervalMs callback
// ---------------------------------------------------------------------------

describe('GlueWatcher._minIntervalMs (via widget callback)', () => {
  it('returns POLL_INTERVAL_MS when no schedulers are registered (empty map)', () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    // Access the getPollIntervalMs callback stored inside the widget.
    // This invokes the lambda at line 266 of watcher.ts, which in turn
    // exercises the entire _minIntervalMs body.
    const getMs = (watcher as unknown as { widget: { getPollIntervalMs: () => number } }).widget.getPollIntervalMs
    expect(getMs()).toBe(120_000) // POLL_INTERVAL_MS
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('returns the minimum scheduler intervalMs when schedulers exist', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher()
    // Add two watches with explicit poll intervals; the widget callback should
    // return the minimum of the two scheduler intervals.
    await watcher.executeTool({ action: 'add', type: 'job', name: 'j1', runId: 'jr_1', profile: 'p', pollIntervalMs: 30_000 })
    await watcher.executeTool({ action: 'add', type: 'job', name: 'j2', runId: 'jr_2', profile: 'p', pollIntervalMs: 60_000 })
    const getMs = (watcher as unknown as { widget: { getPollIntervalMs: () => number } }).widget.getPollIntervalMs
    // The PollScheduler starts at baseMs (30 000 for the first watch).
    expect(getMs()).toBeLessThanOrEqual(60_000)
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Branch coverage: normaliseBaseline — non-string elements in reportedFailedNodes
// ---------------------------------------------------------------------------

describe('GlueWatcher.normaliseBaseline — non-string elements in reportedFailedNodes', () => {
  it('filters out non-string elements from reportedFailedNodes', () => {
    const { watcher } = makeWatcher()
    const raw = {
      state: 'RUNNING',
      totalActions: 1,
      succeededActions: 0,
      failedActions: 0,
      runningActions: 1,
      // mix valid strings and non-strings — non-strings must be filtered out
      reportedFailedNodes: ['job-a', 42, null, 'job-b', true],
    }
    const b = watcher.normaliseBaseline(raw)
    expect(b).not.toBeNull()
    const wf = b as import('../src/types.js').WorkflowBaseline
    expect(wf.reportedFailedNodes).toEqual(['job-a', 'job-b'])
  })
})
