# pi-claude-code-skills-import

Pi extension that imports Claude Code installed skills into pi, so the skills you already maintain for Claude Code are automatically available in pi with no extra configuration.

## What it does

On every `resources_discover` event (startup and `/reload`), the extension contributes skill paths from:

1. `$CLAUDE_CONFIG_DIR/skills` (or `~/.claude/skills` when the env var is unset)
2. Every `$CLAUDE_CONFIG_DIR/plugins/cache/<owner>/<plugin>/<version>/skills` directory from installed Claude Code plugins
3. `<cwd>/.claude/skills` — project-local Claude Code skills

Only directories that actually exist on disk are returned, so the extension is a safe no-op when Claude Code is not installed.

## Persistence

The `/cc-skills-info` toggle state is stored at:

```
~/.pi/agent/extensions-data/pi-claude-code-skills-import.json
```

This lives in a shared `extensions-data/` directory (sibling of `~/.pi/agent/extensions/`) so multiple extensions can coexist without file-name collisions. The directory is created lazily on first write. Override with `$PI_CLAUDE_SKILLS_STATE` for testing or relocation.

## Configuration

- `CLAUDE_CONFIG_DIR` — honored if set to a non-empty string, matching Claude Code's own convention. Otherwise `~/.claude` is used.

## Development

```bash
# from repo root
npm install
npx vitest run packages/pi-claude-code-skills-import
```
