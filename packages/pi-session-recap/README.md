# pi-session-recap

"While you were away" recap for pi, modelled on Claude Code's away-summary.
When you've genuinely been away from a pi session, a short recap is drafted
while you're gone and parked above the editor so it's waiting when you
return.

Built for multi-clauding / multi-pi workflows where several agent sessions
run in parallel tabs.

The recap orients rather than reports: it states the high-level task first
(what you're building or debugging), then the concrete next step — the last
assistant message is already on screen; what you've lost after a context
switch is the task thread.

## What it does

Three triggers fire the recap; you get whichever fires first:

1. **Away timer.** The extension enables terminal focus reporting (DECSET
   `?1004`) on session start. After the terminal has been continuously
   blurred for `--recap-away-seconds` (default 90s), a recap is generated
   and shown, so it's parked above the editor when you refocus. Quick
   alt-tabs cost nothing: no model call is made until you've actually been
   away for the full threshold.
2. **Turn ends while you're away.** If the agent finishes a turn while the
   terminal is blurred — the prime multi-tab moment — a recap is drafted
   after a short debounce.
3. **Idle fallback.** Only on terminals that haven't demonstrated
   focus-reporting support: `--recap-idle-seconds` (default 300s) after
   the last `turn_end` with no input, a recap is generated anyway. The
   first real focus event disarms this path for the session.

The recap also fires automatically on `/resume` and `/fork` so you know
where the prior session left off.

Clears cleanly on: next user input, new turn start, session reload, or
session shutdown.

## Commands

| Command            | Description |
|--------------------|-------------|
| `/recap`           | Force-generate a recap right now, bypassing the activity gate. Takes no arguments. |
| `/recap-settings`  | Open the interactive settings menu: read-only status (model + source, auto-recap state, idle / away triggers, active disabled flags, trigger count, token usage), plus a session-scoped editor for the idle-fallback timeout. No LLM call, no turn triggered. |

Values edited from `/recap-settings` are **session-scoped** — they live in
memory until `session_shutdown` and never persist to disk. To make a
default stick across sessions, set the corresponding flag
(`--recap-idle-seconds`) instead.

## Configuration

### Flags

| Flag | Default | Description |
|---|---|---|
| `--recap-away-seconds <n>` | `90` | Seconds of continuous terminal blur before an away recap is generated. |
| `--recap-idle-seconds <n>` | `300` | Idle-fallback delay after `turn_end`, used only when the terminal doesn't report focus. |
| `--recap-disable-focus` | `false` | Disable DECSET `?1004` focus reporting. Idle fallback still runs. |
| `--recap-during-active` | `false` | Allow away recaps while an agent turn is still running, instead of deferring to the end of the turn. |
| `--recap-auto` | `false` | Enable automatic recaps (idle, away, and resume triggers). `/recap` still works without it. |
| `--recap-model "<p/id>"` | (active model) | Override the default, e.g. `anthropic/claude-sonnet-4-6`. |

> v0.1's `--recap-focus-min-seconds` was removed: recaps are no longer
> drafted on every focus-out, so there is no quick-glance suppression to
> tune. Automatic recaps are opt-in via `--recap-auto` (local divergence —
> upstream has no such gate).

### User-level config file

Set a persistent recap-model preference in
`~/.pi/agent/pi-session-recap.json` (honoured by pi's `getAgentDir()` / the
`$PI_CODING_AGENT_DIR` env override). The whole default path can also be
replaced outright by setting `$PI_SESSION_RECAP_CONFIG` to an absolute path.

```json
{
  "model": "anthropic/claude-haiku-4-5"
}
```

Top-level keys mirror what used to live under `sessionRecap.*` in pi's
`settings.json` — just without the `sessionRecap.` wrapper. Starts with
`model`; the file shape leaves room for future knobs (`idleSeconds`,
`disableFocus`, …) without schema migration.

Precedence: `--recap-model` CLI flag › `model` in
`pi-session-recap.json` › the active model. An invalid / unknown
`provider/id` falls through to the active model silently (same as the CLI
flag).

### Model

Defaults to the **currently active model** in your pi session, but with
recap-specific low-cost settings. This piggybacks on the auth you already
have configured, so there are no extra login prompts.

- No tools or Agent Skills are loaded into the recap call — only a compact
  two-tier transcript is sent (recent activity in detail, plus your earlier
  prompts and any compaction summary for task framing), capped at ~12k
  chars.
- Reasoning/thinking is disabled for the recap call and prompt cache
  writes/reads are disabled (`cacheRetention: "none"`); output is capped
  at 256 tokens.
- Custom providers registered through `pi.registerProvider` work when they
  use one of pi-ai's built-in API types. Providers that register a custom
  API handler only inside pi's runtime are skipped silently because pi-ai's
  standalone layer cannot route the recap call; use `--recap-model` to
  select a supported provider if you still want recaps in those sessions.
- No active model or failed auth resolution → the recap is skipped
  silently.

### Migration from earlier versions

On first `session_start` after upgrade, the extension migrates any
pre-existing configuration to `~/.pi/agent/pi-session-recap.json` once,
silently. Order of checks:

1. New flat path exists → done. No migration.
2. Else `~/.pi/agent/extensions-data/pi-session-recap.json` exists
   (pre-release layout / manual placement) → moved to the new flat path.
3. Else `sessionRecap.model` is present in `~/.pi/agent/settings.json` →
   its value is copied to the new file as `{ "model": "<value>" }`. The
   legacy key in `settings.json` is left in place; the extension simply
   stops reading it.
4. Else → nothing is written.

Migration is best-effort: any I/O error is swallowed and the extension
falls back to the active pi model. When both the new flat path and a
legacy source exist, the new path wins; legacy sources are left untouched.

## Terminal compatibility

| Terminal | Focus reporting | Notes |
|---|---|---|
| iTerm2, Ghostty, Alacritty, Kitty, WezTerm, xterm | ✅ | Works out of the box. |
| VS Code integrated terminal, Warp | ✅ | Works. |
| Apple Terminal | ⚠️ Partial | Idle fallback covers it. |
| tmux | ✅ (with config) | Add `set -g focus-events on` to `~/.tmux.conf`, then `tmux source-file ~/.tmux.conf`. |

If focus events cause weirdness, pass `--recap-disable-focus` and the idle
fallback still works.

## Attribution

This package is a verbatim port of
[`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap)
(MIT, © Thomas Mustier). For the design-of-record, trigger matrix,
model-selection rationale and open questions, see the upstream
[`DESIGN.md`](https://github.com/tmustier/pi-extensions/blob/main/session-recap/DESIGN.md).
The locally-added `settings.ts` and `helpers.ts` modules (user-level
config file, pure-function split) are original to this port by
Andrey Lipatkin. See [`UPSTREAM.md`](./UPSTREAM.md) for the exact copied
commit and a recipe for diffing against future upstream changes.

## Differences from upstream

Not exhaustive — just the highlights that matter if you are considering
copying this package. Here is what you will be picking up on top of
upstream `session-recap` v0.2.2:

- **User-level config file** at `~/.pi/agent/pi-session-recap.json`, owned
  by the extension, with a one-time migration from legacy locations. Lets
  you set a persistent `recap-model` preference (among other things)
  without passing CLI flags every session.
- **No `/recap` subcommands.** Upstream's `/recap status` and `/recap
  help` are gone; configuration is reachable only via the
  `/recap-settings` TUI below.
- **`/recap-settings` TUI** (local-only). Read-only status surface plus
  a session-scoped editor for the idle-fallback timeout. Other rows are
  read-only — the menu is the chat-free way to inspect the effective
  recap configuration.
- **`--recap-auto` opt-in gate.** Upstream v0.2 fires automatic recaps
  unconditionally; this port keeps them behind `--recap-auto` (default
  `false`). `/recap` works regardless.
- **Local idle default kept at 300s** (upstream v0.2 defaults to 120s).
- **Recap-model override.** User-level settings can pin a recap model
  regardless of the session's active model; still falls back to
  session-active with reasoning/thinking disabled when unset.
- **pi-ai main-import adaptation.** Upstream imports
  `@earendil-works/pi-ai/compat`; this monorepo pins
  `@earendil-works/pi-ai@^0.79.10`, which has no `/compat` export, so the
  port imports from the main entry instead. pi-coding-agent 0.79.10
  bridges `pi.registerProvider` → pi-ai's `registerApiProvider`, so
  pi-registered custom providers still route; providers unknown to pi-ai
  hit the same catchable "No API provider registered for api:" error and
  are skipped silently (matching upstream v0.2.2 behaviour).
- **Widget / status keys prefixed with the package name** so multiple
  extensions registering the same generic key no longer clash in the TUI.
- **Flag key hygiene.** `pi.getFlag(...)` called with bare keys (no `--`
  prefix) to match the post-0.70 pi API contract.
- **`helpers.ts` split out** so the pure functions are unit-testable
  without `pi-tui` / `pi-ai` / stdin. Upstream keeps everything in a
  single file.
- **Strictness-compliance edits** for this repo's `@tsconfig/strictest`
  layering (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`; no
  behaviour change).

## License

MIT (inherited from the upstream). See [`LICENSE`](LICENSE).
