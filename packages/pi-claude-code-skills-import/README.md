# pi-claude-code-skills-import

Pi extension that imports Claude Code installed skills into pi, so the skills you already maintain for Claude Code are automatically available in pi with no extra configuration.

## What it does

On every `resources_discover` event (startup and `/reload`), the extension contributes skill paths from:

1. `$CLAUDE_CONFIG_DIR/skills` (or `~/.claude/skills` when the env var is unset)
2. Every `$CLAUDE_CONFIG_DIR/plugins/cache/<owner>/<plugin>/<version>/skills` directory from installed Claude Code plugins
3. `<cwd>/.claude/skills` — project-local Claude Code skills

Only directories that actually exist on disk are returned, so the extension is a safe no-op when Claude Code is not installed.

Skills whose real path lies under a `.agents/skills/` directory are excluded — pi core already auto-loads those via its own scan of `~/.agents/skills/` (and any project-ancestor `<dir>/.agents/skills/`), so surfacing them here would produce a duplicate entry with a different qualified name. The most common trigger is a symlink from `~/.claude/skills/<name>` into `~/.agents/skills/<name>`: the real skill stays available as `agents/<name>` via pi core; cc-skills-import silently skips its `@user/<name>` view.

## Persistence

The `/cc-skills-info` toggle state is stored at:

```
~/.pi/agent/pi-claude-code-skills-import.json
```

This lives directly under `~/.pi/agent/`, next to `settings.json` and other pi-level config. Override with `$PI_CLAUDE_SKILLS_STATE` for testing or relocation.

Entries in the `disabled` set are never auto-pruned — users can audit the file directly. If the state file references a qualified name that no longer resolves to any installed skill (uninstalled plugin, renamed version, etc.) the extension emits a one-shot `warning` toast on session start listing the stale ids, so drift is visible without the user having to inspect the file by hand (#0005). The warning is informational — the state file is not modified, and no agent turn is triggered. Edit the file by hand or run `/cc-skills-info` to re-enable / clean up.

## Configuration

- `CLAUDE_CONFIG_DIR` — honored if set to a non-empty string, matching Claude Code's own convention. Otherwise `~/.claude` is used.

## Development

```bash
# from repo root
npm install
npx vitest run packages/pi-claude-code-skills-import
```
