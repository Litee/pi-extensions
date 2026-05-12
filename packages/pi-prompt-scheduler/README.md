# pi-prompt-scheduler

LLM-facing scheduler for pi. Registers a `schedule_prompt` tool so the agent
can schedule prompts to fire later (cron, interval, one-shot ISO / relative
time), plus a browse/cancel TUI and a below-the-editor widget so you can see
what's queued and yank it if the agent gets cute.

This package is a trimmed, LLM-only fork of upstream `pi-schedule-prompt`
(see [Attribution](#attribution)). The manual "add job through a TUI wizard"
flow is **not** included — jobs are created exclusively through the
`schedule_prompt` tool. The `/schedule-prompt` command only browses and
cancels jobs that already exist.

## What it does

- **`schedule_prompt` tool.** The agent calls this to create, list, enable,
  disable, update, remove, or cleanup scheduled jobs. Supports four schedule
  forms:
  - 6-field cron with seconds (`0 */5 * * * *` — every 5 minutes)
  - relative time (`+10s`, `+5m`, `+1h`, `+1d`) — resolved to ISO on create
  - ISO timestamp (must be ≥5s in the future)
  - interval duration (`5m`, `1h`, `30s`)
- **`/schedule-prompt` command.** Opens a TUI overlay with two submenus:
  - **Jobs** — list all scheduled jobs visible to this session, toggle enable,
    rebind session ↔ shared scope, remove individual jobs, or cleanup all
    disabled jobs. No add keybinding; the agent owns job creation.
  - **Settings** — toggle the live widget visibility and the default scope
    (`session` vs `workdir`) for newly-created jobs. Persisted per-project at
    `.pi/schedule-prompts-settings.json`.
- **Live widget below the editor** — status, name, schedule, next run, last
  run, and run count for each job. Auto-refreshes every 30 s.
- **Two firing modes.**
  - **Inline (default, no `model` field).** The scheduled prompt is injected
    into the current chat via `sendUserMessage` and the active model answers.
  - **Subagent (when `model` is set).** Fires the prompt in a fresh
    in-process `AgentSession` with the chosen model, default tools only, no
    extensions. The parent chat stays untouched unless the job sets
    `notify: true`.
- **Persistence.** Jobs live in `<cwd>/.pi/schedule-prompts.json`. Settings
  live in `<cwd>/.pi/schedule-prompts-settings.json` (with a global fallback
  at `<agentDir>/schedule-prompts-settings.json`).
- **Session scoping.** Newly-created jobs default to `session`-bound: only
  the pi session that created the job fires it. Flip the default via the
  `Settings` submenu or toggle a single job's binding with `s` in the Jobs
  view. Unbound jobs fire in every pi session that has this cwd open.
- **Recursion guard.** The tool refuses `action: "add"` when the last 10
  chat entries include a `scheduled_prompt` custom message — prevents a
  scheduled prompt from scheduling itself into an infinite loop.

## Commands

| Command             | Description |
|---------------------|-------------|
| `/schedule-prompt`  | Opens a submenu (`Jobs` / `Settings`) for browsing and cancelling scheduled prompts. No manual add — the agent creates jobs via the `schedule_prompt` tool. |

### Jobs view keybindings

| Key | Action |
|-----|--------|
| `↑` / `↓` | Select a job |
| `t` | Toggle enabled / disabled on the selected job |
| `s` | Toggle session binding (session-bound ↔ shared across pis in this cwd) |
| `x` | Remove the selected job (with y/n confirm) |
| `c` | Cleanup: remove all disabled jobs owned by this session (with y/n confirm) |
| `q` / `Esc` | Close the overlay |

Foreign-session jobs (created by another pi sharing this `.pi/` directory)
render read-only under an "Other sessions" header; `t`/`s`/`x` are no-ops on
them.

## Tool schema

`schedule_prompt` parameters:

| Param | Required | Description |
|-------|----------|-------------|
| `action` | ✓ | One of `add`, `remove`, `list`, `enable`, `disable`, `update`, `cleanup`. |
| `schedule` | `add` (required), `update` (optional) | Cron expression, ISO timestamp, relative time (`+10s`), or interval string. |
| `prompt` | `add` (required) | The prompt text to fire. |
| `jobId` | `remove`, `enable`, `disable`, `update` | Target job id. |
| `name` | — | Job name; auto-generated as `job-<nanoid6>` if omitted. |
| `type` | — | `cron` (default), `once`, or `interval`. Use `once` for relative / ISO times. |
| `description` | — | Optional free-form description. |
| `model` | — | If set, fires the prompt in a subagent with this model (e.g. `anthropic/claude-haiku-4-5`). Must be non-empty. |
| `notify` | — | Subagent jobs only. If `true`, the parent is woken with a follow-up message carrying the subagent's output snippet. Default `false`. |

## Configuration

### Project-level settings

Persisted at `<cwd>/.pi/schedule-prompts-settings.json` by the `Settings`
submenu:

```json
{
  "widgetVisible": true,
  "defaultJobScope": "session"
}
```

### Global defaults

Optional fallback at `<agentDir>/schedule-prompts-settings.json` (honouring
`$PI_CODING_AGENT_DIR`). The project file overrides any key set here; unset
keys fall through.

### Storage

Jobs live in `<cwd>/.pi/schedule-prompts.json`. File format is a
versioned `{ jobs: CronJob[], version: number }`. Writes are atomic
(temp file + rename).

## Attribution

This package is a local port and trim of
[`tintinweb/pi-schedule-prompt`](https://github.com/tintinweb/pi-schedule-prompt)
(MIT, © tintinweb), rebased on top of v0.3.0
([`a51cf5a`](https://github.com/tintinweb/pi-schedule-prompt/commit/a51cf5a86018add0b2d0bcc45e2e456adb546119),
2026-05-03). See [`UPSTREAM.md`](./UPSTREAM.md) for the exact copied commit
and a recipe for diffing against future upstream work.

## Differences from upstream

Not exhaustive — just the highlights that matter if you are considering
copying this package. Here is what you will be picking up on top of upstream
`pi-schedule-prompt` v0.3.0:

- **Renamed to `pi-prompt-scheduler`.** The upstream name `pi-schedule-prompt`
  is kept in `UPSTREAM.md` and in source-file headers so the provenance is
  traceable; the local package is renamed to emphasise that this is an
  LLM-facing scheduler, not a drop-in of the full upstream extension.
- **Manual add flow removed.** `src/ui/add-flow.ts` and
  `src/ui/schedule-input.ts` are deleted. The `Jobs` overlay no longer binds
  `a` for add. The agent is the sole author of jobs; humans browse and cancel.
- **`/schedule-prompt` command slimmed.** The submenu still offers
  `Jobs` / `Settings`, but Jobs is browse-only (toggle / scope / remove /
  cleanup / quit) and the empty-state hint points at the `schedule_prompt`
  tool instead of a manual keybinding.
- **Unit test coverage** added for the trimmed surface (storage, settings,
  pure scheduler helpers, tool execute flows, jobs-view input and render).
  Upstream has no test suite at all.
- **Widget layout polish.** The Scheduled Prompts side-panel drops the
  blank spacer between the title row and the first job bullet — keeps
  vertical rhythm consistent with neighbouring panels (Watchers, Skills).
- **LLM-message collapse.** `schedule_prompt`'s `Created`/`Updated cron job`
  chat echo collapses prompts longer than ~120 chars or containing newlines
  into a one-line summary; full prompt is reachable with Ctrl-o.

## License

MIT (inherited from the upstream). See [`LICENSE`](LICENSE).
