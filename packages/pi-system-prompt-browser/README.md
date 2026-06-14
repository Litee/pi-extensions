# pi-system-prompt-browser

An interactive TUI for browsing and inspecting system prompt options.

## What it does

`pi-system-prompt-browser` opens a two-level menu that lets you:

1. **Menu view** — pick "C system prompt options" to see the full details of every option in the current session's system prompt.
2. **Details view** — a formatted, scrollable breakdown of each option including its name, description token count, and full content.

## Usage

Run the slash command:

```
/system-prompt-browser
```

This opens the TUI overlay. Use the following keybindings:

| Key | Action |
|-----|--------|
| ↑ / ↓ | Navigate the menu |
| Enter | Select an item (open details or close) |
| Esc | Close the overlay / go back to menu |

## Requirements

- Requires **pi 0.78.0 or later** (for the `getSystemPromptOptions()` API).
- Requires an interactive terminal (TTY with TUI support).

## See also

The `pi-agent-introspection` extension provides a tool-based approach to inspecting system prompt options. It is recommended for programmatic access; `pi-system-prompt-browser` provides the interactive browsing experience.
