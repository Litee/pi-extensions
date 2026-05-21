# pi-tools

Pi extension that registers a `/tools` command for reviewing — and toggling
— every tool available in the current pi session: name, source,
active/inactive state, description, full JSON parameter schema, and a
compact token estimate.

Toggles are applied immediately via `pi.setActiveTools(...)` and persisted
to the session, so your enabled-set survives `/reload`, session resume, and
branch navigation.

## Usage

```
/tools              # interactive selector, grouped by source
/tools <name>       # jump straight to details for <name>
/tools --all        # render details for every tool in one read-only view
```

Argument completion is enabled for `<name>` and `--all`.

### Keys

In the selector list:

- `t` — toggle the focused tool on/off (in place, no view change)
- `Enter` — open the detail view for the focused tool
- `Esc` — close

In the per-tool detail view:

- `t` — toggle this tool on/off (the rendered Markdown updates in place)
- `←` — back to the selector (only when entered from it)
- `Enter` / `Esc` — close

The `--all` view is read-only — no `t` toggle there.

The selector also ends with an `── actions ──` group containing a
`» show all tools in one view` row, equivalent to running `/tools --all`
but reachable interactively (with `←` back-navigation to the selector).

## What you see

Tools are grouped by source (`builtin`, `sdk`, `extension`, `skill`,
`unknown`) and sorted by name within each group. Each row looks like:

```
●  read [412 tok] — Read the contents of a file. Supports text files…
```

- `●` / `○` — active / inactive (mirrors `pi.getActiveTools()`, updated
  live as you press `t`)
- **bold name**
- `[N tok]` — compact token estimate, dim
- `— description` — dim, word-safe truncated so the row fits within
  ~100 visible cells minus the name and token badge

The selector title shows the active and total token cost:

```
Tools (12 total · 5 active · ~1.2k active tokens, 3.4k total)
```

When every tool is enabled, the title collapses to a single
`~3.4k tokens` figure.

The detail view renders the tool's description plus a fenced JSON block of
its full parameter schema.

## Token estimate

Uses the same `chars / 4` heuristic pi itself uses internally
(`estimateTokens` in pi-coding-agent's compaction module). Characters
counted: `tool.name` + `tool.description` + `JSON.stringify(tool.parameters)`
— exactly what providers include in the tool manifest on every request.
Rough, conservative, and directly comparable between tools.

## Persistence

Toggling writes a `ToolsState` entry (`{ enabledTools: string[] }`) to the
session via `pi.appendEntry`. On `session_start` and `session_tree`, the
extension reads back the most recent entry, intersects it with the
currently-registered tools (so stale names from removed extensions are
dropped), and calls `pi.setActiveTools(...)`. If no saved state exists, the
current `pi.getActiveTools()` set is used as the starting point.

## Install (local development)

This package is part of the `pi-extensions` monorepo. Add the absolute path
to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-extensions/packages/pi-tools"
  ]
}
```

Then run `/reload` in an existing pi session, or start a new one.
