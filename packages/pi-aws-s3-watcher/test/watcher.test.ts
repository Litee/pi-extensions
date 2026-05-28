/**
 * Unit tests for S3Watcher (extends BaseWatcher).
 *
 * Uses a MockS3Client stub. BaseWatcher lifecycle is exercised via
 * executeTool + pollOnce rather than full register() integration.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RowColumn } from 'pi-watcher-core/base-watcher-types'
import type { HeadObjectResult, S3Client } from '../src/s3-client.js'
import { formatTimeLeft, S3Watcher } from '../src/watcher.js'
import { POLL_ERROR_THRESHOLD } from 'pi-watcher-core/base-watcher'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(() => true),
}))
import * as configModule from '../src/config.js'
import { loadConfig } from '../src/config.js'

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

function makeClient(resp: HeadObjectResult | Error): S3Client {
  const head = vi.fn()
  if (resp instanceof Error) head.mockRejectedValue(resp)
  else head.mockResolvedValue(resp)
  return { headObject: head }
}

function makeWatcher(resp: HeadObjectResult | Error = { exists: false }, nowMs?: number) {
  const pi = makePi()
  const client = makeClient(resp)
  const now = nowMs !== undefined ? () => nowMs : Date.now
  const watcher = new S3Watcher({ pi: pi as never, client, now })
  return { watcher, pi, client }
}

// ---------------------------------------------------------------------------
// addWatch
// ---------------------------------------------------------------------------

describe('S3Watcher.addWatch', () => {
  it('adds a watch with valid params and seeds baseline', async () => {
    const { watcher } = makeWatcher({ exists: false })
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://my-bucket/my/key',
      target: 'exists',
      profile: 'default',
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(typeof watchId).toBe('string')
    expect(watcher['watches'].has(watchId)).toBe(true)
    expect(watcher['baselines'].has(watchId)).toBe(true)
    expect(watcher['baselines'].get(watchId)).toEqual({ exists: false })
  })

  it('returns error when uri is missing', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      target: 'exists',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/requires 'uri'/)
  })

  it('returns error when uri is not s3://', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      uri: 'https://example.com/x',
      target: 'exists',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/s3:\/\//)
  })

  it('returns error when target is missing', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/target to be/)
  })

  it('returns error when profile is missing', async () => {
    const { watcher } = makeWatcher()
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'exists',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/requires a profile/)
  })

  it("returns error when target='updated' and object is absent", async () => {
    const { watcher } = makeWatcher({ exists: false })
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'updated',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/requires the object to exist/)
    expect(watcher['watches'].size).toBe(0)
  })

  it("accepts target='updated' when object is present", async () => {
    const { watcher } = makeWatcher({ exists: true, etag: '"abc"', contentLength: 10 })
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'updated',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(watcher['watches'].get(watchId)?.target).toBe('updated')
  })

  it('soft-fails on seed error — watch still added with undefined baseline', async () => {
    const err = Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' })
    const { watcher } = makeWatcher(err)
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'exists',
      profile: 'p',
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(watcher['watches'].get(watchId)?.baseline).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toMatch(/seeding failed/)
  })

  it('applies timeoutSeconds correctly', async () => {
    const { watcher } = makeWatcher({ exists: false }, 10_000)
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'exists',
      profile: 'p',
      timeoutSeconds: 60,
    })
    expect(result.details['ok']).toBe(true)
    const watchId = result.details['watchId'] as string
    expect(watcher['watches'].get(watchId)?.timeoutAt).toBe(10_000 + 60_000)
  })

  it('caps timeoutSeconds at MAX_TIMEOUT_SECONDS', async () => {
    const { watcher } = makeWatcher({ exists: false }, 10_000)
    const MAX = 72 * 60 * 60
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'exists',
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
      uri: 's3://b/k',
      target: 'exists',
      profile: 'p',
      timeoutSeconds: -5,
    })
    expect(result.details['ok']).toBe(false)
    expect((result.content[0] as { text: string }).text).toMatch(/timeoutSeconds/)
  })
})

// ---------------------------------------------------------------------------
// removeWatch
// ---------------------------------------------------------------------------

describe('S3Watcher.removeWatch', () => {
  it('returns correct remaining count in message using base class format', async () => {
    const { watcher } = makeWatcher({ exists: false })
    // Add two watches
    const r1 = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k1',
      target: 'exists',
      profile: 'p',
    })
    await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k2',
      target: 'exists',
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
})

// ---------------------------------------------------------------------------
// detectChanges
// ---------------------------------------------------------------------------

describe('S3Watcher.detectChanges', () => {
  it('fires timeout path when timeoutAt has elapsed', async () => {
    const { watcher } = makeWatcher({ exists: false }, 9_999)
    // Add a watch with a timeout that's already past
    const addResult = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'exists',
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
  })

  it('syncs baseline from this.baselines into watch.baseline before calling poller', async () => {
    const { watcher, client } = makeWatcher({ exists: false })
    const addResult = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'exists',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const watch = watcher['watches'].get(watchId)!

    // Overwrite baseline in the map but not on the watch object
    watcher['baselines'].set(watchId, { exists: true, etag: '"xyz"' })
    watch.baseline = undefined

    // Mock client returning the same state
    ;(client.headObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      etag: '"xyz"',
    })

    await watcher.detectChanges(watch)
    // The baseline was synced into watch.baseline before calling pollerDetectChanges
    expect(watch.baseline).toEqual({ exists: true, etag: '"xyz"' })
  })
})

// ---------------------------------------------------------------------------
// normaliseWatch / normaliseBaseline
// ---------------------------------------------------------------------------

describe('S3Watcher.normaliseWatch', () => {
  let watcher: S3Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('returns null for null / non-object input', () => {
    expect(watcher.normaliseWatch(null)).toBeNull()
    expect(watcher.normaliseWatch('string')).toBeNull()
    expect(watcher.normaliseWatch([])).toBeNull()
  })

  it('returns null when required string fields are missing', () => {
    expect(watcher.normaliseWatch({ bucket: 'b', key: 'k', profile: 'p', target: 'exists' })).toBeNull()
    expect(watcher.normaliseWatch({ watchId: 'w1', key: 'k', profile: 'p', target: 'exists' })).toBeNull()
  })

  it('returns null for invalid target', () => {
    expect(
      watcher.normaliseWatch({ watchId: 'w1', bucket: 'b', key: 'k', profile: 'p', target: 'invalid' }),
    ).toBeNull()
  })

  it('round-trips a valid watch', () => {
    const raw = {
      watchId: 'abc',
      bucket: 'my-bucket',
      key: 'path/to/file',
      profile: 'dev',
      region: 'us-east-1',
      target: 'exists',
      timeoutAt: 99999,
      addedAt: 12345,
      lastPolledAt: 12400,
      baseline: { exists: true, etag: '"e"', contentLength: 42 },
      terminal: false,
      consecutiveErrors: 0,
    }
    const result = watcher.normaliseWatch(raw)
    expect(result).not.toBeNull()
    expect(result?.watchId).toBe('abc')
    expect(result?.baseline).toEqual({ exists: true, etag: '"e"', contentLength: 42 })
  })
})

describe('S3Watcher.normaliseBaseline', () => {
  let watcher: S3Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  it('returns null for invalid input', () => {
    expect(watcher.normaliseBaseline(null)).toBeNull()
    expect(watcher.normaliseBaseline('x')).toBeNull()
    expect(watcher.normaliseBaseline([])).toBeNull()
    expect(watcher.normaliseBaseline({ noExists: true })).toBeNull()
  })

  it('parses a minimal baseline', () => {
    expect(watcher.normaliseBaseline({ exists: false })).toEqual({ exists: false })
  })

  it('parses a full baseline', () => {
    expect(
      watcher.normaliseBaseline({ exists: true, etag: '"abc"', contentLength: 100 }),
    ).toEqual({ exists: true, etag: '"abc"', contentLength: 100 })
  })

  it('drops non-finite contentLength', () => {
    expect(
      watcher.normaliseBaseline({ exists: true, contentLength: Infinity }),
    ).toEqual({ exists: true })
  })
})

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('S3Watcher.classifyError', () => {
  let watcher: S3Watcher

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
// view rendering
// ---------------------------------------------------------------------------

describe('S3Watcher view', () => {
  let watcher: S3Watcher

  beforeEach(() => {
    ;({ watcher } = makeWatcher())
  })

  const mockWatch = {
    watchId: 'w1',
    bucket: 'my-bucket',
    key: 'some/key.txt',
    profile: 'dev',
    region: 'us-east-1',
    target: 'exists' as const,
    timeoutAt: undefined,
    addedAt: new Date('2024-01-01').getTime(),
    lastPolledAt: undefined,
    baseline: { exists: false },
    terminal: false,
    consecutiveErrors: 0,
  }

  it('renderItemRowText formats correctly', () => {
    const text = watcher.view.renderItemRowText(mockWatch)
    expect(text).toBe('s3://my-bucket/some/key.txt  WATCHING  -  creation')
  })

  it('renderItemRowText shows ✓ done for terminal watches', () => {
    const text = watcher.view.renderItemRowText({ ...mockWatch, terminal: true })
    expect(text).toContain('DONE')
  })

  it('renderItemRowTUI returns RowColumn array with URI in first column', () => {
    const cols = watcher.view.renderItemRowTUI(mockWatch, { theme: {} as never, width: 80 })
    expect(cols.length).toBeGreaterThan(0)
    expect(cols[0]?.text).toContain('s3://my-bucket/some/key.txt')
    expect(cols[0]?.color).toBe('accent')
  })

  it('renderItemRowTUI uses muted color for terminal watches', () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, terminal: true },
      { theme: {} as never, width: 80 },
    )
    expect(cols[0]?.color).toBe('muted')
  })

  it('renderItemRowTUI uses warning color for error threshold', () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, consecutiveErrors: 5 },
      { theme: {} as never, width: 80 },
    )
    expect(cols[0]?.color).toBe('warning')
  })

  it('renderItemDetail includes all expected fields as DetailField objects', () => {
    const fields = watcher.view.renderItemDetail(mockWatch, { theme: {} as never, width: 80 })
    expect(fields.find((f) => f.label === 'uri')?.value).toBe('s3://my-bucket/some/key.txt')
    expect(fields.find((f) => f.label === 'target')).toBeDefined()
    expect(fields.find((f) => f.label === 'profile')).toBeDefined()
    expect(fields.find((f) => f.label === 'region')).toBeDefined()
    expect(fields.find((f) => f.label === 'state')).toBeDefined()
    expect(fields.find((f) => f.label === 'added')).toBeDefined()
    expect(fields.find((f) => f.label === 'polled')).toBeDefined()
    expect(fields.find((f) => f.label === 'timeout')).toBeDefined()
    expect(fields.find((f) => f.label === 'errors')).toBeDefined()
    expect(fields.find((f) => f.label === 'terminal')).toBeDefined()
    // state should be 'absent' since baseline.exists=false
    expect(fields.find((f) => f.label === 'state')?.value).toBe('absent')
    expect(fields.find((f) => f.label === 'polled')?.value).toBe('never')
    expect(fields.find((f) => f.label === 'timeout')?.value).toBe('none')
  })

  it('renderItemDetail shows unknown state when baseline is undefined', () => {
    const fields = watcher.view.renderItemDetail(
      { ...mockWatch, baseline: undefined },
      { theme: {} as never, width: 80 },
    )
    expect(fields.find((f) => f.label === 'state')?.value).toBe('unknown')
  })

  it('renderEventRow returns event.formatted', () => {
    const event = {
      watchId: 'w1',
      bucket: 'b',
      key: 'k',
      eventType: 'exists' as const,
      summary: 's3://b/k now exists',
      formatted: '• s3://b/k now exists ✓',
    }
    expect(watcher.view.renderEventRow(event)).toBe('• s3://b/k now exists ✓')
  })

  describe('status column — ALL_CAPS', () => {
    const stubTheme = { fg: (_: string, t: string) => t, bold: (t: string) => t }
    const base = {
      watchId: 'w1', bucket: 'b', key: 'k', profile: 'p', region: undefined,
      target: 'exists' as const, timeoutAt: undefined, addedAt: 0,
      lastPolledAt: undefined, baseline: undefined,
    }

    it('active watch shows WATCHING', () => {
      const w = { ...base, terminal: false, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: stubTheme as never, width: 80 })
      expect(cols.find(c => c.name === 'status')!.text).toBe('WATCHING')
    })

    it('terminal watch shows DONE', () => {
      const w = { ...base, terminal: true, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: stubTheme as never, width: 80 })
      expect(cols.find(c => c.name === 'status')!.text).toBe('DONE')
    })

    it('error watch shows ERROR', () => {
      const w = { ...base, terminal: false, consecutiveErrors: POLL_ERROR_THRESHOLD }
      const cols = watcher.view.renderItemRowTUI(w, { theme: stubTheme as never, width: 80 })
      expect(cols.find(c => c.name === 'status')!.text).toBe('ERROR')
    })

    it('active watch status uses warning color', () => {
      const w = { ...base, terminal: false, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: stubTheme as never, width: 80 })
      expect(cols.find(c => c.name === 'status')!.color).toBe('warning')
    })

    it('terminal watch status uses muted color', () => {
      const w = { ...base, terminal: true, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: stubTheme as never, width: 80 })
      expect(cols.find(c => c.name === 'status')!.color).toBe('muted')
    })

    it('error watch status uses error color', () => {
      const w = { ...base, terminal: false, consecutiveErrors: POLL_ERROR_THRESHOLD }
      const cols = watcher.view.renderItemRowTUI(w, { theme: stubTheme as never, width: 80 })
      expect(cols.find(c => c.name === 'status')!.color).toBe('error')
    })

    it('columns are ordered: uri, status, timeout, target', () => {
      const w = { ...base, terminal: false, consecutiveErrors: 0 }
      const cols = watcher.view.renderItemRowTUI(w, { theme: stubTheme as never, width: 80 })
      expect(cols[0]!.name).toBe('uri')
      expect(cols[1]!.name).toBe('status')
      expect(cols[2]!.name).toBe('timeout')
      expect(cols[3]!.name).toBe('target')
    })
  })

  // ── displayTarget mapping (Change 3) ───────────────────────────────────────

  describe('displayTarget mapping', () => {
    const baseW = {
      watchId: 'w1', bucket: 'b', key: 'k', profile: 'p', region: undefined as string | undefined,
      timeoutAt: undefined as number | undefined, addedAt: 0,
      lastPolledAt: undefined as number | undefined, baseline: undefined as import('../src/types.js').S3Baseline | undefined,
    }

    it('maps exists → creation in renderItemRowText', () => {
      const w = { ...baseW, target: 'exists' as const, terminal: false, consecutiveErrors: 0 }
      expect(watcher.view.renderItemRowText(w)).toContain('creation')
      expect(watcher.view.renderItemRowText(w)).not.toContain('exists')
    })
    it('maps removed → deletion in renderItemRowText', () => {
      const w = { ...baseW, target: 'removed' as const, terminal: false, consecutiveErrors: 0 }
      expect(watcher.view.renderItemRowText(w)).toContain('deletion')
    })
    it('keeps updated unchanged in renderItemRowText', () => {
      const w = { ...baseW, target: 'updated' as const, terminal: false, consecutiveErrors: 0 }
      expect(watcher.view.renderItemRowText(w)).toContain('updated')
    })
    it('renderItemDetail target field shows creation not exists', () => {
      const w = { ...baseW, target: 'exists' as const, terminal: false, consecutiveErrors: 0 }
      const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
      const targetField = fields.find(f => f.label === 'target')!
      expect(targetField.value).toBe('creation')
    })
    it('renderItemDetail target field shows deletion for removed', () => {
      const w = { ...baseW, target: 'removed' as const, terminal: false, consecutiveErrors: 0 }
      const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
      expect(fields.find(f => f.label === 'target')!.value).toBe('deletion')
    })
    it('renderItemDetail target field shows updated unchanged', () => {
      const w = { ...baseW, target: 'updated' as const, terminal: false, consecutiveErrors: 0 }
      const fields = watcher.view.renderItemDetail(w, { theme: {} as never, width: 80 })
      expect(fields.find(f => f.label === 'target')!.value).toBe('updated')
    })
  })

  // ── Poll interval (Change 4) ───────────────────────────────────────────────

  describe('poll interval in detail pane', () => {
    const baseW = {
      watchId: 'w1', bucket: 'b', key: 'k', profile: 'p', region: undefined as string | undefined,
      target: 'exists' as const, timeoutAt: undefined as number | undefined, addedAt: 0,
      lastPolledAt: undefined as number | undefined, baseline: undefined as import('../src/types.js').S3Baseline | undefined,
      terminal: false, consecutiveErrors: 0,
    }

    it('renderItemDetail includes poll field when pollIntervalMs provided', () => {
      const fields = watcher.view.renderItemDetail(baseW, { theme: {} as never, width: 80, pollIntervalMs: 60_000 })
      const poll = fields.find(f => f.label === 'poll')!
      expect(poll).toBeDefined()
      expect(poll.value).toBe('60s')
    })
    it('renderItemDetail shows "unknown" when pollIntervalMs not provided', () => {
      const fields = watcher.view.renderItemDetail(baseW, { theme: {} as never, width: 80 })
      const poll = fields.find(f => f.label === 'poll')
      if (poll) expect(poll.value).toBe('unknown')
    })
    it('browseOptions.getPollIntervalMs calls schedulerFor with watchId', () => {
      const mockScheduler = { intervalMs: 120_000 }
      vi.spyOn(watcher as unknown as { schedulerFor: () => unknown }, 'schedulerFor').mockReturnValue(mockScheduler)
      const opts = (watcher as unknown as { browseOptions: () => { getPollIntervalMs?: (w: import('../src/types.js').S3Watch) => number } }).browseOptions()
      const result = opts.getPollIntervalMs?.({ ...baseW, watchId: 'test-id' })
      expect(result).toBe(120_000)
    })
  })
})

// ---------------------------------------------------------------------------
// S3Watcher constructor — defaultDisplayMode
// ---------------------------------------------------------------------------

describe('S3Watcher constructor defaultDisplayMode', () => {
  it('sets defaultDisplayMode from loadConfig when provided', () => {
    vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: 'statusline' })
    const { watcher } = makeWatcher()
    expect(watcher['defaultDisplayMode']).toBe('statusline')
  })

  it('does not set defaultDisplayMode when config has no value', () => {
    vi.mocked(loadConfig).mockReturnValue({})
    const { watcher } = makeWatcher()
    expect(watcher['defaultDisplayMode']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// onSessionStart — config integration
// ---------------------------------------------------------------------------

describe('S3Watcher.onSessionStart config integration', () => {
  it('applies defaultDisplayMode=statusline from config when no persisted state', async () => {
    vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: 'statusline' })
    const { watcher } = makeWatcher()
    const setStatus = vi.fn()
    const ctx = {
      ui: { setStatus, theme: { fg: (_c: string, t: string) => t } },
      sessionManager: { getEntries: () => [] },
    }
    await watcher.onSessionStart(ctx)
    expect(watcher['displayMode']).toBe('statusline')
  })

  it('persisted displayMode overrides user config', async () => {
    vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: 'statusline' })
    const { watcher } = makeWatcher()
    const ctx = {
      ui: { setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
      sessionManager: {
        getEntries: () => [
          {
            type: 'custom',
            customType: 'pi-aws-s3-watcher:state',
            data: {
              savedAt: 1,
              paused: false,
              watches: [],
              baselines: {},
              enabled: false,
              displayMode: 'widget',
            },
          },
        ],
      },
    }
    await watcher.onSessionStart(ctx)
    expect(watcher['displayMode']).toBe('widget')
  })

  it('does not change displayMode when config has no defaultDisplayMode', async () => {
    vi.mocked(loadConfig).mockReturnValue({})
    const { watcher } = makeWatcher()
    const ctx = {
      ui: { setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
      sessionManager: { getEntries: () => [] },
    }
    await watcher.onSessionStart(ctx)
    expect(watcher['displayMode']).toBe('widget')
  })
})

// ---------------------------------------------------------------------------
// Per-watch schedulers (Fix 3)
// ---------------------------------------------------------------------------

describe('S3Watcher per-watch schedulers', () => {
  it('schedulerFor creates a new PollScheduler on first call and returns the same instance on subsequent calls', () => {
    const { watcher } = makeWatcher()
    // Access protected method via bracket notation
    const sf = (watcher as unknown as { schedulerFor(k: string): unknown }).schedulerFor
      .bind(watcher)
    const s1 = sf('key1')
    const s2 = sf('key1')
    expect(s1).toBe(s2)
    expect(s1).not.toBe(sf('key2'))
  })

  it('addWatch starts a per-watch scheduler for the newly added watch when not paused', async () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher({ exists: false })
    const result = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'exists',
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
    const { watcher } = makeWatcher({ exists: false })
    await watcher.executeTool({ action: 'add', uri: 's3://b/k1', target: 'exists', profile: 'p' })
    await watcher.executeTool({ action: 'add', uri: 's3://b/k2', target: 'exists', profile: 'p' })
    watcher.stopPolling()
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> })._watchSchedulers
    for (const s of schedulers.values()) {
      expect(s.isRunning).toBe(false)
    }
    vi.useRealTimers()
  })

  it('startPolling creates a per-watch scheduler only for non-terminal watches', () => {
    vi.useFakeTimers()
    const { watcher } = makeWatcher({ exists: false })
    // Manually seed watches (bypass addWatch scheduler start)
    ;(watcher as unknown as { paused: boolean }).paused = true
    watcher['watches'].set('w1', {
      watchId: 'w1', bucket: 'b', key: 'k1', profile: 'p', region: undefined, timeoutAt: undefined,
      target: 'exists' as const, addedAt: 0, lastPolledAt: undefined,
      baseline: undefined, terminal: false, consecutiveErrors: 0,
    })
    watcher['watches'].set('w2', {
      watchId: 'w2', bucket: 'b', key: 'k2', profile: 'p', region: undefined, timeoutAt: undefined,
      target: 'exists' as const, addedAt: 0, lastPolledAt: undefined,
      baseline: undefined, terminal: true, consecutiveErrors: 0,
    })
    ;(watcher as unknown as { paused: boolean }).paused = false
    watcher.startPolling()
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> })._watchSchedulers
    expect(schedulers.get('w1')?.isRunning).toBe(true)   // active watch: scheduler started
    expect(schedulers.get('w2')).toBeUndefined()           // terminal watch: no scheduler created
    watcher.stopPolling()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// statusLabel / displayName
// ---------------------------------------------------------------------------

class TestableS3Watcher extends S3Watcher {
  get statusLabel_pub() { return this.statusLabel }
  get displayName_pub() { return this.displayName }
  get userDefaultDisplayMode_pub() { return this.userDefaultDisplayMode }
  saveUserDefaultDisplayMode_pub(m: 'widget' | 'statusline' | undefined) {
    return this.saveUserDefaultDisplayMode(m)
  }
}

describe('S3Watcher statusLabel / displayName', () => {
  let watcher: TestableS3Watcher
  beforeEach(() => {
    const pi = makePi()
    const client = makeClient({ exists: false })
    watcher = new TestableS3Watcher({ pi: pi as never, client, now: Date.now })
  })

  it('statusLabel is "aws-s3"', () => {
    expect(watcher.statusLabel_pub).toBe('aws-s3')
  })

  it('displayName is "AWS S3 Watcher"', () => {
    expect(watcher.displayName_pub).toBe('AWS S3 Watcher')
  })
})

// ---------------------------------------------------------------------------
// S3Watcher view.compressColumns
// ---------------------------------------------------------------------------

describe('S3Watcher view.compressColumns', () => {
  it('is defined', () => {
    const { watcher } = makeWatcher()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(watcher.view.compressColumns).toBeDefined()
  })

  it('compresses URI column using compressS3Uri when URI is too long', () => {
    const { watcher } = makeWatcher()
    const longKey = 'very/deeply/nested/path/segments/file.txt'
    const cols: RowColumn[] = [
      { name: 'uri', text: `s3://my-bucket/${longKey}` },
      { name: 'target', text: 'exists', width: 8 },
      { name: 'status', text: 'WATCHING', width: 10 },
    ]
    const totalWidth = 50
    const result = watcher.view.compressColumns!(cols, totalWidth)
    const uriCol = result.find(c => c.name === 'uri')!
    expect(uriCol.text.length).toBeLessThanOrEqual(totalWidth - 8 - 10 - 4) // minus fixed + separators
    expect(uriCol.text).toContain('my-bucket') // bucket preserved
  })

  it('leaves URI unchanged when it already fits', () => {
    const { watcher } = makeWatcher()
    const cols: RowColumn[] = [
      { name: 'uri', text: 's3://b/short.txt' },
      { name: 'target', text: 'exists', width: 8 },
      { name: 'status', text: 'WATCHING', width: 10 },
    ]
    const result = watcher.view.compressColumns!(cols, 80)
    expect(result.find(c => c.name === 'uri')!.text).toBe('s3://b/short.txt')
  })

  it('passes non-URI columns through unchanged', () => {
    const { watcher } = makeWatcher()
    const cols: RowColumn[] = [
      { name: 'uri', text: 's3://b/k' },
      { name: 'target', text: 'exists', width: 8 },
    ]
    const result = watcher.view.compressColumns!(cols, 80)
    expect(result.find(c => c.name === 'target')!.text).toBe('exists')
  })
})

// ---------------------------------------------------------------------------
// userDefaultDisplayMode — S3Watcher overrides
// ---------------------------------------------------------------------------

describe('userDefaultDisplayMode', () => {
  let testableWatcher: TestableS3Watcher

  beforeEach(() => {
    vi.mocked(configModule.loadConfig).mockReturnValue({})
    const pi = makePi()
    const client = makeClient({ exists: false })
    testableWatcher = new TestableS3Watcher({ pi: pi as never, client, now: Date.now })
  })

  it('reads from loadConfig', () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({ defaultDisplayMode: 'statusline' })
    expect(testableWatcher.userDefaultDisplayMode_pub).toBe('statusline')
  })

  it('returns undefined when config has no defaultDisplayMode', () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({})
    expect(testableWatcher.userDefaultDisplayMode_pub).toBeUndefined()
  })

  it('saveUserDefaultDisplayMode writes via saveConfig', () => {
    const spy = vi.spyOn(configModule, 'saveConfig')
    testableWatcher.saveUserDefaultDisplayMode_pub('widget')
    expect(spy).toHaveBeenCalledWith({ defaultDisplayMode: 'widget' })
  })

  it('saveUserDefaultDisplayMode(undefined) clears the preference', () => {
    const spy = vi.spyOn(configModule, 'saveConfig')
    testableWatcher.saveUserDefaultDisplayMode_pub(undefined)
    expect(spy).toHaveBeenCalledWith({ defaultDisplayMode: undefined })
  })
})

// ---------------------------------------------------------------------------
// browseOptions (Fix 3 + Fix 4)
// ---------------------------------------------------------------------------

describe('S3Watcher.browseOptions', () => {
  let watcher: S3Watcher

  beforeEach(() => {
    vi.mocked(configModule.loadConfig).mockReturnValue({})
    const pi = makePi()
    const client = makeClient({ exists: false })
    watcher = new S3Watcher({ pi: pi as never, client, now: Date.now })
  })

  it('searchable is false', () => {
    const opts = (watcher as unknown as { browseOptions(): Record<string, unknown> }).browseOptions()
    expect(opts['searchable']).toBe(false)
  })

  it('has remove rowAction with id "remove"', () => {
    const opts = (watcher as unknown as { browseOptions(): { rowActions?: Array<{ id: string }> } }).browseOptions()
    expect(opts.rowActions?.some(a => a.id === 'remove')).toBe(true)
  })

  it('has onRefresh that calls pollOnce', async () => {
    const opts = (watcher as unknown as { browseOptions(): { onRefresh?(): Promise<void> } }).browseOptions()
    const pollSpy = vi.spyOn(watcher, 'pollOnce').mockResolvedValue(undefined)
    await opts.onRefresh!()
    expect(pollSpy).toHaveBeenCalled()
  })

  it('remove action calls executeTool with remove action', async () => {
    const opts = (watcher as unknown as {
      browseOptions(): { rowActions?: Array<{ id: string; run(watch: import('../src/types.js').S3Watch, ctx: never): Promise<void> }> }
    }).browseOptions()
    const removeAction = opts.rowActions?.find(a => a.id === 'remove')
    expect(removeAction).toBeDefined()

    // Add a real watch so executeTool remove can find it
    const addResult = await watcher.executeTool({
      action: 'add',
      uri: 's3://b/k',
      target: 'exists',
      profile: 'p',
    })
    const watchId = addResult.details['watchId'] as string
    const watch = watcher['watches'].get(watchId)!

    const execSpy = vi.spyOn(watcher, 'executeTool').mockResolvedValue({
      content: [{ type: 'text', text: 'removed' }],
      details: { action: 'remove', ok: true },
    })
    await removeAction!.run(watch, {} as never)
    expect(execSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'remove' }))
  })

  it('browseOptions.onDrain calls executeDrain', () => {
    const drainSpy = vi.spyOn(watcher as unknown as { executeDrain(): [] }, 'executeDrain').mockReturnValue([])
    const opts = (watcher as unknown as { browseOptions(): { onDrain?(): [] } }).browseOptions()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(opts.onDrain).toBeDefined()
    opts.onDrain!()
    expect(drainSpy).toHaveBeenCalled()
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
// timeout column in renderItemRowTUI
// ---------------------------------------------------------------------------

describe('timeout column in renderItemRowTUI', () => {
  let watcher: S3Watcher
  beforeEach(() => { ;({ watcher } = makeWatcher()) })

  const base = {
    watchId: 'w1', bucket: 'b', key: 'k', profile: 'p', region: undefined,
    target: 'exists' as const, addedAt: 0,
    lastPolledAt: undefined, baseline: undefined,
  }

  it('includes timeout column named "timeout"', () => {
    const w = { ...base, timeoutAt: Date.now() + 300_000, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find(c => c.name === 'timeout')).toBeDefined()
  })

  it('shows "-" when no timeoutAt', () => {
    const w = { ...base, timeoutAt: undefined, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find(c => c.name === 'timeout')!.text).toBe('-')
  })

  it('shows "expired" when timeoutAt is in the past', () => {
    const w = { ...base, timeoutAt: Date.now() - 1000, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find(c => c.name === 'timeout')!.text).toBe('expired')
  })

  it('shows time left for future timeouts', () => {
    const w = { ...base, timeoutAt: Date.now() + 90_000, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    const timeout = cols.find(c => c.name === 'timeout')!
    expect(timeout.text).toMatch(/\d+[smh] left/)
  })

  it('uses warning color when < 5 min remaining and non-terminal', () => {
    const w = { ...base, timeoutAt: Date.now() + 2 * 60_000, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find(c => c.name === 'timeout')!.color).toBe('warning')
  })

  it('uses dim color when >= 5 min remaining and non-terminal', () => {
    const w = { ...base, timeoutAt: Date.now() + 10 * 60_000, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find(c => c.name === 'timeout')!.color).toBe('dim')
  })

  it('uses muted color for terminal watches regardless of timeout', () => {
    const w = { ...base, timeoutAt: Date.now() + 10_000, terminal: true, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find(c => c.name === 'timeout')!.color).toBe('muted')
  })

  it('timeout column width is 10', () => {
    const w = { ...base, timeoutAt: undefined, terminal: false, consecutiveErrors: 0 }
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 })
    expect(cols.find(c => c.name === 'timeout')!.width).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// commandName (Fix 2)
// ---------------------------------------------------------------------------

describe('commandName', () => {
  it('is "aws-s3-watcher"', () => {
    const { watcher } = makeWatcher()
    expect((watcher as unknown as { commandName: string }).commandName).toBe('aws-s3-watcher')
  })

  it('widget opts include commandName "aws-s3-watcher"', () => {
    const { watcher } = makeWatcher()
    const widgetOpts = (watcher['widget'] as { opts?: { commandName?: string; getPaused?: () => boolean } } | null | undefined)?.opts
    expect(widgetOpts?.commandName).toBe('aws-s3-watcher')
  })

  it('widget opts include getPaused function (Change 6)', () => {
    const { watcher } = makeWatcher()
    const widgetOpts = (watcher['widget'] as { opts?: { commandName?: string; getPaused?: () => boolean } } | null | undefined)?.opts
    expect(typeof widgetOpts?.getPaused).toBe('function')
    // initially not paused
    expect(widgetOpts?.getPaused?.()).toBe(false)
  })
})
