# pi-session-recap

> **Upstream:** [`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap)
>
> This package is a copy of the upstream `session-recap` extension (v0.1.1,
> MIT, by Thomas Mustier) ported into this workspace as `pi-session-recap`
> for easier local experimentation. The behaviour is identical; any changes
> made here should be kept in sync with the upstream via a diff against the
> link above.

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
regardless of the session's active one.

## Flags

| Flag | Default | Description |
|---|---|---|
| `--recap-idle-seconds <n>` | `120` | Seconds after `turn_end` before the idle-fallback recap fires. |
| `--recap-focus-min-seconds <n>` | `3` | Minimum focus-out duration before a recap is revealed on refocus. |
| `--recap-disable-focus` | `false` | Disable DECSET `?1004` focus reporting. Idle fallback still runs. |
| `--recap-disable` | `false` | Disable the automatic recap entirely. `/recap` still works. |
| `--recap-model "<p/id>"` | (active model) | Override the default, e.g. `anthropic/claude-sonnet-4-6`. |

## Command

| Command | Description |
|---|---|
| `/recap` | Force-generate a recap right now, bypassing the activity gate. |

## Attribution

This package is a verbatim port of
[`tmustier/pi-extensions/session-recap`](https://github.com/tmustier/pi-extensions/tree/main/session-recap)
(MIT, © Thomas Mustier). For the design-of-record, trigger matrix,
model-selection rationale and open questions, see the upstream
[`DESIGN.md`](https://github.com/tmustier/pi-extensions/blob/main/session-recap/DESIGN.md).

## License

MIT (inherited from the upstream).
