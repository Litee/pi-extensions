# pi-improved-system-prompt

Pi extension that appends tool-usage guidelines to the system prompt on every
turn via the `before_agent_start` event.

## What it adds

```
# Tool Usage Guidelines

## Bash
## grep
## find
## Parallel tool calls
```

These guidelines steer the LLM to:

- Use built-in `find`, `grep`, `read`, `edit`, `write` tools instead of bash equivalents
- Chain bash commands with `&&` only when sequential, otherwise issue parallel tool calls
- Prefer absolute paths to avoid working-directory drift

## Install (local development)

Add the absolute path to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-extensions/packages/pi-improved-system-prompt"
  ]
}
```

Then run `/reload` in an existing pi session, or start a new one.
