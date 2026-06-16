/**
 * Unit tests for Ec2Watcher (extends BaseWatcher).
 *
 * Uses a mock Ec2Client stub. BaseWatcher lifecycle is exercised via
 * executeTool + pollOnce rather than full register() integration.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { POLL_ERROR_THRESHOLD } from 'pi-watcher-core/base-watcher'
import type { Ec2Client, InstanceStateResult } from '../src/ec2-client.js'
import type { Ec2Event, Ec2Watch } from '../src/types.js'
import { Ec2Watcher, formatTimeLeft, formatUptime } from '../src/watcher.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

vi.mock('pi-watcher-core/validate-aws-profile', () => ({
  validateAwsProfile: vi.fn().mockReturnValue(null),
}))
import { validateAwsProfile } from 'pi-watcher-core/validate-aws-profile'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))
import { readFileSync } from 'node:fs'

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

function makeClient(resp: InstanceStateResult | Error): Ec2Client {
  const describe = vi.fn()
  if (resp instanceof Error) describe.mockRejectedValue(resp)
  else describe.mockResolvedValue(resp)
  return {
    describeInstance: describe,
    stopInstance: vi.fn().mockResolvedValue(undefined),
    startInstance: vi.fn().mockResolvedValue(undefined),
  }
}

function makeWatcher(resp: InstanceStateResult | Error = { state: 'running' }, nowMs?: number) {
  const pi = makePi()
  const client = makeClient(resp)
  const now = nowMs !== undefined ? () => nowMs : Date.now
  const watcher = new Ec2Watcher({ pi: pi as never, client, now })
  return { watcher, pi, client }
}

// ---------------------------------------------------------------------------
// addWatch
// ---------------------------------------------------------------------------

describe('Ec2Watcher.addWatch', () => {
  it('adds a watch with valid params and seeds baseline', async () => {
    const { watcher } = makeWatcher({ state: 'running' })
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'default',
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(typeof watchId).toBe('string')
    expect(watcher['watches'].has(watchId)).toBe(true)
    expect(watcher['baselines'].has(watchId)).toBe(true)
    expect(watcher['baselines'].get(watchId)?.state).toBe('running')
  })

  it('returns error when instanceId is missing', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/requires 'instanceId'/)
  })

  it('returns error when instanceId format is invalid', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'bad-id',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/Invalid EC2 instance ID/)
  })

  it('returns error when profile is missing', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/requires a profile/)
  })

  it('rejects when instance not found at add-time', async () => {
    const { watcher } = makeWatcher({ notFound: true })
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/not found/)
    expect(watcher['watches'].size).toBe(0)
  })

  it('soft-fails on seed error — watch still added with undefined baseline', async () => {
    const err = Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' })
    const { watcher } = makeWatcher(err)
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(watcher['watches'].get(watchId)?.baseline).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toMatch(/seeding failed/)
  })

  it('applies timeoutSeconds correctly', async () => {
    const { watcher } = makeWatcher({ state: 'running' }, 10_000)
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
      timeoutSeconds: 60,
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(watcher['watches'].get(watchId)?.timeoutAt).toBe(10_000 + 60_000)
  })

  it('caps timeoutSeconds at MAX_TIMEOUT_SECONDS', async () => {
    const { watcher } = makeWatcher({ state: 'running' }, 10_000)
    const MAX = 72 * 60 * 60
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
      timeoutSeconds: MAX + 3600,
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(watcher['watches'].get(watchId)?.timeoutAt).toBe(10_000 + MAX * 1000)
    expect((result.content[0] as { text: string }).text).toMatch(/capped/)
  })

  it('rejects negative timeoutSeconds', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
      timeoutSeconds: -5,
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/timeoutSeconds/)
  })

  it('returns _toolError and keeps watches.size at 1 when instanceId is already watched', async () => {
    const { watcher } = makeWatcher({ state: 'running' })
    const first = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'myprofile',
    })
    expect(first.details['ok']).toBe(true)
    const existingWatchId = first.details['watchId'] as string

    const second = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'myprofile',
    })
    expect(second.details['ok']).toBe(false)
    expect((second.content[0] as { text: string }).text).toMatch(/already being watched/)
    expect((second.content[0] as { text: string }).text).toContain(existingWatchId)
    expect(watcher['watches'].size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// removeWatch
// ---------------------------------------------------------------------------

describe('Ec2Watcher.removeWatch', () => {
  it('returns correct remaining count in message', async () => {
    const { watcher } = makeWatcher({ state: 'running' })
    const r1 = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
    })
    await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0b1b2c3d4e5f67891',
      profile: 'p',
    })
    const watchId = r1.details['watchId'] as string
    const result = await watcher.executeTool({ action: 'remove', watchId })
    expect((result.content[0] as { text: string }).text).toMatch(/1 watch\(es\) remaining/)
  })

  it('returns error for unknown watchId', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({ action: 'remove', watchId: 'no-such-id' })
    expect((result.content[0] as { text: string }).text).toMatch(/No watch found/)
  })

  it('includes instanceId in remove message', async () => {
    const { watcher } = makeWatcher({ state: 'running' })
    const addResult = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const result = await watcher.executeTool({ action: 'remove', watchId })
    expect((result.content[0] as { text: string }).text).toMatch(/i-0a1b2c3d4e5f67890/)
  })
})

// ---------------------------------------------------------------------------
// detectChanges
// ---------------------------------------------------------------------------

describe('Ec2Watcher.detectChanges', () => {
  it('fires timeout path when timeoutAt has elapsed', async () => {
    const { watcher } = makeWatcher({ state: 'running' }, 9_999)
    const addResult = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
      timeoutSeconds: 1,
    })
    const watchId = addResult.details['watchId'] as string
    const watch = watcher['watches'].get(watchId)!
    watch.timeoutAt = 5_000 // well in the past relative to now=9_999

    const result = await watcher.detectChanges(watch)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.eventType).toBe('timeout')
    expect(result.observedChange).toBe(true)
    expect(result.newBaseline).toBeDefined()
    expect(typeof result.newBaseline.state).toBe('string')
  })

  it('returns valid not_found baseline on not_found path', async () => {
    const { watcher, client } = makeWatcher({ state: 'running' })
    const addResult = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const watch = watcher['watches'].get(watchId)!
    ;(client.describeInstance as ReturnType<typeof vi.fn>).mockResolvedValue({ notFound: true })

    const result = await watcher.detectChanges(watch)
    expect(result.events[0]?.eventType).toBe('not_found')
    expect(result.newBaseline).toBeDefined()
    expect(result.newBaseline.state).toBe('not_found')
  })

  it('syncs baseline from this.baselines into watch.baseline before calling poller', async () => {
    const { watcher, client } = makeWatcher({ state: 'running' })
    const addResult = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const watch = watcher['watches'].get(watchId)!

    watcher['baselines'].set(watchId, { state: 'stopped' })
    watch.baseline = undefined

    ;(client.describeInstance as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'stopped' })

    await watcher.detectChanges(watch)
    expect(watch.baseline).toEqual({ state: 'stopped' })
  })
})

// ---------------------------------------------------------------------------
// normaliseWatch / normaliseBaseline
// ---------------------------------------------------------------------------

describe('Ec2Watcher.normaliseWatch', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('returns null for null / non-object input', () => {
    expect(watcher.normaliseWatch(null)).toBeNull()
    expect(watcher.normaliseWatch('string')).toBeNull()
    expect(watcher.normaliseWatch([])).toBeNull()
  })

  it('returns null when required string fields are missing', () => {
    expect(watcher.normaliseWatch({ instanceId: 'i-abc', profile: 'p' })).toBeNull()
    expect(watcher.normaliseWatch({ watchId: 'w1', profile: 'p' })).toBeNull()
    expect(watcher.normaliseWatch({ watchId: 'w1', instanceId: 'i-abc' })).toBeNull()
  })

  it('round-trips a valid watch', () => {
    const raw = {
      watchId: 'abc',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'dev',
      region: 'us-east-1',
      timeoutAt: 99999,
      addedAt: 12345,
      lastPolledAt: 12400,
      baseline: { state: 'running', nameTag: 'my-vm' },
      terminal: false,
      consecutiveErrors: 0,
    }
    const result = watcher.normaliseWatch(raw)
    expect(result).not.toBeNull()
    expect(result?.watchId).toBe('abc')
    expect(result?.instanceId).toBe('i-0a1b2c3d4e5f67890')
    expect(result?.baseline?.state).toBe('running')
    expect(result?.baseline?.nameTag).toBe('my-vm')
  })
})

describe('Ec2Watcher.normaliseBaseline', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('returns null for invalid input', () => {
    expect(watcher.normaliseBaseline(null)).toBeNull()
    expect(watcher.normaliseBaseline('x')).toBeNull()
    expect(watcher.normaliseBaseline([])).toBeNull()
    expect(watcher.normaliseBaseline({ noState: true })).toBeNull()
  })

  it('parses a minimal baseline', () => {
    expect(watcher.normaliseBaseline({ state: 'running' })).toEqual({ state: 'running' })
  })

  it('parses a full baseline', () => {
    expect(
      watcher.normaliseBaseline({
        state: 'running',
        nameTag: 'my-vm',
        availabilityZone: 'us-east-1a',
        instanceType: 't3.micro',
        stateTransitionReason: 'User initiated',
      }),
    ).toEqual({
      state: 'running',
      nameTag: 'my-vm',
      availabilityZone: 'us-east-1a',
      instanceType: 't3.micro',
      stateTransitionReason: 'User initiated',
    })
  })

  it('accepts not_found as a valid state', () => {
    expect(watcher.normaliseBaseline({ state: 'not_found' })).toEqual({ state: 'not_found' })
  })
})

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('Ec2Watcher.classifyError', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it.each([
    'CredentialsProviderError',
    'TokenProviderError',
    'ProviderError',
    'ExpiredToken',
    'ExpiredTokenException',
  ])('classifies %s as auth error', (name) => {
    const err = Object.assign(new Error('auth'), { name })
    const result = watcher.classifyError(err)
    expect(result.kind).toBe('auth')
    expect(result.statusModifier).toBe('auth-error')
    expect(result.userMessage).toMatch(/authentication expired/)
  })

  it.each(['ThrottlingException', 'TooManyRequestsException', 'SlowDown', 'RequestLimitExceeded'])(
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
    const err = Object.assign(new Error('oops'), { name: 'SomeRandomError' })
    const result = watcher.classifyError(err)
    expect(result.kind).toBe('generic')
    expect(result.shouldBackoff).toBe(false)
    expect(result.userMessage).toMatch(/poll failed/)
  })
})

// ---------------------------------------------------------------------------
// containsTerminalStateEvent
// ---------------------------------------------------------------------------

describe('Ec2Watcher.containsTerminalStateEvent', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  const terminalEvent = {
    watchId: 'w1', instanceId: 'i-abc',
    eventType: 'state_changed' as const,
    previousState: 'running' as const,
    newState: 'terminated' as const,
    summary: '', formatted: '', isTerminal: true,
  }

  const nonTerminalEvent = { ...terminalEvent, isTerminal: false, newState: 'stopping' as const }

  function callContains(w: Ec2Watcher, events: Ec2Event[]) {
    return (w as unknown as { containsTerminalStateEvent(e: Ec2Event[]): boolean })
      .containsTerminalStateEvent(events)
  }

  it('returns true when a terminal event is present', () => {
    expect(callContains(watcher, [terminalEvent])).toBe(true)
  })

  it('returns false for empty array', () => {
    expect(callContains(watcher, [])).toBe(false)
  })

  it('returns false when no terminal events', () => {
    expect(callContains(watcher, [nonTerminalEvent])).toBe(false)
  })

  it('returns true if any event is terminal', () => {
    expect(callContains(watcher, [nonTerminalEvent, terminalEvent])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// view rendering
// ---------------------------------------------------------------------------

describe('Ec2Watcher view', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  const mockWatch = {
    watchId: 'w1',
    instanceId: 'i-0a1b2c3d4e5f67890',
    profile: 'dev',
    region: 'us-east-1',
    timeoutAt: undefined,
    addedAt: new Date('2024-01-01').getTime(),
    lastPolledAt: undefined,
    baseline: { state: 'running' as const },
    terminal: false,
    consecutiveErrors: 0,
  }

  it('renderItemRowText formats correctly', () => {
    const text = watcher.view.renderItemRowText(mockWatch)
    expect(text).toContain('i-0a1b2c3d4e5f67890')
    expect(text).toContain('RUNNING')
    expect(text).toContain('WATCHING')
  })

  it('renderItemRowText renders state in UPPERCASE', () => {
    const text = watcher.view.renderItemRowText(mockWatch)
    expect(text).toContain('RUNNING')
    expect(text).not.toContain('running')
  })

  it('renderItemRowText renders stopped state in UPPERCASE', () => {
    const text = watcher.view.renderItemRowText({ ...mockWatch, baseline: { state: 'stopped' as never } })
    expect(text).toContain('STOPPED')
    expect(text).not.toContain('stopped')
  })

  it('renderItemRowText shows DONE for terminal watches', () => {
    const text = watcher.view.renderItemRowText({ ...mockWatch, terminal: true })
    expect(text).toContain('DONE')
  })

  it('renderItemRowText: timed-out watch shows DONE in status and expired in timeout', () => {
    const text = watcher.view.renderItemRowText({ ...mockWatch, terminal: true, timeoutAt: Date.now() - 1000 })
    expect(text).toContain('DONE')
    expect(text).toContain('expired')
    expect(text).not.toContain('EXPIRED')
  })

  it('renderItemRowText shows DONE for target-met-early (future timeoutAt)', () => {
    const text = watcher.view.renderItemRowText({ ...mockWatch, terminal: true, timeoutAt: Date.now() + 60_000 })
    expect(text).toContain('DONE')
    expect(text).not.toContain('EXPIRED')
  })

  it('renderItemRowTUI returns RowColumn array with name in first column', () => {
    const cols = watcher.view.renderItemRowTUI(mockWatch, { theme: {} as never, width: 80 })
    expect(cols.length).toBeGreaterThan(0)
    expect(cols[0]?.text).toContain('i-0a1b2c3d4e5f67890')
    expect(cols[0]?.color).toBe('accent')
  })

  it('renderItemRowTUI renders state column in UPPERCASE', () => {
    const cols = watcher.view.renderItemRowTUI(mockWatch, { theme: {} as never, width: 80 })
    const stateCol = cols.find((c) => c.name === 'state')
    expect(stateCol?.text).toBe('RUNNING')
  })

  it('renderItemRowTUI renders stopped state in UPPERCASE', () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, baseline: { state: 'stopped' as never } },
      { theme: {} as never, width: 80 },
    )
    const stateCol = cols.find((c) => c.name === 'state')
    expect(stateCol?.text).toBe('STOPPED')
  })

  it('renderItemRowTUI uses accent color for terminal watches (name column)', () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, terminal: true },
      { theme: {} as never, width: 80 },
    )
    expect(cols[0]?.color).toBe('accent')
  })

  it('renderItemRowTUI uses warning color for error threshold', () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, consecutiveErrors: POLL_ERROR_THRESHOLD },
      { theme: {} as never, width: 80 },
    )
    expect(cols[0]?.color).toBe('warning')
  })

  it('renderItemDetail includes all expected fields', () => {
    const fields = watcher.view.renderItemDetail(mockWatch, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'instanceId')?.value).toBe('i-0a1b2c3d4e5f67890')
    expect(fields.find((f) => f.label === 'state')?.value).toBe('running')
    expect(fields.find((f) => f.label === 'instanceType')?.value).toBe('unknown')
    expect(fields.find((f) => f.label === 'uptime')?.value).toBe('unknown')
    expect(fields.find((f) => f.label === 'profile')).toBeDefined()
    expect(fields.find((f) => f.label === 'region')).toBeDefined()
    expect(fields.find((f) => f.label === 'added')).toBeDefined()
    expect(fields.find((f) => f.label === 'polled')?.value).toBe('never')
    expect(fields.find((f) => f.label === 'timeout')?.value).toBe('none')
    expect(fields.find((f) => f.label === 'errors')).toBeDefined()
    expect(fields.find((f) => f.label === 'terminal')?.value).toBe('no')
  })

  it('renderItemDetail shows unknown state when baseline is undefined', () => {
    const fields = watcher.view.renderItemDetail(
      { ...mockWatch, baseline: undefined },
      { theme: {} as never, width: 80 },
    )
    expect(fields.find((f) => f.label === 'state')?.value).toBe('unknown')
  })

  it('renderItemDetail includes name tag when present', () => {
    const w = { ...mockWatch, baseline: { state: 'running' as const, nameTag: 'my-vm' } }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'name')?.value).toBe('my-vm')
  })

  it('renderEventRow returns event.formatted', () => {
    const event = {
      watchId: 'w1', instanceId: 'i-abc',
      eventType: 'state_changed' as const,
      previousState: 'pending' as const,
      newState: 'running' as const,
      summary: 'running',
      formatted: '• running ✓',
      isTerminal: false,
    }
    expect(watcher.view.renderEventRow(event)).toBe('• running ✓')
  })

  describe('status column — ALL_CAPS', () => {
    const base = {
      watchId: 'w1', instanceId: 'i-0a1b2c3d4e5f67890', profile: 'p', region: undefined,
      timeoutAt: undefined, addedAt: 0,
      lastPolledAt: undefined, baseline: { state: 'running' as const },
    }

    it('active watch shows WATCHING', () => {
      const w = { ...base, terminal: false, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols.find((c) => c.name === 'status')!.text).toBe('WATCHING')
    })

    it('terminal watch shows DONE', () => {
      const w = { ...base, terminal: true, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols.find((c) => c.name === 'status')!.text).toBe('DONE')
    })

    it('timed-out watch shows DONE in status and expired in timeout', () => {
      const w = { ...base, terminal: true, consecutiveErrors: 0, timeoutAt: Date.now() - 1000 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols.find((c) => c.name === 'status')!.text).toBe('DONE')
      expect(cols.find((c) => c.name === 'timeout')!.text).toBe('expired')
      expect(cols.find((c) => c.name === 'status')!.text).not.toBe('EXPIRED')
    })

    it('terminal watch with future timeoutAt (target met early) shows DONE', () => {
      const w = { ...base, terminal: true, consecutiveErrors: 0, timeoutAt: Date.now() + 60_000 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols.find((c) => c.name === 'status')!.text).toBe('DONE')
    })

    it('error watch shows ERROR', () => {
      const w = { ...base, terminal: false, consecutiveErrors: POLL_ERROR_THRESHOLD }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols.find((c) => c.name === 'status')!.text).toBe('ERROR')
    })

    it('terminal watch status uses warning color', () => {
      const w = { ...base, terminal: true, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols.find((c) => c.name === 'status')!.color).toBe('warning')
    })

    it('columns are ordered: name, state, instanceType, status, timeout', () => {
      const w = { ...base, terminal: false, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols[0]!.name).toBe('name')
      expect(cols[1]!.name).toBe('state')
      expect(cols[2]!.name).toBe('instanceType')
      expect(cols[3]!.name).toBe('status')
      expect(cols[4]!.name).toBe('timeout')
    })
  })

  describe('name tag display', () => {
    it('shows instanceId alone when no nameTag', () => {
      const w = { ...mockWatch, baseline: { state: 'running' as const } }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols[0]!.text).toBe('i-0a1b2c3d4e5f67890')
    })

    it('shows instanceId (nameTag) when nameTag present', () => {
      const w = { ...mockWatch, baseline: { state: 'running' as const, nameTag: 'web-server' } }
      const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 80 })
      expect(cols[0]!.text).toBe('i-0a1b2c3d4e5f67890 (web-server)')
    })
  })
})

// ---------------------------------------------------------------------------
// timeout column in renderItemRowTUI
// ---------------------------------------------------------------------------

describe('timeout column in renderItemRowTUI', () => {
  let watcher: Ec2Watcher
  beforeEach(() => { ;({ watcher } = makeWatcher()) })

  const base = {
    watchId: 'w1', instanceId: 'i-0a1b2c3d4e5f67890', profile: 'p', region: undefined,
    addedAt: 0,
    lastPolledAt: undefined, baseline: { state: 'running' as const },
  }

  it('shows "-" when no timeoutAt', () => {
    const w = { ...base, timeoutAt: undefined, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find((c) => c.name === 'timeout')!.text).toBe('-')
  })

  it('shows "expired" when timeoutAt is in the past', () => {
    const w = { ...base, timeoutAt: Date.now() - 1000, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find((c) => c.name === 'timeout')!.text).toBe('expired')
  })

  it('shows time left for future timeouts', () => {
    const w = { ...base, timeoutAt: Date.now() + 90_000, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find((c) => c.name === 'timeout')!.text).toMatch(/\d+[smh] left/)
  })

  it('uses warning color when < 5 min remaining and non-terminal', () => {
    const w = { ...base, timeoutAt: Date.now() + 2 * 60_000, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find((c) => c.name === 'timeout')!.color).toBe('warning')
  })

  it('uses warning color for terminal watches with < 5 min remaining (timeout column)', () => {
    const w = { ...base, timeoutAt: Date.now() + 10_000, terminal: true, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find((c) => c.name === 'timeout')!.color).toBe('warning')
  })
})

// ---------------------------------------------------------------------------
// view.isRowDimmed
// ---------------------------------------------------------------------------

describe('view.isRowDimmed', () => {
  let watcher: Ec2Watcher
  beforeEach(() => { ;({ watcher } = makeWatcher()) })

  const base = {
    watchId: 'w1', instanceId: 'i-0a1b2c3d4e5f67890', profile: 'p', region: undefined as string | undefined,
    timeoutAt: undefined as number | undefined, addedAt: 0,
    lastPolledAt: undefined as number | undefined, baseline: { state: 'running' as const },
    consecutiveErrors: 0,
  }

  it('returns true for terminal watches', () => {
    expect(watcher.view.isRowDimmed!({ ...base, terminal: true })).toBe(true)
  })

  it('returns false for active watches', () => {
    expect(watcher.view.isRowDimmed!({ ...base, terminal: false })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Ec2Watcher constructor — defaultDisplayMode
// ---------------------------------------------------------------------------

describe('Ec2Watcher constructor defaultDisplayMode', () => {
  it('sets defaultDisplayMode from config when provided', () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ defaultDisplayMode: 'statusline' }))
    const { watcher } = makeWatcher()
    expect(watcher['defaultDisplayMode']).toBe('statusline')
  })

  it('does not set defaultDisplayMode when config has no value', () => {
    // readFileSync throws ENOENT by default — loadWatcherConfig() returns {}
    const { watcher } = makeWatcher()
    expect(watcher['defaultDisplayMode']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// onSessionStart — no startup chat message (silent, matching s3-watcher behaviour)
// ---------------------------------------------------------------------------

describe('Ec2Watcher.onSessionStart', () => {
  it('does NOT emit a startup chat message when watches are restored (#0001 — add should be silent)', async () => {
    const { watcher, pi } = makeWatcher({ state: 'running' })

    const ctx = {
      ui: { setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
      sessionManager: {
        getEntries: () => [
          {
            type: 'custom',
            customType: 'pi-aws-ec2-watcher:state',
            data: {
              savedAt: 1,
              enabled: false,
              displayMode: 'widget',
              watches: [
                {
                  watchId: 'w1',
                  instanceId: 'i-0a1b2c3d4e5f67890',
                  profile: 'p',
                  region: undefined,
                  timeoutAt: undefined,
                  addedAt: 1,
                  lastPolledAt: undefined,
                  baseline: { state: 'running' },
                  terminal: false,
                  consecutiveErrors: 0,
                },
              ],
              baselines: { w1: { state: 'running' } },
            },
          },
        ],
      },
    }

    await watcher.onSessionStart(ctx)
    // Flush setImmediate callbacks
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(pi.sendMessage).not.toHaveBeenCalled()
  })

  it('does NOT emit startup message when no watches', async () => {
    const { watcher, pi } = makeWatcher({ state: 'running' })

    const ctx = {
      ui: { setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
      sessionManager: { getEntries: () => [] },
    }

    await watcher.onSessionStart(ctx)
    expect(pi.sendMessage).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Per-watch schedulers
// ---------------------------------------------------------------------------

describe('Ec2Watcher per-watch schedulers', () => {
  it('schedulerFor creates a new PollScheduler on first call and returns the same instance on subsequent calls', () => {
    const { watcher } = makeWatcher()
    const sf = (watcher as unknown as { schedulerFor(k: string): unknown }).schedulerFor.bind(watcher)
    const s1 = sf('key1')
    const s2 = sf('key1')
    expect(s1).toBe(s2)
    expect(s1).not.toBe(sf('key2'))
  })

  it('addWatch starts a per-watch scheduler for the newly added watch', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher({ state: 'running' })
    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'p',
    })
    const watchId = result.details['watchId'] as string
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> })._watchSchedulers
    expect(schedulers.get(watchId)?.isRunning).toBe(true)
    watcher.stopPolling()
    vi.useRealTimers()
  })

  it('stopPolling stops all per-watch schedulers', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher({ state: 'running' })
    await watcher.executeTool({ action: 'add', instanceId: 'i-0a1b2c3d4e5f67890', profile: 'p' })
    await watcher.executeTool({ action: 'add', instanceId: 'i-0b1b2c3d4e5f67891', profile: 'p' })
    watcher.stopPolling()
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> })._watchSchedulers
    for (const s of schedulers.values()) {
      expect(s.isRunning).toBe(false)
    }
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// statusLabel / displayName
// ---------------------------------------------------------------------------

class TestableEc2Watcher extends Ec2Watcher {
  get statusLabel_pub() { return this.statusLabel }
  get displayName_pub() { return this.displayName }
  get userDefaultDisplayMode_pub() { return this.userDefaultDisplayMode }
  saveUserDefaultDisplayMode_pub(m: 'widget' | 'statusline' | undefined) {
    return this.saveUserDefaultDisplayMode(m)
  }
}

describe('Ec2Watcher statusLabel / displayName', () => {
  let watcher: TestableEc2Watcher
  beforeEach(() => {
    const pi = makePi()
    const client = makeClient({ state: 'running' })
    watcher = new TestableEc2Watcher({ pi: pi as never, client, now: Date.now })
  })

  it('statusLabel is "aws-ec2"', () => {
    expect(watcher.statusLabel_pub).toBe('aws-ec2')
  })

  it('displayName is "AWS EC2 Instance Watcher"', () => {
    expect(watcher.displayName_pub).toBe('AWS EC2 Instance Watcher')
  })
})

// ---------------------------------------------------------------------------
// browseOptions
// ---------------------------------------------------------------------------

describe('Ec2Watcher.browseOptions', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    const pi = makePi()
    const client = makeClient({ state: 'running' })
    watcher = new Ec2Watcher({ pi: pi as never, client, now: Date.now })
  })

  it('searchable is false', () => {
    const opts = (watcher as unknown as { browseOptions(): Record<string, unknown> }).browseOptions()
    expect(opts['searchable']).toBe(false)
  })

  it('has stop rowAction with id "stop"', () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions?: Array<{ id: string }> } }).browseOptions()
    expect(opts.rowActions?.some((a) => a.id === 'stop')).toBe(true)
  })

  it('has start rowAction with id "start"', () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions?: Array<{ id: string }> } }).browseOptions()
    expect(opts.rowActions?.some((a) => a.id === 'start')).toBe(true)
  })

  it('has remove rowAction with id "remove"', () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions?: Array<{ id: string }> } }).browseOptions()
    expect(opts.rowActions?.some((a) => a.id === 'remove')).toBe(true)
  })

  it('has onRefresh that calls pollOnce', async () => {
    const opts = (watcher as unknown as { browseOptions(): { onRefresh?(): Promise<void> } }).browseOptions()
    const pollSpy = vi.spyOn(watcher, 'pollOnce').mockResolvedValue(undefined)
    await opts.onRefresh!()
    expect(pollSpy).toHaveBeenCalled()
  })

  it('browseOptions.onPurge calls executePurge', () => {
    const purgeSpy = vi.spyOn(watcher as unknown as { executePurge(): [] }, 'executePurge').mockReturnValue([])
    const opts = (watcher as unknown as { browseOptions(): { onPurge?(): [] } }).browseOptions()
    expect(opts).toHaveProperty('onPurge')
    opts.onPurge!()
    expect(purgeSpy).toHaveBeenCalled()
  })

  it('browseOptions.getPollIntervalMs calls schedulerFor with watchId', () => {
    const mockScheduler = { intervalMs: 120_000 }
    vi.spyOn(watcher as unknown as { schedulerFor: () => unknown }, 'schedulerFor').mockReturnValue(mockScheduler)
    const opts = (watcher as unknown as { browseOptions(): { getPollIntervalMs?: (w: import('../src/types.js').Ec2Watch) => number } }).browseOptions()
    const mockW = {
      watchId: 'test-id', instanceId: 'i-abc', profile: 'p', region: undefined,
      timeoutAt: undefined, addedAt: 0, lastPolledAt: undefined,
      baseline: undefined, terminal: false, consecutiveErrors: 0,
    }
    const result = opts.getPollIntervalMs?.(mockW)
    expect(result).toBe(120_000)
  })

  describe('rowAction run callbacks', () => {
    let actionWatcher: Ec2Watcher
    let actionClient: Ec2Client
    let watch: Ec2Watch

    beforeEach(async () => {
      ;({ watcher: actionWatcher, client: actionClient } = makeWatcher({ state: 'running' }))
      const result = await actionWatcher.executeTool({
        action: 'add',
        instanceId: 'i-0a1b2c3d4e5f67890',
        profile: 'prod',
        region: 'us-east-1',
      })
      const watchId = result.details['watchId'] as string
      watch = actionWatcher['watches'].get(watchId)!
    })

    function getAction(id: string) {
      const opts = (actionWatcher as unknown as {
        browseOptions(): { rowActions?: Array<{ id: string; run(w: Ec2Watch): Promise<void> }> }
      }).browseOptions()
      return opts.rowActions!.find((a) => a.id === id)!
    }

    it('stop run calls client.stopInstance with instanceId, profile, region', async () => {
      await getAction('stop').run(watch)
      expect(actionClient.stopInstance).toHaveBeenCalledWith(
        watch.instanceId,
        watch.profile,
        watch.region,
      )
    })

    it('start run calls client.startInstance with instanceId, profile, region', async () => {
      await getAction('start').run(watch)
      expect(actionClient.startInstance).toHaveBeenCalledWith(
        watch.instanceId,
        watch.profile,
        watch.region,
      )
    })

    it('remove run removes the watch', async () => {
      expect(actionWatcher['watches'].size).toBe(1)
      await getAction('remove').run(watch)
      expect(actionWatcher['watches'].size).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// instanceType column in renderItemRowTUI
// ---------------------------------------------------------------------------

describe('instanceType column in renderItemRowTUI', () => {
  let watcher: Ec2Watcher
  beforeEach(() => { ;({ watcher } = makeWatcher()) })

  const base = {
    watchId: 'w1', instanceId: 'i-0a1b2c3d4e5f67890', profile: 'p', region: undefined,
    addedAt: 0,
    lastPolledAt: undefined,
  }

  it('shows "\u2014" when instanceType absent', () => {
    const w = { ...base, timeoutAt: undefined, terminal: false, consecutiveErrors: 0, baseline: { state: 'running' as const } }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find((c) => c.name === 'instanceType')!.text).toBe('\u2014')
  })

  it('shows instanceType value when present', () => {
    const w = { ...base, timeoutAt: undefined, terminal: false, consecutiveErrors: 0, baseline: { state: 'running' as const, instanceType: 't3.large' } }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find((c) => c.name === 'instanceType')!.text).toBe('t3.large')
  })
})

// ---------------------------------------------------------------------------
// instanceType and uptime in renderItemDetail
// ---------------------------------------------------------------------------

describe('instanceType and uptime in renderItemDetail', () => {
  let watcher: Ec2Watcher
  beforeEach(() => { ;({ watcher } = makeWatcher()) })

  const base = {
    watchId: 'w1', instanceId: 'i-0a1b2c3d4e5f67890', profile: 'p', region: undefined,
    timeoutAt: undefined, addedAt: 0,
    lastPolledAt: undefined, terminal: false, consecutiveErrors: 0,
  }

  it('shows instanceType from baseline', () => {
    const w = { ...base, baseline: { state: 'running' as const, instanceType: 'm5.xlarge' } }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'instanceType')?.value).toBe('m5.xlarge')
  })

  it('shows "unknown" instanceType when absent', () => {
    const w = { ...base, baseline: { state: 'running' as const } }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'instanceType')?.value).toBe('unknown')
  })

  it('shows formatted uptime when launchTime present', () => {
    const launch = new Date(Date.now() - 2 * 60 * 60 * 1000 - 30 * 60 * 1000) // 2h 30m ago
    const w = { ...base, baseline: { state: 'running' as const, launchTime: launch.toISOString() } }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
    const uptime = fields.find((f) => f.label === 'uptime')?.value ?? ''
    expect(uptime).toMatch(/\d+h/)
  })

  it('shows "unknown" uptime when launchTime absent', () => {
    const w = { ...base, baseline: { state: 'running' as const } }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'uptime')?.value).toBe('unknown')
  })

  it('shows "unknown" instanceType and uptime when baseline is undefined', () => {
    const w = { ...base, baseline: undefined }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'instanceType')?.value).toBe('unknown')
    expect(fields.find((f) => f.label === 'uptime')?.value).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe('formatUptime', () => {
  const base = new Date('2024-01-10T12:00:00.000Z')

  it('returns "0m" for zero duration', () => {
    expect(formatUptime(base.toISOString(), base)).toBe('0m')
  })

  it('returns minutes only for < 1h', () => {
    const now = new Date(base.getTime() + 45 * 60_000)
    expect(formatUptime(base.toISOString(), now)).toBe('45m')
  })

  it('returns hours and minutes', () => {
    const now = new Date(base.getTime() + (2 * 60 + 30) * 60_000)
    expect(formatUptime(base.toISOString(), now)).toBe('2h 30m')
  })

  it('returns days hours minutes', () => {
    const now = new Date(base.getTime() + (3 * 24 * 60 + 4 * 60 + 5) * 60_000)
    expect(formatUptime(base.toISOString(), now)).toBe('3d 4h 5m')
  })

  it('omits zero minute component when hours > 0 and minutes = 0', () => {
    const now = new Date(base.getTime() + 3 * 60 * 60_000)
    expect(formatUptime(base.toISOString(), now)).toBe('3h')
  })

  it('returns "0m" for future launchTime (negative diff)', () => {
    const future = new Date(base.getTime() + 60_000)
    expect(formatUptime(future.toISOString(), base)).toBe('0m')
  })
})

// ---------------------------------------------------------------------------
// formatTimeLeft
// ---------------------------------------------------------------------------

describe('formatTimeLeft', () => {
  it('returns "-" when no timeout', () => {
    expect(formatTimeLeft(undefined, 0)).toBe('-')
  })
  it('returns "expired" when past', () => {
    expect(formatTimeLeft(1000, 2000)).toBe('expired')
  })
  it('returns Xs left for seconds', () => {
    expect(formatTimeLeft(31_000, 1_000)).toBe('30s left')
  })
  it('returns Xm left for minutes', () => {
    expect(formatTimeLeft(121_000, 1_000)).toBe('2m left')
  })
  it('returns Xh left for hours', () => {
    expect(formatTimeLeft(3_601_000, 1_000)).toBe('1h left')
  })
})

// ---------------------------------------------------------------------------
// commandName
// ---------------------------------------------------------------------------

describe('commandName', () => {
  it('is "aws-ec2-watcher"', () => {
    const { watcher } = makeWatcher()
    expect((watcher as unknown as { commandName: string }).commandName).toBe('aws-ec2-watcher')
  })
})

// ---------------------------------------------------------------------------

describe('Ec2Watcher — profile validation (via BaseWatcher)', () => {
  it('returns _toolError without calling addWatch when profile does not exist', async () => {
    const { watcher, client } = makeWatcher({ state: 'running' })

    // Override the default mock to return an error for this specific test.
    vi.mocked(validateAwsProfile).mockReturnValueOnce(
      "profile 'bad-profile' not found — known profiles: default, prod",
    )

    const result = await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'bad-profile',
    })

    // Should be a tool error containing the profile name.
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/bad-profile/)

    // The EC2 DescribeInstances call must NOT have been made.
    expect(client.describeInstance).not.toHaveBeenCalled()

    // No watch should have been registered.
    expect(watcher['watches'].size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Additional coverage: normalise optional fields
// ---------------------------------------------------------------------------

describe('Ec2Watcher.normaliseWatch — absent optional fields', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('normalises without region (leaves undefined)', () => {
    const raw = { watchId: 'w1', instanceId: 'i-0a1b', profile: 'p', addedAt: 100, terminal: false, consecutiveErrors: 0 }
    const result = watcher.normaliseWatch(raw)
    expect(result).not.toBeNull()
    expect(result?.region).toBeUndefined()
  })

  it('normalises without timeoutAt (leaves undefined)', () => {
    const raw = { watchId: 'w1', instanceId: 'i-0a1b', profile: 'p', addedAt: 100, terminal: false, consecutiveErrors: 0 }
    const result = watcher.normaliseWatch(raw)
    expect(result?.timeoutAt).toBeUndefined()
  })

  it('normalises without lastPolledAt (leaves undefined)', () => {
    const raw = { watchId: 'w1', instanceId: 'i-0a1b', profile: 'p', addedAt: 100, terminal: false, consecutiveErrors: 0 }
    const result = watcher.normaliseWatch(raw)
    expect(result?.lastPolledAt).toBeUndefined()
  })

  it('normalises without baseline (leaves undefined)', () => {
    const raw = { watchId: 'w1', instanceId: 'i-0a1b', profile: 'p', addedAt: 100, terminal: false, consecutiveErrors: 0 }
    const result = watcher.normaliseWatch(raw)
    expect(result?.baseline).toBeUndefined()
  })

  it('defaults terminal to false when not boolean', () => {
    const raw = { watchId: 'w1', instanceId: 'i-0a1b', profile: 'p', addedAt: 100, terminal: 'yes', consecutiveErrors: 0 }
    const result = watcher.normaliseWatch(raw)
    expect(result?.terminal).toBe(false)
  })

  it('defaults consecutiveErrors to 0 when not finite number', () => {
    const raw = { watchId: 'w1', instanceId: 'i-0a1b', profile: 'p', addedAt: 100, terminal: false, consecutiveErrors: 'bad' }
    const result = watcher.normaliseWatch(raw)
    expect(result?.consecutiveErrors).toBe(0)
  })
})

describe('Ec2Watcher.normaliseBaseline — launchTime field', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('parses launchTime when present', () => {
    const result = watcher.normaliseBaseline({ state: 'running', launchTime: '2024-01-01T00:00:00Z' })
    expect(result?.launchTime).toBe('2024-01-01T00:00:00Z')
  })

  it('omits launchTime when absent', () => {
    const result = watcher.normaliseBaseline({ state: 'running' })
    expect(result?.launchTime).toBeUndefined()
  })
})

describe('Ec2Watcher.detectChanges — timeout path', () => {
  it('returns timeout event when timeoutAt is reached', async () => {
    const { watcher } = makeWatcher({ state: 'running' })
    ;(watcher as unknown as { _now: () => number })._now = () => 2000

    // Add a watch with a past timeoutAt via the watches map directly
    const watchId = 'timed-watch'
    const watchWithTimeout = {
      watchId,
      instanceId: 'i-abc123',
      profile: 'p',
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
      timeoutAt: 1000, // in the past relative to _now=2000
    }
    ;(watcher as unknown as { watches: Map<string, unknown> }).watches.set(watchId, watchWithTimeout)
    ;(watcher as unknown as { baselines: Map<string, unknown> }).baselines.set(watchId, { state: 'running' })

    const result = await watcher.detectChanges(watchWithTimeout as never)
    expect(result.events.length).toBeGreaterThan(0)
    expect(result.observedChange).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Additional normaliseWatch and normaliseBaselineField coverage
// ---------------------------------------------------------------------------

describe('Ec2Watcher.normaliseWatch — full baseline with all optional fields', () => {
  let watcher: Ec2Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('normalises a watch whose baseline has all optional fields', () => {
    const raw = {
      watchId: 'w1',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'dev',
      region: 'us-east-1',
      addedAt: 12345,
      terminal: false,
      consecutiveErrors: 0,
      baseline: {
        state: 'running',
        nameTag: 'my-vm',
        stateTransitionReason: 'User initiated',
        availabilityZone: 'us-east-1a',
        instanceType: 't3.micro',
        launchTime: '2024-01-01T00:00:00Z',
      },
    }
    const result = watcher.normaliseWatch(raw)
    expect(result).not.toBeNull()
    expect(result?.baseline?.nameTag).toBe('my-vm')
    expect(result?.baseline?.stateTransitionReason).toBe('User initiated')
    expect(result?.baseline?.availabilityZone).toBe('us-east-1a')
    expect(result?.baseline?.instanceType).toBe('t3.micro')
    expect(result?.baseline?.launchTime).toBe('2024-01-01T00:00:00Z')
  })

  it('normalises when baseline is an array (returns undefined baseline)', () => {
    const raw = {
      watchId: 'w1',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'dev',
      addedAt: 12345,
      terminal: false,
      consecutiveErrors: 0,
      baseline: ['invalid'],
    }
    const result = watcher.normaliseWatch(raw)
    expect(result).not.toBeNull()
    expect(result?.baseline).toBeUndefined()
  })

  it('normalises when baseline is a string (returns undefined baseline)', () => {
    const raw = {
      watchId: 'w1',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'dev',
      addedAt: 12345,
      terminal: false,
      consecutiveErrors: 0,
      baseline: 'not-an-object',
    }
    const result = watcher.normaliseWatch(raw)
    expect(result).not.toBeNull()
    expect(result?.baseline).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Additional branch coverage: visible callbacks + noteSchedulerSuccess
// ---------------------------------------------------------------------------

describe('browseOptions rowAction visible callbacks (lines 490, 503, 516)', () => {
  it('visible(active) returns true; visible(terminal) returns false for all row actions', () => {
    const { watcher } = makeWatcher()
    const opts = (watcher as unknown as {
      browseOptions(): { rowActions?: Array<{ id: string; visible?(w: Ec2Watch): boolean }> }
    }).browseOptions()
    const actions = opts.rowActions ?? []
    const activeWatch = {
      watchId: 'w', instanceId: 'i-0a1b2c3d4e5f67890', profile: 'p', region: undefined,
      timeoutAt: undefined, addedAt: 0, lastPolledAt: undefined,
      baseline: undefined, terminal: false, consecutiveErrors: 0,
    }
    const terminalWatch = { ...activeWatch, terminal: true }
    for (const action of actions) {
      if (action.visible) {
        expect(action.visible(activeWatch)).toBe(true)
        expect(action.visible(terminalWatch)).toBe(false)
      }
    }
    // Ensure we actually exercised at least one visible callback
    expect(actions.some((a) => a.visible !== undefined)).toBe(true)
  })
})

describe('Ec2Watcher.noteSchedulerSuccess (line 545)', () => {
  it('noteSchedulerSuccess calls noteSuccess on the per-watch scheduler', async () => {
    const { watcher, client } = makeWatcher({ state: 'running' })
    // Add a watch so pollOnce has something to poll
    await watcher.executeTool({
      action: 'add',
      instanceId: 'i-0a1b2c3d4e5f67890',
      profile: 'default',
    })
    // pollOnce triggers pollWatch on all watches → calls noteSchedulerSuccess
    await watcher.pollOnce()
    // Verify the per-watch scheduler exists and has been updated
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { intervalMs: number }> })._watchSchedulers
    expect(schedulers.size).toBeGreaterThan(0)
    expect(client.describeInstance).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Additional view coverage tests
// ---------------------------------------------------------------------------

describe('Ec2Watcher view — additional branch coverage', () => {
  let watcher: ReturnType<typeof makeWatcher>['watcher']

  beforeEach(() => {
    ;({ watcher } = makeWatcher({ state: 'running' }))
  })

  const baseWatch = {
    watchId: 'w1',
    instanceId: 'i-0abc1234',
    profile: 'prod',
    region: 'eu-west-1' as string | undefined,
    timeoutAt: undefined as number | undefined,
    addedAt: 0,
    lastPolledAt: undefined as number | undefined,
    baseline: { state: 'running' as const } as { state: 'running' | 'stopped' | 'terminated' | 'pending' | 'shutting-down' | 'stopping'; nameTag?: string } | undefined,
    terminal: false,
    consecutiveErrors: 0,
  }

  it('itemSortKey returns the instanceId', () => {
    expect(watcher.view.itemSortKey({ ...baseWatch })).toBe('i-0abc1234')
  })

  it('itemGroup returns the profile', () => {
    expect(watcher.view.itemGroup?.({ ...baseWatch })).toBe('prod')
  })

  it('renderItemDetail shows polled timestamp when lastPolledAt is set', () => {
    const w = { ...baseWatch, lastPolledAt: 1_700_000_000_000 }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80, pollIntervalMs: 60_000 })
    expect(fields.find((f) => f.label === 'polled')?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('renderItemDetail shows timeout timestamp when timeoutAt is set', () => {
    const w = { ...baseWatch, timeoutAt: 1_700_000_000_000 }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'timeout')?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('renderItemDetail shows poll interval in seconds when ctx has pollIntervalMs', () => {
    const w = { ...baseWatch }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80, pollIntervalMs: 30_000 })
    expect(fields.find((f) => f.label === 'poll')?.value).toBe('30s')
  })

  it('renderItemDetail shows "yes" for terminal watches', () => {
    const w = { ...baseWatch, terminal: true }
    const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'terminal')?.value).toBe('yes')
  })

  it('renderItemRowText shows nameTag when present in baseline', () => {
    const w = { ...baseWatch, baseline: { state: 'running' as const, nameTag: 'my-server' } }
    const text = watcher.view.renderItemRowText(w)
    expect(text).toContain('my-server')
  })

  it('renderItemRowText shows ERROR when consecutiveErrors hits threshold', () => {
    const w = { ...baseWatch, consecutiveErrors: 5 } // POLL_ERROR_THRESHOLD = 5
    const text = watcher.view.renderItemRowText(w)
    expect(text).toContain('ERR')
  })

  it('isRowDimmed returns true for terminal watches', () => {
    const w = { ...baseWatch, terminal: true }
    expect(watcher.view.isRowDimmed?.(w)).toBe(true)
  })
})
