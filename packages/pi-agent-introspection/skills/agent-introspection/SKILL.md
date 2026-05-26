---
name: agent-introspection
description: "Use this skill when inspecting agent session state, reading extension entries, checking token usage, listing registered slash commands, or reading the assembled system prompt. Triggers on: inspect session, session context, extension state, what commands are available, registered commands, token budget, customType entries, agent introspection, system prompt, what instructions is the agent running with, what is in the system prompt, session debug info, get session debug info, debug session."
---

# Agent Introspection

Use this skill when you need to understand what the current agent session
contains — what state other extensions have saved, how many tokens are in
use, which slash commands are registered, or what instructions the agent
is running with.

## What the extension provides

### `get_session_debug_info`

Gets debug info about the current pi agent session. Each section is individually
toggleable; combine flags to request exactly the information you need.

**Parameters (all optional):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `metadata` | boolean | `true` | Session ID, leaf ID, CWD, session file path |
| `usage` | boolean | `true` | Token usage from `ctx.getContextUsage()` |
| `entries` | boolean | `true` | Session entries grouped by `customType` (latest data per type) |
| `system_prompt` | boolean | `false` | Full assembled system prompt (can be large) |
| `filter` | string | — | Filter custom entries by `customType` prefix; only applies when `entries` is true |

Call with no arguments to see metadata + token usage + entries (the defaults):

```
get_session_debug_info()
```

See the system prompt:

```
get_session_debug_info({"metadata": false, "usage": false, "entries": false, "system_prompt": true})
```

Check only token usage:

```
get_session_debug_info({"metadata": false, "entries": false})
```

Filter entries for a specific extension:

```
get_session_debug_info({"metadata": false, "usage": false, "filter": "goal:"})
```

The output uses `## Section` headings. The `system_prompt` section includes
the character count and wraps the text in a fenced code block.

### `inspect_commands`

Lists all registered slash commands with their descriptions. Use this to
discover what commands are available in the current session.

## Activation required

Both tools are **inactive by default** at session start. Activate them
with `manage_tools` before the first call:

```
manage_tools({"action": "activate", "tools": ["get_session_debug_info"]})
manage_tools({"action": "activate", "tools": ["inspect_commands"]})
```

`manage_tools` is provided by the `pi-tools-management-tool` extension.
If the call fails with "unknown tool", that extension is not installed —
ask the user to install it and restart pi before continuing.

Both tools can be activated in the same turn if needed:

```
manage_tools({"action": "activate", "tools": ["get_session_debug_info", "inspect_commands"]})
```

## When to use each tool

### `get_session_debug_info`

- Understand what state other extensions have saved (e.g. goal extension
  state, plan mode state, watcher watches).
- Debug unexpected agent behavior — check what context the agent is
  operating from.
- Check the token budget before a long operation.
- Audit which extensions are active and what data they are persisting.
- See the full assembled system prompt to understand exactly what
  instructions the agent is running with.

### `inspect_commands`

- Discover what slash commands are registered — useful when the user asks
  "what commands do I have?" or when investigating available functionality.
- Confirm a command from a newly installed extension is registered before
  guiding the user to invoke it.

## Using the `filter` parameter

When investigating a specific extension, pass its `customType` prefix to
avoid scrolling through unrelated entries:

```
get_session_debug_info({"filter": "plan:"})
```

```
get_session_debug_info({"filter": "btw:"})
```

Omit `filter` entirely to see all entries across every extension.

## Response style

After calling either tool, summarize the key findings concisely — do not
dump raw output at the user. For `get_session_debug_info`, highlight the
active extension types, any entry counts that look unexpectedly high, the
token usage figure, and (if requested) the key instructions in the system
prompt. For `inspect_commands`, list the commands grouped logically and
note any the user is likely unaware of.
