# pi-session-recap

> **Upstream:** [`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap)
> (v0.1.1, MIT, © Thomas Mustier). See [`UPSTREAM.md`](./UPSTREAM.md) for the
> exact copied commit and a recipe for diffing against future upstream
> changes.

Claude-Code-style session recap for pi. When you switch focus away from a pi
session and come back, a one-line recap appears above the editor so you can
re-enter flow without re-reading scrollback.

Built for multi-clauding / multi-pi workflows where several agent sessions run
in parallel tabs.

## How it triggers

Two complementary triggers. You get whichever fires first.

1. **Terminal focus reporting (DECSET `?1004`).** The extension enables focus
   events on session start and listens for `ESC[O` (focus-out) and `ESC[I`
   (focus-in). On focus-out it drafts a recap in the background; on focus-in
   it reveals the recap above the editor, as long as you were away for at
   least `--recap-focus-min-seconds` (default 3s).
2. **Idle fallback.** After the last `turn_end`, if you don't type for
   `--recap-idle-seconds` (default 120s), the recap is generated and shown
   anyway. Covers terminals that don't report focus events.

Also fires automatically on `/resume` and `/fork`.

Clears on: next user input, new turn start, session reload, session shutdown.

## Terminal compatibility

| Terminal | Focus reporting | Notes |
|---|---|---|
| iTerm2, Ghostty, Alacritty, Kitty, WezTerm, xterm | ✅ | Works out of the box. |
| VS Code integrated terminal, Warp | ✅ | Works. |
| Apple Terminal | ⚠️ Partial | Idle fallback covers it. |
| tmux | ✅ (with config) | Add `set -g focus-events on` to `~/.tmux.conf`, then `tmux source-file ~/.tmux.conf`. |

If focus events cause weirdness, pass `--recap-disable-focus` and the idle
fallback still works.

## Model

Defaults to the **currently active model** in your pi session with
`reasoning: "minimal"` where supported. Piggybacks on whatever auth you
already have (including custom providers registered via `pi.registerProvider`),
so there are no login surprises.

- Reasoning-capable model → runs at minimal thinking for speed/cost.
- Non-reasoning model → no reasoning params passed.
- No active model or missing API key → the recap is skipped silently.

Override with `--recap-model "<provider>/<id>"` if you want a specific model
regardless of the session's active one, or set a persistent preference in the
extension's own config file (see below).

## Flags

| Flag | Default | Description |
|---|---|---|
| `--recap-idle-seconds <n>` | `120` | Seconds after `turn_end` before the idle-fallback recap fires. |
| `--recap-focus-min-seconds <n>` | `3` | Minimum focus-out duration before a recap is revealed on refocus. |
| `--recap-disable-focus` | `false` | Disable DECSET `?1004` focus reporting. Idle fallback still runs. |
| `--recap-disable` | `false` | Disable the automatic recap entirely. `/recap` still works. |
| `--recap-model "<p/id>"` | (active model) | Override the default, e.g. `anthropic/claude-sonnet-4-6`. |

## User-level config

Set a persistent recap-model preference in `~/.pi/agent/pi-session-recap.json`
(honoured by pi's `getAgentDir()` / the `$PI_CODING_AGENT_DIR` env override).
The whole default path can also be replaced outright by setting
`$PI_SESSION_RECAP_CONFIG` to an absolute path.

```json
{
  "model": "anthropic/claude-haiku-4-5"
}
```

Top-level keys mirror what used to live under `sessionRecap.*` in pi's
`settings.json` — just without the `sessionRecap.` wrapper. Starts with
`model`; the file shape leaves room for future knobs (`idleSeconds`,
`disableFocus`, …) without schema migration.

Precedence: `--recap-model` CLI flag › `model` in `pi-session-recap.json` ›
the active model. An invalid / unknown `provider/id` falls through to the
active model silently (same as the CLI flag).

### Migration from earlier versions

On first `session_start` after upgrade, the extension migrates any pre-existing
configuration to `~/.pi/agent/pi-session-recap.json` once, silently. Order of
checks:

1. New flat path exists → done. No migration.
2. Else `~/.pi/agent/extensions-data/pi-session-recap.json` exists (pre-release
   layout / manual placement) → moved to the new flat path.
3. Else `sessionRecap.model` is present in `~/.pi/agent/settings.json` → its
   value is copied to the new file as `{ "model": "<value>" }`. The legacy key
   in `settings.json` is left in place; the extension simply stops reading it.
4. Else → nothing is written.

Migration is best-effort: any I/O error is swallowed and the extension falls
back to the active pi model. When both the new flat path and a legacy source
exist, the new path wins; legacy sources are left untouched.

## Command

| Command | Description |
|---|---|
| `/recap` | Force-generate a recap right now, bypassing the activity gate. |
| `/recap status` | Print the current effective recap configuration (model + source, auto-recap state, idle / focus triggers, active disabled flags). No LLM call, no turn triggered. |
| `/recap help` | List the available `/recap` subcommands. |

## Differences from upstream

Not exhaustive — just the highlights that matter if you are considering
copying this package. Here is what you will be picking up on top of upstream
`session-recap` v0.1.1:

- **User-level config file** at `~/.pi/agent/pi-session-recap.json`, owned by
  the extension, with a one-time migration from legacy locations. Lets you
  set a persistent `recap-model` preference (among other things) without
  passing CLI flags every session.
- **`/recap` subcommands.** `/recap help` and `/recap status` added locally.
  `/recap` subcommand output renders chromeless (no default message shell).
- **Default idle timeout raised** from upstream's 45s to 180s (via an
  intermediate bump to 120s). Upstream-friendly override still works via
  `--recap-idle-seconds`.
- **Recap-model override.** User-level settings can pin a recap model
  regardless of the session's active model; still falls back to
  session-active + `reasoning: "minimal"` when unset.
- **Prompt tuning.** Leads with the goal, drops the `recap:` prefix, and
  adds a Skip rule so uneventful turns produce no recap at all.
- **Widget / status keys prefixed with the package name** so multiple
  extensions registering the same generic key no longer clash in the TUI.
- **Flag key hygiene.** `pi.getFlag(...)` called with bare keys (no `--`
  prefix) to match the post-0.70 pi API contract.
- **`helpers.ts` split out** so the pure functions are unit-testable without
  `pi-tui` / `pi-ai` / stdin. Upstream keeps everything in a single file.
- **Strictness-compliance edits** for this repo's `@tsconfig/strictest`
  layering (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`; no
  behaviour change).

## Attribution

This package is a verbatim port of
[`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap)
(MIT, © Thomas Mustier). For the design-of-record, trigger matrix,
model-selection rationale and open questions, see the upstream
[`DESIGN.md`](https://github.com/tmustier/pi-extensions/blob/main/session-recap/DESIGN.md).

## License

MIT (inherited from the upstream).
