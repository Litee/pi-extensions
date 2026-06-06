/**
 * Unit tests for GlueWatcher (extends BaseWatcher).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobRunResponse, WorkflowRunResponse } from '../src/glue-client.js'
import type { GlueClient } from '../src/glue-client.js'
import { GlueWatcher } from '../src/watcher.js'
import type { GlueWatch, WatchBaseline } from '../src/types.js'

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
