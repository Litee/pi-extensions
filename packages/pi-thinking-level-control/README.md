# pi-thinking-level-control

Separate `ctrl+]` / `ctrl+[` shortcuts for stepping the agent's thinking level up or down one rung.

| Shortcut | Effect |
|----------|--------|
| `ctrl+]` | Increase thinking level (no-op at `high`) |
| `ctrl+[` | Decrease thinking level (no-op at `off`) |

Level ladder: dynamically derived from the active model's supported thinking levels. Models that support `xhigh` (e.g. Opus) step all the way up to `xhigh`; others stop at `high`.

> **Note:** pi core's `app.thinking.cycle` also defaults to `ctrl+]` and `ctrl+[`.
> Remove those from `~/.pi/agent/keybindings.json` so they don't conflict:
> ```json
> { "app.thinking.cycle": "shift+tab" }
> ```
