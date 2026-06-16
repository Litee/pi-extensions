/**
 * GitWatcher — pi-git-watcher implemented via BaseWatcher.
 *
 * Wires git-specific snapshot / change-detection / rendering into the shared
 * BaseWatcher poll loop, persistence, and menu machinery.
 *
 * Detection is poll-only (60 s base, 15 min cap). Fires continuously on each
 * detected change — use `remove` to stop a watch.
 */

import { resolve } from "node:path";

import {
  BaseWatcher,
  BASE_POLL_MS,
  MAX_POLL_MS,
  POLL_ERROR_THRESHOLD,
} from "pi-watcher-core/base-watcher";
import { mintWatchId } from "pi-watcher-core/mint-watch-id";
import { formatTimeLeft } from "pi-watcher-core/time-left";
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
import {
  buildTimeoutEvent,
  detectChanges as pollerDetectChanges,
  snapshotRepo,
} from "./poller.js";
import { GitClientError, type GitClient } from "./git-client.js";
import { MAX_TIMEOUT_SECONDS, GitWatcherParams, TARGETS } from "./toolAction.js";
import type { GitBaseline, GitEvent, GitWatch, TargetCondition } from "./types.js";

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export { formatTimeLeft } from "pi-watcher-core/time-left";

export function compressPath(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) return path;
  const ellipsis = "…";
  const keep = maxWidth - ellipsis.length;
  if (keep <= 0) return ellipsis;
  return ellipsis + path.slice(-keep);
}

// ---------------------------------------------------------------------------
// GitWatcher
// ---------------------------------------------------------------------------

export class GitWatcher extends BaseWatcher<GitWatch, GitBaseline, GitEvent> {
  // ── Identity ───────────────────────────────────────────────────────────────
  readonly extensionName = "pi-git-watcher";
  readonly toolName = "git_watcher";

  get itemSource() {
    return "user-tool" as const;
  }
  get hasWidget() {
    return true;
  }

  // ── View ───────────────────────────────────────────────────────────────────
  readonly view: WatcherView<GitWatch, GitEvent> = {
    noun: "repository",
    nounPlural: "repositories",

    itemSortKey: (w) => w.repoPath + "#" + w.branch,
    itemGroup: (w) => w.repoPath,

    renderItemRowText(w) {
      const statusText =
        w.terminal
          ? "DONE"
          : w.consecutiveErrors >= POLL_ERROR_THRESHOLD
            ? "ERROR"
            : "WATCHING";
      const timeLeft = formatTimeLeft(w.timeoutAt, Date.now());
      return `${w.repoPath} [${w.branch}]  ${statusText}  ${timeLeft}  ${w.targets.join(",")}`;
    },

    renderItemRowTUI(w, _ctx): RowColumn[] {
      const repoColor =
        w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? "warning" : "accent";
      const statusText =
        w.terminal
          ? "DONE"
          : w.consecutiveErrors >= POLL_ERROR_THRESHOLD
            ? "ERROR"
            : "WATCHING";
      const statusColor =
        w.consecutiveErrors >= POLL_ERROR_THRESHOLD ? "error" : "warning";
      const timeLeft = formatTimeLeft(w.timeoutAt, Date.now());
      const timeColor: string =
        w.timeoutAt !== undefined && w.timeoutAt - Date.now() < 5 * 60 * 1000
          ? "warning"
          : "dim";
      const headText = w.baseline?.headSha
        ? w.baseline.headSha.slice(0, 7)
        : "n/a";
      const targetsText = w.targets.join(",");
      return [
        { name: "repo",    text: `${w.repoPath} [${w.branch}]`, color: repoColor },
        { name: "head",    text: headText,   width: 9,  color: "dim" },
        { name: "targets", text: targetsText, width: 14, color: "dim" },
        { name: "status",  text: statusText, width: 10, color: statusColor },
        { name: "timeout", text: timeLeft,   width: 10, color: timeColor },
      ];
    },

    renderItemDetail(w, ctx): DetailField[] {
      return [
        { label: "repoPath", value: w.repoPath },
        { label: "branch",   value: w.branch },
        { label: "targets",  value: w.targets.join(", ") },
        { label: "headSha",  value: w.baseline?.headSha ?? "n/a" },
        { label: "branches", value: w.baseline?.branches.join(", ") ?? "n/a" },
        { label: "tags",     value: w.baseline?.tags.join(", ") || "(none)" },
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

    isRowDimmed: (w: GitWatch) => w.terminal,

    compressColumns(cols: RowColumn[], totalWidth: number): RowColumn[] {
      const SEP = 2;
      const fixedTotal = cols
        .filter((c) => c.width !== undefined)
        .reduce((sum, c) => sum + c.width!, 0);
      const separators = (cols.length - 1) * SEP;
      const repoWidth = totalWidth - fixedTotal - separators;

      return cols.map((c) => {
        if (c.name !== "repo") return c;
        const compressed = compressPath(c.text, repoWidth);
        return compressed === c.text ? c : { ...c, text: compressed };
      });
    },
  };

  // ── Tool metadata ──────────────────────────────────────────────────────────
  protected override get toolLabel(): string {
    return "Git Watcher";
  }

  protected override get toolDescription(): string {
    return (
      "Watch a local Git repository for new commits, branch creation/deletion, " +
      "or tag creation. Polls git for-each-ref and rev-parse on a back-off " +
      "schedule (60 s base, doubles to 15 min cap) and fires a chat notification " +
      "on each detected change. Continuous — fires repeatedly; use remove to stop. " +
      "Actions: add, remove, list, pause, resume, status."
    );
  }

  protected override toolParameters(): unknown {
    return GitWatcherParams;
  }

  protected override get statusLabel(): string {
    return "git";
  }
  protected override get displayName(): string {
    return "Git Watcher";
  }
  protected override get commandName(): string {
    return "git-watcher";
  }

  // ── Constructor ────────────────────────────────────────────────────────────
  constructor(opts: BaseWatcherOptions & { client: GitClient }) {
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
  watchKey(watch: GitWatch): string {
    return watch.watchId;
  }

  async snapshot(watch: GitWatch): Promise<GitBaseline> {
    return snapshotRepo(this._client as GitClient, watch);
  }

  async detectChanges(watch: GitWatch): Promise<{
    newBaseline: GitBaseline;
    events: GitEvent[];
    observedChange: boolean;
  }> {
    const nowTs = this._now();
    if (watch.timeoutAt !== undefined && nowTs >= watch.timeoutAt) {
      return {
        newBaseline: this.baselines.get(this.watchKey(watch)) ?? {
          headSha: undefined,
          branches: [],
          tags: [],
        },
        events: [buildTimeoutEvent(watch, nowTs)],
        observedChange: true,
      };
    }
    // Sync base-class baseline into watch record so poller can read it.
    watch.baseline = this.baselines.get(this.watchKey(watch));
    return pollerDetectChanges(this._client as GitClient, watch, nowTs);
  }

  normaliseWatch(raw: unknown): GitWatch | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r["watchId"] !== "string") return null;
    if (typeof r["repoPath"] !== "string") return null;
    if (typeof r["branch"] !== "string") return null;

    // Validate targets array
    const rawTargets = r["targets"];
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) return null;
    const validTargets: TargetCondition[] = [];
    for (const t of rawTargets) {
      if (typeof t === "string" && (TARGETS as ReadonlySet<string>).has(t)) {
        validTargets.push(t as TargetCondition);
      }
      // Unknown/invalid targets are silently dropped (per spec).
    }
    if (validTargets.length === 0) return null;

    return {
      watchId: r["watchId"],
      repoPath: r["repoPath"],
      branch: r["branch"],
      targets: validTargets,
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
      terminal: typeof r["terminal"] === "boolean" ? r["terminal"] : false,
      consecutiveErrors:
        typeof r["consecutiveErrors"] === "number" &&
        Number.isFinite(r["consecutiveErrors"])
          ? r["consecutiveErrors"]
          : 0,
    };
  }

  normaliseBaseline(raw: unknown): GitBaseline | null {
    return this._normaliseBaselineField(raw) ?? null;
  }

  private _normaliseBaselineField(raw: unknown): GitBaseline | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;

    const headSha =
      typeof r["headSha"] === "string" ? r["headSha"] : undefined;

    const rawBranches = r["branches"];
    if (!Array.isArray(rawBranches)) return undefined;
    const branches = rawBranches.filter((b): b is string => typeof b === "string");

    const rawTags = r["tags"];
    if (!Array.isArray(rawTags)) return undefined;
    const tags = rawTags.filter((t): t is string => typeof t === "string");

    return { headSha, branches, tags };
  }

  classifyError(err: unknown): ClassifiedWatcherError {
    if (err instanceof GitClientError) {
      switch (err.kind) {
        case "not_a_repo":
          return {
            kind: "generic",
            shouldBackoff: false,
            statusModifier: "none",
            userMessage: "not a git repository",
          };
        case "git_not_installed":
          return {
            kind: "generic",
            shouldBackoff: false,
            statusModifier: "none",
            userMessage: "git CLI not found in PATH",
          };
        case "permission_denied":
          return {
            kind: "auth",
            shouldBackoff: false,
            statusModifier: "auth-error",
            userMessage: "permission denied reading the repository",
          };
        case "index_locked":
          return {
            kind: "throttle",
            shouldBackoff: true,
            statusModifier: "throttled",
            userMessage: "git index locked — another process is writing",
          };
        case "generic":
          return {
            kind: "generic",
            shouldBackoff: false,
            statusModifier: "none",
            userMessage: "git poll failed",
          };
      }
    }
    return {
      kind: "generic",
      shouldBackoff: false,
      statusModifier: "none",
      userMessage: "git poll failed",
    };
  }

  buildChangeChatMessage(events: readonly GitEvent[], now: Date): string {
    return formatChangeChatMessage(Array.from(events), now);
  }

  protected override containsTerminalStateEvent(events: GitEvent[]): boolean {
    // Continuous watcher — only timeout terminates a watch.
    return events.some((e) => e.eventType === "timeout");
  }

  // ── Add / Remove ───────────────────────────────────────────────────────────
  async addWatch(params: Record<string, unknown>): Promise<ToolResult> {
    // 1. Validate repoPath
    const rawPath = typeof params["repoPath"] === "string" ? params["repoPath"].trim() : "";
    if (!rawPath) {
      return this._toolError("'add' requires a 'repoPath'.");
    }
    const absPath = resolve(rawPath);

    // 2. Validate branch
    const branch = (typeof params["branch"] === "string" ? params["branch"] : "").trim();
    if (!branch) {
      return this._toolError("'add' requires a 'branch'.");
    }
    if (branch.includes(" ") || branch.includes("..")) {
      return this._toolError(
        `'branch' must not contain spaces or '..': ${JSON.stringify(branch)}`,
      );
    }

    // 3. Validate targets
    const rawTargets = params["targets"];
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      return this._toolError(
        "'add' requires 'targets' (non-empty array of: new_commit, branch_created, branch_deleted, tag_created).",
      );
    }
    const validTargets: TargetCondition[] = [];
    for (const t of rawTargets) {
      if (typeof t === "string" && (TARGETS as ReadonlySet<string>).has(t)) {
        validTargets.push(t as TargetCondition);
      } else {
        return this._toolError(
          `Invalid target '${String(t)}'. Valid values: new_commit, branch_created, branch_deleted, tag_created.`,
        );
      }
    }

    // 4. Validate timeoutSeconds
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

    // 5. Verify this is a git repository
    const isRepo = await (this._client as GitClient).isGitRepo(absPath);
    if (!isRepo) {
      return this._toolError(
        `'${absPath}' is not a git repository. Check the path.`,
      );
    }

    // 6. For new_commit: verify branch exists
    if (validTargets.includes("new_commit")) {
      const sha = await (this._client as GitClient).resolveBranch(absPath, branch);
      if (sha === undefined) {
        return this._toolError(
          `Branch '${branch}' does not exist in '${absPath}'. ` +
            `Create the branch first or choose another branch.`,
        );
      }
    }

    // 7. Generate watchId
    const watchId = mintWatchId();

    // 8. Build capped timeout
    const capped =
      requestedSeconds !== undefined &&
      requestedSeconds > MAX_TIMEOUT_SECONDS;
    const effectiveSeconds =
      requestedSeconds !== undefined
        ? Math.min(requestedSeconds, MAX_TIMEOUT_SECONDS)
        : undefined;
    const timeoutAt =
      effectiveSeconds !== undefined
        ? this._now() + effectiveSeconds * 1000
        : undefined;

    const watch: GitWatch = {
      watchId,
      repoPath: absPath,
      branch,
      targets: validTargets,
      timeoutAt,
      addedAt: this._now(),
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };

    // 9. Seed baseline (soft-fail)
    let seedError: string | undefined;
    try {
      watch.baseline = await this.snapshot(watch);
    } catch (err) {
      seedError = (err as Error).message;
    }

    this.watches.set(watchId, watch);
    if (watch.baseline !== undefined) {
      this.baselines.set(watchId, watch.baseline);
    }

    // 10. Set enabled = true (prevents stale "activate manage_tools" hint)
    this.enabled = true;

    // 11. Start per-watch scheduler immediately
    const s = this.schedulerFor(watchId);
    if (!s.isRunning) s.start(() => this.pollWatch(watchId));

    const cappedNote = capped ? ` (capped from ${requestedSeconds}s)` : "";
    const timeoutLabel =
      effectiveSeconds !== undefined
        ? ` timeout=${effectiveSeconds}s${cappedNote}`
        : " timeout=none";
    const message = seedError
      ? `git-watcher: added watch ${watchId} for ${absPath} [${branch}] (targets=${validTargets.join(",")}${timeoutLabel}), but seeding failed (${seedError}). Will retry on next poll.`
      : `git-watcher: added watch ${watchId} for ${absPath} [${branch}] (targets=${validTargets.join(",")}${timeoutLabel}).`;

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

  override removeWatch(watch: GitWatch): Promise<ToolResult> {
    const remaining = this.watches.size - 1;
    const message = `git-watcher: removed watch '${watch.watchId}' (${watch.repoPath} [${watch.branch}]). ${remaining} watch(es) remaining.`;
    return Promise.resolve({
      content: [{ type: "text" as const, text: message }],
      details: {
        action: "remove",
        ok: true,
        watchKey: this.watchKey(watch),
      },
    });
  }

  protected override browseOptions(): Partial<BrowseViewOptions<GitWatch>> {
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
      getPollIntervalMs: (w: GitWatch) =>
        this.schedulerFor(w.watchId).intervalMs,
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
