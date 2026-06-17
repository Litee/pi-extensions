/**
 * Ec2Watcher — pi-aws-ec2-watcher implemented via BaseWatcher.
 *
 * Wires EC2-specific snapshot / change-detection / rendering into the shared
 * BaseWatcher poll loop, persistence, and menu machinery.
 */

import { capTimeoutSeconds } from 'pi-watcher-core/timeout-cap'
export { formatTimeLeft } from 'pi-watcher-core/time-left'
import { formatTimeLeft } from 'pi-watcher-core/time-left'

import { AwsBaseWatcher, type AwsAddBaseParams } from 'pi-watcher-core/aws/base-watcher'
import { POLL_ERROR_THRESHOLD } from 'pi-watcher-core/base-watcher'
import { validateAwsProfile } from 'pi-watcher-core/validate-aws-profile'
import { createWatcherWidget } from 'pi-watcher-core/watcher-widget'
import type {
  BaseWatcherOptions,
  BrowseViewOptions,
  DetailField,
  RowColumn,
  ToolResult,
  WatcherView,
} from 'pi-watcher-core/base-watcher-types'

import { buildChangeChatMessage as formatChangeChatMessage } from './format.js'
import { buildTimeoutEvent, detectChanges as pollerDetectChanges, snapshotInstance } from './poller.js'
import type { Ec2Client } from './ec2-client.js'
import { MAX_TIMEOUT_SECONDS, Ec2WatcherParams } from './toolAction.js'
import type { Ec2Baseline, Ec2Event, Ec2Watch } from './types.js'
import { validateInstanceId, InstanceIdError } from './instanceId.js'

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Format uptime as `Xd Xh Xm` from an ISO 8601 launch-time string.
 */
export function formatUptime(launchTime: string, now: Date): string {
  const diffMs = now.getTime() - new Date(launchTime).getTime()
  if (diffMs < 0) return '0m'
  const totalMinutes = Math.floor(diffMs / 60_000)
  const d = Math.floor(totalMinutes / (60 * 24))
  const h = Math.floor((totalMinutes % (60 * 24)) / 60)
  const m = totalMinutes % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0 || parts.length === 0) parts.push(`${m}m`)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFiniteNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function normaliseBaselineField(raw: unknown): Ec2Baseline | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r['state'] !== 'string') return undefined
  const b: Ec2Baseline = { state: r['state'] as Ec2Baseline['state'] }
  if (typeof r['nameTag'] === 'string') b.nameTag = r['nameTag']
  if (typeof r['stateTransitionReason'] === 'string') b.stateTransitionReason = r['stateTransitionReason']
  if (typeof r['availabilityZone'] === 'string') b.availabilityZone = r['availabilityZone']
  if (typeof r['instanceType'] === 'string') b.instanceType = r['instanceType']
  if (typeof r['launchTime'] === 'string') b.launchTime = r['launchTime']
  return b
}

// ---------------------------------------------------------------------------
// Ec2Watcher
// ---------------------------------------------------------------------------

export class Ec2Watcher extends AwsBaseWatcher<Ec2Watch, Ec2Baseline, Ec2Event> {
  // ── Identity ───────────────────────────────────────────────────────────────
  readonly extensionName = 'pi-aws-ec2-watcher'
  readonly toolName = 'ec2_watcher'

  get itemSource() {
    return 'user-tool' as const
  }
  get hasWidget() {
    return true
  }

  // ── View ───────────────────────────────────────────────────────────────────
  readonly view: WatcherView<Ec2Watch, Ec2Event> = {
    noun: 'EC2 instance',
    nounPlural: 'EC2 instances',

    itemSortKey: (w) => w.instanceId,
    itemGroup: (w) => w.profile,

    renderItemRowText(w) {
      const state = (w.baseline?.state ?? '?').toUpperCase()
      const displayName = w.baseline?.nameTag
        ? `${w.instanceId} (${w.baseline.nameTag})`
        : w.instanceId
      const statusText = w.terminal ? 'DONE' : w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? 'ERROR' : 'WATCHING'
      const timeLeft = formatTimeLeft(w.timeoutAt, Date.now())
      return `${displayName}  ${state}  ${statusText}  ${timeLeft}`
    },

    renderItemRowTUI(w, _ctx): RowColumn[] {
      const displayName = w.baseline?.nameTag
        ? `${w.instanceId} (${w.baseline.nameTag})`
        : w.instanceId
      const nameColor = w.consecutiveErrors >= POLL_ERROR_THRESHOLD
        ? 'warning'
        : 'accent'
      const state = (w.baseline?.state ?? '?').toUpperCase()
      const instanceType = w.baseline?.instanceType ?? '—'
      const statusText = w.terminal ? 'DONE' : w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? 'ERROR' : 'WATCHING'
      const statusColor = w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? 'error' : 'warning'
      const timeLeft = formatTimeLeft(w.timeoutAt, Date.now())
      const timeColor: string = w.timeoutAt !== undefined && w.timeoutAt - Date.now() < 5 * 60 * 1000
        ? 'warning'
        : 'dim'
      return [
        { name: 'name',         text: displayName,  color: nameColor },
        { name: 'state',        text: state,         width: 13, color: 'dim' },
        { name: 'instanceType', text: instanceType,  width: 12, color: 'dim' },
        { name: 'status',       text: statusText,    width: 10, color: statusColor },
        { name: 'timeout',      text: timeLeft,      width: 10, color: timeColor },
      ]
    },

    renderItemDetail(w, ctx): DetailField[] {
      const state = w.baseline?.state ?? 'unknown'
      const uptime = w.baseline?.launchTime
        ? formatUptime(w.baseline.launchTime, new Date())
        : 'unknown'
      return [
        { label: 'instanceId',    value: w.instanceId },
        { label: 'name',          value: w.baseline?.nameTag ?? 'n/a' },
        { label: 'state',         value: state },
        { label: 'instanceType',  value: w.baseline?.instanceType ?? 'unknown' },
        { label: 'uptime',        value: uptime },
        { label: 'profile',       value: w.profile },
        { label: 'region',        value: w.region ?? 'default' },
        { label: 'added',         value: new Date(w.addedAt).toISOString() },
        { label: 'polled',        value: w.lastPolledAt !== undefined ? new Date(w.lastPolledAt).toISOString() : 'never' },
        { label: 'timeout',       value: w.timeoutAt !== undefined ? new Date(w.timeoutAt).toISOString() : 'none' },
        { label: 'poll',          value: ctx.pollIntervalMs !== undefined ? `${Math.round(ctx.pollIntervalMs / 1000)}s` : 'unknown' },
        { label: 'errors',        value: String(w.consecutiveErrors) },
        { label: 'terminal',      value: w.terminal ? 'yes' : 'no' },
      ]
    },

    renderEventRow(e) {
      return e.formatted
    },

    isRowDimmed: (w: Ec2Watch) => w.terminal,
  }

  // ── Tool metadata ──────────────────────────────────────────────────────────
  protected override get toolLabel(): string {
    return 'EC2 Instance Watcher'
  }

  protected override get toolDescription(): string {
    return (
      'Watch an AWS EC2 instance for state transitions (pending → running → stopping → stopped → terminated). ' +
      'Polls DescribeInstances at increasing intervals (60s → 15min) and fires a chat notification ' +
      'whenever the instance state changes. ' +
      'Actions: add, remove, list, status.'
    )
  }

  protected override toolParameters(): unknown {
    return Ec2WatcherParams
  }

  protected override get statusLabel(): string { return 'aws-ec2' }
  protected override get displayName(): string { return 'AWS EC2 Instance Watcher' }
  protected override get commandName(): string { return 'aws-ec2-watcher' }

  // ── Constructor ────────────────────────────────────────────────────────────────────────
  constructor(opts: BaseWatcherOptions & { client: Ec2Client }) {
    super({ ...opts, client: opts.client })
    this.widget = createWatcherWidget(opts.pi.events, this.view, {
      extensionName: this.extensionName,
      displayName: this.displayName,
      commandName: this.commandName,
      getWatches: () => Array.from(this.watches.values()),
    })
    const { defaultDisplayMode } = this.loadWatcherConfig()
    if (defaultDisplayMode !== undefined) {
      this.defaultDisplayMode = defaultDisplayMode
    }
  }

  // ── Domain hooks ───────────────────────────────────────────────────────────
  watchKey(watch: Ec2Watch): string {
    return watch.watchId
  }

  async snapshot(watch: Ec2Watch): Promise<Ec2Baseline> {
    const result = await snapshotInstance(this._client as Ec2Client, watch)
    if (result.notFound) return { state: 'not_found' }
    if (!result.state) throw new Error('DescribeInstances returned a response with no instance state')
    const baseline: Ec2Baseline = { state: result.state }
    if (result.nameTag !== undefined) baseline.nameTag = result.nameTag
    if (result.stateTransitionReason !== undefined) baseline.stateTransitionReason = result.stateTransitionReason
    if (result.availabilityZone !== undefined) baseline.availabilityZone = result.availabilityZone
    if (result.instanceType !== undefined) baseline.instanceType = result.instanceType
    if (result.launchTime !== undefined) baseline.launchTime = result.launchTime.toISOString()
    return baseline
  }

  async detectChanges(watch: Ec2Watch): Promise<{
    newBaseline: Ec2Baseline
    events: Ec2Event[]
    observedChange: boolean
  }> {
    const nowTs = this._now()
    if (watch.timeoutAt !== undefined && nowTs >= watch.timeoutAt) {
      return {
        newBaseline: this.baselines.get(this.watchKey(watch)) ?? { state: 'not_found' },
        events: [buildTimeoutEvent(watch)],
        observedChange: true,
      }
    }
    // Sync base-class baseline into watch record so poller can read it
    watch.baseline = this.baselines.get(this.watchKey(watch))
    return pollerDetectChanges(this._client as Ec2Client, watch)
  }

  normaliseWatch(raw: unknown): Ec2Watch | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    if (
      typeof r['watchId'] !== 'string' ||
      typeof r['instanceId'] !== 'string' ||
      typeof r['profile'] !== 'string'
    ) {
      return null
    }
    return {
      watchId: r['watchId'],
      instanceId: r['instanceId'],
      profile: r['profile'],
      region: typeof r['region'] === 'string' ? r['region'] : undefined,
      timeoutAt:
        typeof r['timeoutAt'] === 'number' && Number.isFinite(r['timeoutAt'])
          ? r['timeoutAt']
          : undefined,
      addedAt: toFiniteNumber(r['addedAt']),
      lastPolledAt: typeof r['lastPolledAt'] === 'number' ? r['lastPolledAt'] : undefined,
      baseline: normaliseBaselineField(r['baseline']),
      terminal: typeof r['terminal'] === 'boolean' ? r['terminal'] : false,
      consecutiveErrors:
        typeof r['consecutiveErrors'] === 'number' && Number.isFinite(r['consecutiveErrors'])
          ? r['consecutiveErrors']
          : 0,
    }
  }

  normaliseBaseline(raw: unknown): Ec2Baseline | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    if (typeof r['state'] !== 'string') return null
    const b: Ec2Baseline = { state: r['state'] as Ec2Baseline['state'] }
    if (typeof r['nameTag'] === 'string') b.nameTag = r['nameTag']
    if (typeof r['stateTransitionReason'] === 'string') b.stateTransitionReason = r['stateTransitionReason']
    if (typeof r['availabilityZone'] === 'string') b.availabilityZone = r['availabilityZone']
    if (typeof r['instanceType'] === 'string') b.instanceType = r['instanceType']
    if (typeof r['launchTime'] === 'string') b.launchTime = r['launchTime']
    return b
  }

  buildChangeChatMessage(events: readonly Ec2Event[], now: Date): string {
    return formatChangeChatMessage(Array.from(events), now)
  }

  protected override containsTerminalStateEvent(events: readonly Ec2Event[]): boolean {
    return events.some((e) => e.isTerminal)
  }

  // ── Add (AwsBaseWatcher hooks) ─────────────────────────────────────────────

  protected override parseAddParams(
    params: Record<string, unknown>,
    base: AwsAddBaseParams,
  ): Promise<{ watch: Ec2Watch } | { error: ToolResult }> {
    const instanceIdRaw = (typeof params['instanceId'] === 'string' ? params['instanceId'] : '').trim()
    if (!instanceIdRaw) {
      return Promise.resolve({ error: this._toolError("'add' requires 'instanceId' (e.g. i-0a1b2c3d4e5f67890).") })
    }

    let instanceId: string
    try {
      instanceId = validateInstanceId(instanceIdRaw)
    } catch (err) {
      const msg = err instanceof InstanceIdError ? err.message : String(err)
      return Promise.resolve({ error: this._toolError(msg) })
    }

    const existing = Array.from(this.watches.values()).find(w => w.instanceId === instanceId)
    if (existing) {
      return Promise.resolve({
        error: this._toolError(
          `instance '${instanceId}' is already being watched (watchId: ${existing.watchId}). Use action:'remove' first to replace it.`
        ),
      })
    }

    const profileError = validateAwsProfile(base.profile)
    if (profileError) return Promise.resolve({ error: this._toolError(profileError) })

    const requestedSeconds =
      typeof params['timeoutSeconds'] === 'number' ? params['timeoutSeconds'] : undefined
    if (requestedSeconds !== undefined) {
      if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
        return Promise.resolve({ error: this._toolError("'timeoutSeconds' must be a positive finite number.") })
      }
    }

    const { timeoutAt } = capTimeoutSeconds(requestedSeconds, MAX_TIMEOUT_SECONDS, this._now())

    const watch: Ec2Watch = {
      watchId: base.watchId,
      instanceId,
      profile: base.profile,
      region: base.region,
      timeoutAt,
      addedAt: this._now(),
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    }
    return Promise.resolve({ watch })
  }

  protected override validateAfterSeed(watch: Ec2Watch, baseline: Ec2Baseline): ToolResult | null {
    if (baseline.state === 'not_found') {
      return this._toolError(
        `instance '${watch.instanceId}' was not found in profile '${watch.profile}'${
          watch.region ? ` / region '${watch.region}'` : ''
        }. Verify the instance ID, profile, and region.`,
      )
    }
    return null
  }

  protected override describeAddedWatch(
    params: Record<string, unknown>,
    watch: Ec2Watch,
    baseline: Ec2Baseline | undefined,
    seedError: string | undefined,
  ): string {
    const requestedSeconds =
      typeof params['timeoutSeconds'] === 'number' ? params['timeoutSeconds'] : undefined
    const effectiveSeconds = Math.round(((watch.timeoutAt ?? watch.addedAt) - watch.addedAt) / 1000)
    const capped = requestedSeconds !== undefined && requestedSeconds > MAX_TIMEOUT_SECONDS
    const cappedNote = capped ? ` (capped from ${requestedSeconds}s)` : ''
    const timeoutLabel = ` timeout=${effectiveSeconds}s${cappedNote}`
    const stateLabel = baseline?.state ?? '?'
    return seedError
      ? `ec2-watcher: added watch ${watch.watchId} for ${watch.instanceId}${timeoutLabel}, but seeding failed (${seedError}). Will retry on next poll.`
      : `ec2-watcher: added watch ${watch.watchId} for ${watch.instanceId}${timeoutLabel} — state=${stateLabel}.`
  }

  override removeWatch(watch: Ec2Watch): Promise<ToolResult> {
    const remaining = this.watches.size - 1
    const message = `ec2-watcher: removed watch '${watch.watchId}' (${watch.instanceId}). ${remaining} watch(es) remaining.`
    return Promise.resolve({
      content: [{ type: 'text', text: message }],
      details: { action: 'remove', ok: true, watchKey: this.watchKey(watch) },
    })
  }

  protected override browseOptions(): Partial<BrowseViewOptions<Ec2Watch>> {
    return {
      searchable: false,
      rowActions: [
        {
          id: 'stop',
          label: 'Stop instance',
          keybind: 'x',
          visible: (w) => !w.terminal,
          run: async (watch) => {
            await (this._client as Ec2Client).stopInstance(
              watch.instanceId,
              watch.profile,
              watch.region,
            )
          },
        },
        {
          id: 'start',
          label: 'Start instance',
          keybind: 's',
          visible: (w) => !w.terminal,
          run: async (watch) => {
            await (this._client as Ec2Client).startInstance(
              watch.instanceId,
              watch.profile,
              watch.region,
            )
          },
        },
        {
          id: 'remove',
          label: 'Unwatch',
          keybind: 'd',
          visible: (w) => !w.terminal,
          run: async (watch) => {
            await this.executeTool({ action: 'remove', watchId: this.watchKey(watch) })
          },
        },
      ],
      onRefresh: () => this.pollOnce(),
      onPurge: () => this.executePurge(),
      getPollIntervalMs: (w: Ec2Watch) => this.schedulerFor(w.watchId).intervalMs,
    }
  }

  // ── Session start override ─────────────────────────────────────────────────

}
