# pi-claude-code-commands-import

Pi extension that imports Claude Code slash commands into pi as prompt templates, so the commands you already maintain for Claude Code are automatically available in pi with no extra configuration.

## What it does

On every `resources_discover` event (startup and `/reload`), the extension contributes prompt-template paths from:

1. `$CLAUDE_CONFIG_DIR/commands` (or `~/.claude/commands` when the env var is unset)
2. `<cwd>/.claude/commands` — project-local Claude Code commands

Each `.md` file found directly in those directories becomes a pi slash command named after its filename (without the `.md` extension). For example, `~/.claude/commands/review-pr.md` becomes `/review-pr` in pi.

Only directories that actually exist on disk are returned, so the extension is a safe no-op when Claude Code is not installed or no commands have been authored yet.

## Limitations

Pi's prompt-template discovery is **non-recursive**. Only `.md` files placed *directly* inside a `commands/` directory are imported. Files nested in subdirectories (e.g. `commands/git/commit.md` → `/git:commit` in Claude Code) are not imported. Use the top-level `commands/` directory for commands you want available in both tools.

## Configuration

- `CLAUDE_CONFIG_DIR` — honored if set to a non-empty string, matching Claude Code's own convention. Otherwise `~/.claude` is used.

## Development

```bash
# from repo root
npm install
npx vitest run packages/pi-claude-code-commands-import
```
