# pi-agent-introspection

A pi coding agent extension that registers the `get_session_debug_info` tool.

## What it does

`get_session_debug_info` lets the agent get debug info about the current session at any time. You
choose which sections to include via boolean flags:

- **metadata** *(default true)* — session ID, leaf ID, CWD, session file path
- **usage** *(default true)* — current token count, context window size, and percentage used
- **entries** *(default true)* — all `CustomEntry` objects grouped by `customType`, showing count and the most recent `data` payload for each type
- **system_prompt** *(default false)* — the full assembled system prompt (character count + fenced code block)

An optional **filter** parameter narrows custom entries by `customType` prefix
(only applies when `entries` is true).

## Usage

Call with no arguments to see metadata + token usage + entries:

```
get_session_debug_info()
```

Read the system prompt only:

```
get_session_debug_info({"metadata": false, "usage": false, "entries": false, "system_prompt": true})
```

Check token usage only:

```
get_session_debug_info({"metadata": false, "entries": false})
```

Filter entries by `customType` prefix:

```
get_session_debug_info({"filter": "pi-goal"})
```

If you pass all flags as `false` with no `filter`, the tool returns a short
message listing the available sections rather than silently returning empty
output.

## Installation

Add this package to your pi extensions configuration. No configuration required — the tool is available once the extension is loaded (inactive by default; activate with `manage_tools`).
