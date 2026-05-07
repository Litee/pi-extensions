# pi-preset

Named presets for pi — define model, thinking level, tools, system-prompt
instructions, bash command filtering, and post-agent-end action prompts per
preset. Activate via CLI flag, `/preset` command, or `Ctrl+Shift+U` to cycle.

## Features

- **Named presets** defined in JSON config files (global and project-local)
- **Per-preset configuration**: model, thinking level, active tool set, system-prompt instructions
- **Bash command filtering**: per-preset allowlist and blocklist of regex patterns
- **Post-agent-end action prompt**: configurable options that can switch presets,
  send a message, or open a refinement editor
- **Interactive selector**: searchable TUI list with `↑↓` navigation
- **Cycling shortcut**: `Ctrl+Shift+U` cycles through all presets + `(none)`
- **Session persistence**: active preset name is written to the session entry log
  and restored on resume (instructions only — model/tools are not re-applied on
  restore to avoid clobbering manual changes)
- **State snapshot**: original model, thinking level, and tool set are captured
  before the first preset is applied and fully restored when clearing to `(none)`

## Commands and keybindings

| Trigger              | Effect                                                          |
|----------------------|-----------------------------------------------------------------|
| `/preset`            | Open the interactive preset selector                            |
| `/preset <name>`     | Switch directly to the named preset                             |
| `Ctrl+Shift+U`       | Cycle through all presets + `(none)` in alphabetical order     |
| `--preset <name>`    | Start pi with the named preset active (CLI flag)                |

## Config files

Presets are loaded from two JSON files, merged on startup. Project-local values
override global values for the same preset name.

| File                            | Scope         |
|---------------------------------|---------------|
| `~/.pi/agent/presets.json`      | Global        |
| `<cwd>/.pi/presets.json`        | Project-local |

## Preset schema

```jsonc
{
  "my-preset": {
    // Switch to a specific provider/model when the preset is activated.
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",

    // Thinking level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
    "thinkingLevel": "high",

    // Replace the active tool set. Unknown names produce a warning.
    "tools": ["read", "bash", "grep", "find", "ls"],

    // Text injected as a hidden context message before every agent turn.
    // Stripped from context history when the preset is cleared or switched.
    "instructions": "You are in MY MODE. ...",

    // Bash allowlist: regex strings (no flags, case-sensitive).
    // When set, a command must match at least one pattern to be allowed.
    // Evaluated AFTER bashBlocklist.
    "bashAllowlist": ["^\\s*cat\\b", "^\\s*ls\\b"],

    // Bash blocklist: regex strings (compiled case-insensitively).
    // Evaluated BEFORE bashAllowlist.
    "bashBlocklist": ["\\brm\\b", "\\bsudo\\b"],

    // Actions shown after the agent finishes a turn.
    // At most one of sendMessage / promptUser should be set per action.
    "onComplete": [
      { "label": "Execute the plan", "sendMessage": "Execute the plan you just created." },
      { "label": "Stay in this mode" },
      { "label": "Refine", "promptUser": true }
    ]
  }
}
```

## Bash filtering

When a preset defines `bashAllowlist` and/or `bashBlocklist`, every bash tool
call is checked before execution:

1. If the command matches **any blocklist** pattern → **blocked**.
2. If an allowlist is set and the command matches **none** of its patterns → **blocked**.
3. Otherwise → **allowed**.

When neither list is set on a preset, bash commands run unrestricted.

Allowlist patterns are compiled without flags (case-sensitive).
Blocklist patterns are compiled case-insensitively.

## Post-agent-end action prompt

When a preset defines `onComplete`, a selection prompt appears after every agent
turn. Each action entry can:

| Field          | Effect                                                      |
|----------------|-------------------------------------------------------------|
| `label`        | Text shown in the selection UI (required)                   |
| `switchTo`     | Preset name to switch to; if absent, advances to next in cycle |
| `sendMessage`  | Auto-send this text as an agent turn (triggers a new turn)  |
| `promptUser`   | Open a text editor; send whatever the user types            |

`switchTo` is applied before the message is sent, so the new turn runs under
the new preset's settings. If `switchTo` is omitted, the extension advances to
the next preset in cycle order (same as `Ctrl+Shift+U`), clearing back to
defaults in a single-preset setup.

## Example: plan + implement presets

See [`presets.example.json`](./presets.example.json) for a ready-to-use config
that reproduces the behaviour of `pi-plan-mode` as a pair of named presets:

- **`plan`** — read-only tools, bash allowlist/blocklist matching `pi-plan-mode`,
  high thinking, `[PLAN MODE ACTIVE]` instructions, and a three-action
  onComplete prompt (Execute / Stay / Refine).
- **`implement`** — full edit/write tool set with implementation-mode instructions.

Copy `presets.example.json` to `~/.pi/agent/presets.json` (global) or
`<project>/.pi/presets.json` (project-local) to get started.

## Relationship to `pi-plan-mode`

`pi-plan-mode` is a hardcoded binary toggle with built-in bash allowlist logic.
`pi-preset` is a configurable multi-mode system. The two extensions can coexist;
`pi-preset` does not depend on or replace `pi-plan-mode`.

Key capabilities `pi-preset` adds on top of the upstream preset example:

| Feature                        | Source          |
|-------------------------------|-----------------|
| Per-preset bash allowlist/blocklist | `pi-plan-mode` |
| Configurable post-agent-end prompt  | `pi-plan-mode` |
| Stale context message stripping on switch | `pi-plan-mode` |
| Hidden context injection (`display: false`) | `pi-plan-mode` |
| Named presets from JSON config | upstream example |
| Model + thinking level switching | upstream example |
| Interactive SelectList selector | upstream example |
| `Ctrl+Shift+U` cycling | upstream example |
| Session persistence | upstream example |
