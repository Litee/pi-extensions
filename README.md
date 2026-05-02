# pi-extensions

Personal collection of extensions for Pi Agent.

## Packages

| Package | Description |
|---------|-------------|
| [`pi-ask-user-question`](packages/pi-ask-user-question) | Registers an `ask_user_question` tool so the LLM can open a tabbed TUI dialog for structured clarifying questions (single/multi-select, optional previews, free-text fallback). |
| [`pi-claude-code-skills-import`](packages/pi-claude-code-skills-import) | Imports Claude Code installed skills (user skills, plugin-cache skills, and project-local `.claude/skills`) into pi via `resources_discover`. |
| [`pi-local-issue-tracker-watcher`](packages/pi-local-issue-tracker-watcher) | Watches a `local-skill-issues-tracker` database on disk and injects issue change notifications into pi chat as `issue-watcher` custom messages. |
| [`pi-update-cmux-status`](packages/pi-update-cmux-status) | Mirrors pi lifecycle events into cmux (sidebar status pill, log lines, progress, notifications) and auto-renames the cmux tab + workspace from an LLM summary of the first user prompt. |

## Development

```bash
npm install
npm run check    # typecheck + tests
npm test         # vitest run
```
