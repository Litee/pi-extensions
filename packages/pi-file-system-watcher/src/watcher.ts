/**
 * FsWatcher — pi-file-system-watcher implemented via BaseWatcher.
 *
 * Wires filesystem-specific snapshot / change-detection / rendering into
 * the shared BaseWatcher poll loop, persistence, and menu machinery.
 *
 * Detection is poll-only (60 s base, 15 min cap). Push notifications via
 * fs.watch are not used — polling is the authoritative path.
 */

import { randomBytes } from "node:crypto";

import {
  BaseWatcher,
  BASE_POLL_MS,
  MAX_POLL_MS,
  POLL_ERROR_THRESHOLD,
} from "pi-watcher-core/base-watcher";
import { PollScheduler } from "pi-watcher-core/poll-scheduler";
import { createWatcherWidget } from "pi-watcher-core/watcher-widget";
import type { ClassifiedWatcherError } from "pi-watcher-core/classify-error";
import type {
  BaseWatcherOptions,
  BrowseViewOptions,
  DetailField,
  RowColumn,
  ToolResult,
  WatcherView,
} from "pi-watcher-core/base-watcher-types";

import { buildChangeChatMessage as formatChangeChatMessage } from "./format.js";
import { buildTimeoutEvent, detectChanges as pollerDetectChanges } from "./poller.js";
import { MAX_TIMEOUT_SECONDS, FsWatcherParams } from "./toolAction.js";
import type { FsBaseline, FsEvent, FsWatch, TargetCondition } from "./types.js";
import type { FsClient } from "./fs-client.js";

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Format the time remaining until a timeout, or special labels. */
export function formatTimeLeft(timeoutAt: number | undefined, now: number): string {
  if (timeoutAt === undefined) return "-";
  const remainingMs = timeoutAt - now;
  if (remainingMs <= 0) return "expired";
  const s = Math.ceil(remainingMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h >= 1) return `${h}h left`;
  if (m >= 1) return `${m}m left`;
  return `${rem}s left`;
}

/** Shorten a long path for display, truncating from the left: `…/b/c/d`. */
export function compressPath(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) return path;
  const ellipsis = "…";
  const keep = maxWidth - ellipsis.length;
  if (keep <= 0) return ellipsis;
  return ellipsis + path.slice(-keep);
}


const TARGETS: ReadonlySet<TargetCondition> = new Set<TargetCondition>([
  "creation",
  "modification",
  "deletion",
]);

// ---------------------------------------------------------------------------
// FsWatcher
// ---------------------------------------------------------------------------

export class FsWatcher extends BaseWatcher<FsWatch, FsBaseline, FsEvent> {
  // ── Identity ───────────────────────────────────────────────────────────────
  readonly extensionName = "pi-file-system-watcher";
  readonly toolName = "file_system_watcher";

  get itemSource() {
    return "user-tool" as const;
  }
  get hasWidget() {
    return true;
  }

  // ── View ───────────────────────────────────────────────────────────────────
  readonly view: WatcherView<FsWatch, FsEvent> = {
    noun: "path",
    nounPlural: "paths",

    itemSortKey: (w) => w.path,

    renderItemRowText(w) {
      const statusText = w.terminal ? "DONE" : w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? "ERROR" : "WATCHING";
      const timeLeft = formatTimeLeft(w.timeoutAt, Date.now());
      return `${w.path}  ${statusText}  ${timeLeft}  ${w.target}`;
    },

    renderItemRowTUI(w, _ctx): RowColumn[] {
      const pathColor = w.consecutiveErrors >= POLL_ERROR_THRESHOLD
        ? "warning"
        : "accent";
      const statusText = w.terminal ? "DONE" : w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? "ERROR" : "WATCHING";
      const statusColor =
        w.consecutiveErrors >= POLL_ERROR_THRESHOLD
          ? "error"
          : "warning";
      const timeLeft = formatTimeLeft(w.timeoutAt, Date.now());
      const timeColor: string =
        w.timeoutAt !== undefined && w.timeoutAt - Date.now() < 5 * 60 * 1000
          ? "warning"
          : "dim";
      return [
        { name: "path",    text: w.path,      color: pathColor },
        { name: "status",  text: statusText,  width: 10, color: statusColor },
        { name: "timeout", text: timeLeft,    width: 10, color: timeColor },
        { name: "target",  text: w.target, width: 10, color: "dim" },
      ];
    },

    renderItemDetail(w, ctx): DetailField[] {
      const state =
        w.baseline === undefined
          ? "unknown"
          : w.baseline.exists
            ? "present"
            : "absent";
      const mtimeStr =
        w.baseline?.mtimeNs !== undefined
          ? String(w.baseline.mtimeNs)
          : "n/a";
      const sizeStr =
        w.baseline?.size !== undefined ? `${w.baseline.size} bytes` : "n/a";
      return [
        { label: "path",     value: w.path },
        { label: "target",   value: w.target },
        { label: "state",    value: state },
        { label: "mtimeNs",  value: mtimeStr },
        { label: "size",     value: sizeStr },
        { label: "added",    value: new Date(w.addedAt).toISOString() },
        {
          label: "polled",
          value:
            w.lastPolledAt !== undefined
              ? new Date(w.lastPolledAt).toISOString()
              : "never",
        },
        {
          label: "timeout",
          value:
            w.timeoutAt !== undefined
              ? new Date(w.timeoutAt).toISOString()
              : "none",
        },
        {
          label: "poll",
          value:
            ctx.pollIntervalMs !== undefined
              ? `${Math.round(ctx.pollIntervalMs / 1000)}s`
              : "unknown",
        },
        { label: "errors",   value: String(w.consecutiveErrors) },
        { label: "terminal", value: w.terminal ? "yes" : "no" },
      ];
    },

    renderEventRow(e) {
      return e.formatted;
    },

    isRowDimmed: (w: FsWatch) => w.terminal,

    compressColumns(cols: RowColumn[], totalWidth: number): RowColumn[] {
      const SEP = 2;
      const fixedTotal = cols
        .filter((c) => c.width !== undefined)
        .reduce((sum, c) => sum + c.width!, 0);
      const separators = (cols.length - 1) * SEP;
      const pathWidth = totalWidth - fixedTotal - separators;

      return cols.map((c) => {
        if (c.name !== "path") return c;
        const compressed = compressPath(c.text, pathWidth);
        return compressed === c.text ? c : { ...c, text: compressed };
      });
    },
  };

  // ── Tool metadata ──────────────────────────────────────────────────────────
  protected override get toolLabel(): string {
    return "File System Watcher";
  }

  protected override get toolDescription(): string {
    return (
      "Watch a local filesystem path for existence, change, or removal. " +
      "Polls stat() at increasing intervals (60 s → 15 min) and fires " +
      "exactly one chat notification when the target condition is met " +
      "(or when an optional timeout elapses). " +
      "Actions: add, remove, list, status."
    );
  }

  protected override toolParameters(): unknown {
    return FsWatcherParams;
  }

  protected override get statusLabel(): string {
    return "fs";
  }
  protected override get displayName(): string {
    return "File System Watcher";
  }
  protected override get commandName(): string {
    return "file-system-watcher";
  }

  // ── Constructor ────────────────────────────────────────────────────────────
  constructor(opts: BaseWatcherOptions & { client: FsClient }) {
    super({ ...opts, client: opts.client });
    this.widget = createWatcherWidget(opts.pi.events, this.view, {
      extensionName: this.extensionName,
      displayName: this.displayName,
      commandName: this.commandName,
      getWatches: () => Array.from(this.watches.values()),
    });
    const { defaultDisplayMode } = this.loadWatcherConfig();
    if (defaultDisplayMode !== undefined) {
      this.defaultDisplayMode = defaultDisplayMode;
    }
  }

  // ── Domain hooks ───────────────────────────────────────────────────────────
  watchKey(watch: FsWatch): string {
    return watch.watchId;
  }

  async snapshot(watch: FsWatch): Promise<FsBaseline> {
    return (this._client as FsClient).snapshot(watch.path);
  }

  async detectChanges(watch: FsWatch): Promise<{
    newBaseline: FsBaseline;
    events: FsEvent[];
    observedChange: boolean;
  }> {
    const nowTs = this._now();
    if (watch.timeoutAt !== undefined && nowTs >= watch.timeoutAt) {
      return {
        newBaseline:
          this.baselines.get(this.watchKey(watch)) ?? { exists: false },
        events: [buildTimeoutEvent(watch)],
        observedChange: true,
      };
    }
    // Sync base-class baseline into watch record so poller can read it.
    watch.baseline = this.baselines.get(this.watchKey(watch));
    return pollerDetectChanges(watch, (this._client as FsClient).snapshot.bind(this._client));
  }

  normaliseWatch(raw: unknown): FsWatch | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r["watchId"] !== "string" || typeof r["path"] !== "string")
      return null;

    const rawTarget = r["target"];
    // Migration shim: remap old TargetCondition values that were persisted before the
    // "creation/modification/deletion" rename so that saved sessions from before the
    // rename continue to load correctly.
    const target =
      rawTarget === "exists" ? "creation" :
      rawTarget === "changed" ? "modification" :
      rawTarget === "removed" ? "deletion" :
      rawTarget;
    if (
      typeof target !== "string" ||
      !(TARGETS as ReadonlySet<string>).has(target)
    )
      return null;

    return {
      watchId: r["watchId"],
      path: r["path"],
      target: target as TargetCondition,
      timeoutAt:
        typeof r["timeoutAt"] === "number" && Number.isFinite(r["timeoutAt"])
          ? r["timeoutAt"]
          : undefined,
      addedAt:
        typeof r["addedAt"] === "number" && Number.isFinite(r["addedAt"])
          ? r["addedAt"]
          : 0,
      lastPolledAt:
        typeof r["lastPolledAt"] === "number" ? r["lastPolledAt"] : undefined,
      baseline: this._normaliseBaselineField(r["baseline"]),
      terminal:
        typeof r["terminal"] === "boolean" ? r["terminal"] : false,
      consecutiveErrors:
        typeof r["consecutiveErrors"] === "number" &&
        Number.isFinite(r["consecutiveErrors"])
          ? r["consecutiveErrors"]
          : 0,
    };
    // Note: any legacy `mode` field on the raw object is intentionally ignored.
  }

  normaliseBaseline(raw: unknown): FsBaseline | null {
    const b = this._normaliseBaselineField(raw);
    return b ?? null;
  }

  private _normaliseBaselineField(raw: unknown): FsBaseline | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r["exists"] !== "boolean") return undefined;
    const b: FsBaseline = { exists: r["exists"] };
    // mtimeNs is serialised as a decimal string (BigInt is not JSON-serialisable).
    if (typeof r["mtimeNs"] === "string" || typeof r["mtimeNs"] === "bigint") {
      try {
        b.mtimeNs = BigInt(r["mtimeNs"]);
      } catch {
        /* ignore invalid bigint */
      }
    }
    if (
      typeof r["size"] === "number" &&
      Number.isFinite(r["size"])
    ) {
      b.size = r["size"];
    }
    return b;
  }

  classifyError(err: unknown): ClassifiedWatcherError {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    if (code === "EACCES" || code === "EPERM") {
      return {
        userMessage: "stat() failed — permission denied",
        kind: "auth",
        shouldBackoff: false,
        statusModifier: "auth-error",
      };
    }
    return {
      userMessage: "stat() failed — check the path is accessible",
      kind: "generic",
      shouldBackoff: false,
      statusModifier: "none",
    };
  }

  buildChangeChatMessage(events: readonly FsEvent[], now: Date): string {
    return formatChangeChatMessage(Array.from(events), now);
  }

  protected override containsTerminalStateEvent(events: FsEvent[]): boolean {
    // Every FsEvent (target-hit or timeout) marks the watch terminal.
    return events.length > 0;
  }

  // ── Add / Remove ───────────────────────────────────────────────────────────
  async addWatch(params: Record<string, unknown>): Promise<ToolResult> {
    const watchPath =
      (typeof params["path"] === "string" ? params["path"] : "").trim();
    if (!watchPath) {
      return this._toolError("'add' requires a 'path'.");
    }

    const target = (
      typeof params["target"] === "string" ? params["target"] : ""
    ).trim();
    if (!(TARGETS as ReadonlySet<string>).has(target)) {
      return this._toolError(
        "'add' requires target to be 'creation', 'modification', or 'deletion'.",
      );
    }

    const requestedSeconds =
      typeof params["timeoutSeconds"] === "number"
        ? params["timeoutSeconds"]
        : undefined;
    if (requestedSeconds !== undefined) {
      if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
        return this._toolError(
          "'timeoutSeconds' must be a positive finite number.",
        );
      }
    }

    const capped =
      requestedSeconds !== undefined &&
      requestedSeconds > MAX_TIMEOUT_SECONDS;
    const effectiveSeconds =
      requestedSeconds !== undefined
        ? Math.min(requestedSeconds, MAX_TIMEOUT_SECONDS)
        : MAX_TIMEOUT_SECONDS;
    const timeoutAt = this._now() + effectiveSeconds * 1000;

    const watchId = randomBytes(4).toString("hex");
    const watch: FsWatch = {
      watchId,
      path: watchPath,
      target: target as TargetCondition,
      timeoutAt,
      addedAt: this._now(),
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };

    let seedError: string | undefined;
    try {
      watch.baseline = await (this._client as FsClient).snapshot(watchPath);
    } catch (err) {
      seedError = (err as Error).message;
    }

    // target='modification' requires the path to exist at add time — there is no
    // mtime to diff against otherwise.
    if (
      target === "modification" &&
      watch.baseline !== undefined &&
      !watch.baseline.exists
    ) {
      return this._toolError(
        `target='modification' requires the path to exist at add time, ` +
          `but ${watchPath} is currently absent.`,
      );
    }

    this.watches.set(watchId, watch);
    if (watch.baseline !== undefined) {
      this.baselines.set(watchId, watch.baseline);
    }

    // Start per-watch scheduler immediately.
    const s = this.schedulerFor(watchId);
    if (!s.isRunning) s.start(() => this.pollWatch(watchId));

    const stateLabel =
      watch.baseline === undefined
        ? "?"
        : watch.baseline.exists
          ? "present"
          : "absent";
    const cappedNote = capped ? ` (capped from ${requestedSeconds}s)` : "";
    const timeoutLabel = ` timeout=${effectiveSeconds}s${cappedNote}`;
    const message = seedError
      ? `file-system-watcher: added watch ${watchId} for ${watchPath} (target=${target}${timeoutLabel}), but seeding failed (${seedError}). Will retry on next poll.`
      : `file-system-watcher: added watch ${watchId} for ${watchPath} (target=${target}${timeoutLabel}) — baseline=${stateLabel}.`;

    // Mark the watcher as enabled so that any poll notification fired before
    // onTurnEnd does not include the stale "Run manage_tools" reactivation hint.
    // (The tool can only be invoked if it is already in the active-tools set.)
    this.enabled = true;

    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "add",
        ok: true,
        message,
        watchId,
        watches: Array.from(this.watches.keys()),
      },
    };
  }

  override removeWatch(watch: FsWatch): Promise<ToolResult> {
    const remaining = this.watches.size - 1;
    const message = `file-system-watcher: removed watch '${watch.watchId}' (${watch.path}). ${remaining} watch(es) remaining.`;
    return Promise.resolve({
      content: [{ type: "text" as const, text: message }],
      details: {
        action: "remove",
        ok: true,
        watchKey: this.watchKey(watch),
      },
    });
  }

  protected override browseOptions(): Partial<BrowseViewOptions<FsWatch>> {
    return {
      searchable: false,
      rowActions: [
        {
          id: "remove",
          label: "Unwatch",
          keybind: "ctrl+x",
          visible: (w) => !w.terminal,
          run: async (watch) => {
            await this.executeTool({
              action: "remove",
              watchId: this.watchKey(watch),
            });
          },
        },
      ],
      onRefresh: () => this.pollOnce(),
      onPurge: () => this.executePurge(),
      getPollIntervalMs: (w: FsWatch) => this.schedulerFor(w.watchId).intervalMs,
    };
  }

  // ── Per-watch schedulers ───────────────────────────────────────────────────
  private readonly _watchSchedulers = new Map<string, PollScheduler>();

  protected override schedulerFor(watchKey: string): PollScheduler {
    let s = this._watchSchedulers.get(watchKey);
    if (s === undefined) {
      s = new PollScheduler({
        baseMs: BASE_POLL_MS,
        maxMs: MAX_POLL_MS,
        idleMaxMs: MAX_POLL_MS,
      });
      this._watchSchedulers.set(watchKey, s);
    }
    return s;
  }

  protected override noteSchedulerSuccess(
    anyChange: boolean,
    watchKey: string,
  ): void {
    this.schedulerFor(watchKey).noteSuccess(anyChange);
  }

  override startPolling(): void {
    for (const [key, watch] of this.watches) {
      if (watch.terminal) continue;
      const s = this.schedulerFor(key);
      if (!s.isRunning) s.start(() => this.pollWatch(key));
    }
  }

  override stopPolling(): void {
    for (const s of this._watchSchedulers.values()) s.stop();
  }
}
