# pi-tool-info

Pi extension that registers a `/tool-info` command so you can review every
tool available in the current pi session: name, source, active/inactive
state, description, full JSON parameter schema, and a compact token estimate.

## Usage

```
/tool-info              # pick a tool from a selector, then view details
/tool-info <name>       # jump straight to details for <name>
/tool-info --all        # render details for every tool in one view
```

Completion is enabled for `<name>` and `--all`.

From the per-tool detail view:

- `←` — go back to the selector (only when entered from it)
- `Enter` / `Esc` — close

## What you see

The list groups tools by source (`builtin`, `sdk`, `extension`, `skill`,
`unknown`) and shows, per row:

```
●  read [412 tok] — Read the contents of a file. Supports text files…
```

- `●` / `○` — active / inactive (from `pi.getActiveTools()`)
- **bold name**
- `[N tok]` — compact token estimate, dim
- `— description` — dim, word-safe truncated so the whole row stays within
  `LIST_ROW_WIDTH` (≈100 visible cells) minus whatever the name and token
  badge consume

The detail view renders the tool's description plus a fenced JSON block of
its full parameter schema. The list title and the `--all` header both show
the aggregate token footprint so you can see which tools dominate context
usage.

## Token estimate

Uses the same `chars / 4` heuristic pi itself uses internally
(`estimateTokens` in `pi-coding-agent`'s compaction module). Characters
counted: `tool.name` + `tool.description` + `JSON.stringify(tool.parameters)`
— which is what providers include in the tool manifest on every request.
Rough, conservative, and directly comparable between tools.

## Install (local development)

This package is part of the `pi-extensions` monorepo. Add the absolute path
to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-extensions/packages/pi-tool-info"
  ]
}
```

Then run `/reload` in an existing pi session, or start a new one.
